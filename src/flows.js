// Sequences ("flows"): one at a time per person, stored in D1 so they survive between webhook calls.
// Every sequence starts with a Cancel-button message; when it ends or is cancelled, the bot messages of that
// sequence are removed (the final result message and files stay).
import { btn, kb, noKb, cancelBtn, homeBtn, showHome, esc, FORMAT_HELP, BUSY, lockedAlert, webBtn } from "./ui.js";
import { Question, parseQuestions, formatQuestions, questionFromPoll, parseDuration } from "./qparser.js";
import { mediaFromMessage } from "./tg.js";
import {
  DEFAULT_SETTINGS, MAX_DESC_LEN, MAX_NAME_LEN, MAX_QUESTIONS, TIME_CHOICES, normSettings, plural, formatLimit, timeSummary, fmtMarks,
  reviewDefault, reviewOn, slug,
} from "./engine.js";

export const hooks = {};   // other modules register what to do when a settings panel is finished (e.g. channel clone)

// ---------------------------------------------------------------- helpers
export const runStub = (env, key) => env.RUN.get(env.RUN.idFromName(key));
export async function runStatus(env, key) { try { return await runStub(env, key).status(); } catch { return { active: false }; } }

export async function busyText(c, uid) {
  const st = await runStatus(c.env, "u:" + uid);
  if (st.active) return st.suspended ? BUSY.paused : BUSY.quiz;
  return (await c.db.getFlow(uid)) ? BUSY.flow : null;
}

const qToFlow = (q) => ({ ...q.toData(), ...(q.needsMedia ? { nm: 1 } : {}) });
const qFromFlow = (d) => { const q = Question.fromData(d); q.needsMedia = !!d.nm; return q; };
const flowQs = (flow) => flow.data.questions.map(qFromFlow);

export async function startFlow(c, uid, kind, data, text, extraRows = []) {
  const flow = { userId: uid, kind, data: { ...data }, msgs: [] };
  const msg = await c.send(uid, text, { html: true, kb: kb([cancelBtn], ...extraRows) });
  flow.msgs.push(msg.message_id); flow.data.first = msg.message_id;
  await c.db.saveFlow(flow);
  return flow;
}
const save = (c, flow) => c.db.saveFlow(flow);

async function removeReplyKeyboard(c, uid) {
  try { const m = await c.send(uid, "✅", { extra: { reply_markup: { remove_keyboard: true } } }); await c.tg.deleteMessage(uid, m.message_id); } catch { /* ignore */ }
}

/** Remove the bot messages of a sequence (optionally keeping some) and forget the sequence. */
export async function endFlow(c, flow, keep = []) {
  await c.tg.deleteMessages(flow.userId, flow.msgs.filter((i) => !keep.includes(i)));
  if (flow.data.rk) await removeReplyKeyboard(c, flow.userId);
  await c.db.delFlow(flow.userId);
}

export async function cancelFlow(c, uid, query = null, notice = true) {
  const flow = await c.db.getFlow(uid);
  if (!flow) { if (query) await c.tg.answerCallback(query.id, "Nothing to cancel."); return false; }
  await endFlow(c, flow);
  if (query) await c.tg.answerCallback(query.id);
  if (notice) await showHome(c, uid);
  return true;
}

async function say(c, flow, text, o = {}) { return c.send(flow.userId, text, { ...o, flow }); }
async function dropMsg(c, flow, id) { if (!id) return; flow.msgs = flow.msgs.filter((i) => i !== id); await c.tg.deleteMessage(flow.userId, id); }

// ------------------------------------------------------------ entering
export async function beginCreate(c, uid, mode) {   // mode: full | bulk | quick
  const blocked = await busyText(c, uid);
  if (blocked) return c.send(uid, blocked);
  const lim = await c.limits(uid);
  if ((await c.db.countQuizzes(uid)) >= lim.quizzes) return c.send(uid, `You already have ${lim.quizzes} quizzes, which is the limit for your account.${lim.paid ? "" : " ✨ Premium raises it."}`);
  const base = { mode, stage: "name", name: null, desc: "", perQ: false, questions: [], settings: normSettings({}), prem: lim.exam };
  if (mode === "quick") {
    const flow = await startFlow(c, uid, "create", { ...base, stage: "questions", name: `Quick quiz ${new Date().toISOString().slice(0, 10)}` },
      "⚡ <b>Quick quiz</b>\n\nSend the questions (text or a .txt file). When you send /quesdone, the quiz is created at once with your default settings.");
    return askQuestions(c, flow, false);
  }
  const title = mode === "bulk" ? "📋 <b>Bulk quiz</b>" : "📝 <b>New quiz</b>";
  return startFlow(c, uid, "create", base, `${title}\n\nWhat should it be called? Send the name as a text message.`);
}

export async function beginDefault(c, uid) {
  const blocked = await busyText(c, uid);
  if (blocked) return c.send(uid, blocked);
  const lim = await c.limits(uid), preset = (await c.db.getPreset(uid)) || normSettings({});
  const flow = await startFlow(c, uid, "preset", { stage: "settings", settings: preset, prem: lim.exam }, "★ <b>Default settings</b>\n\nThese are applied when you tap “Apply default” while creating a quiz.");
  return showPanel(c, flow);
}

async function startEdit(c, uid, quizId, kind, text, extra = {}) {
  const blocked = await busyText(c, uid);
  if (blocked) { await c.send(uid, blocked); return null; }
  const head = await c.db.quizHead(quizId);
  if (!head || head.owner_id !== uid) { await c.send(uid, "I couldn't find that quiz among yours."); return null; }
  return { head, flow: await startFlow(c, uid, kind, { quizId, ...extra }, text.replace("{name}", esc(head.name))) };
}

export async function beginReplace(c, uid, quizId) {
  const r = await startEdit(c, uid, quizId, "replace", "🔄 <b>Replace the quiz</b> “{name}”.\n\nSend the new name for the quiz, or /keep to keep the current one.", { stage: "name", questions: [], perQ: false });
  if (!r) return;
  const qs = await c.db.getQuestions(r.head.qid);
  await c.tg.sendDocument(uid, `${slug(r.head.name)}.txt`, formatQuestions(qs, { withMedia: true }),
    "Your quiz in the input format. Edit it, then send it back (as a file or pasted). Lines starting with ++<<…>> keep their picture or video.");
}
export async function beginAdd(c, uid, quizId) {
  const r = await startEdit(c, uid, quizId, "addq", "➕ <b>Add questions</b> to “{name}”.", { stage: "questions", questions: [], perQ: false });
  if (r) await askQuestions(c, r.flow, true);
}
export async function beginText(c, uid, quizId, kind) {
  const prompts = {
    qdesc: "📝 <b>Description</b> of “{name}”.\n\nSend the new description (up to " + MAX_DESC_LEN + " characters), or send - to remove it.",
    qname: "✏️ <b>Rename</b> “{name}”.\n\nSend the new name.",
  };
  await startEdit(c, uid, quizId, kind, prompts[kind]);
}
export async function beginQuizSettings(c, uid, quizId) {
  const r = await startEdit(c, uid, quizId, "qset", "⚙️ <b>Settings</b> of “{name}”.", { stage: "settings", prem: (await c.limits(uid)).exam });
  if (!r) return;
  r.flow.data.settings = r.head.settings;
  await showPanel(c, r.flow);
}
export async function beginSingleReplace(c, uid, quizId, rowId, intro) {
  const blocked = await busyText(c, uid);
  if (blocked) { await c.send(uid, blocked); return false; }
  const head = await c.db.quizHead(quizId);
  if (!head || head.owner_id !== uid) return false;
  const old = await c.db.getQuestion(head.qid, rowId);
  if (!old) return false;
  const flow = await startFlow(c, uid, "qrep", { quizId, rowId },
    `${intro || "✏️ <b>Replace one question</b>"}\n\nSend the replacement as text (same format as below) or tap the poll button to send it as a quiz poll.\n\n<pre>${esc(formatQuestions([old]))}</pre>`);
  flow.data.rk = true;
  await say(c, flow, "📊 Tap the button to send the replacement as a quiz poll.", { extra: { reply_markup: { keyboard: [[{ text: "📊 Send a quiz poll", request_poll: { type: "quiz" } }]], resize_keyboard: true } } });
  await save(c, flow);
  return true;
}

// ---------------------------------------------------- the questions step
function questionsPrompt(flow, full) {
  const d = flow.data;
  const head = flow.kind === "replace" ? `🔄 Replacing “${esc(d.name)}”. Send the complete, updated list of questions – it replaces the current ones.`
    : flow.kind === "addq" ? "Send the questions to add."
    : `👍 Quiz name: “${esc(d.name)}”.\n\nNow send your questions.`;
  return `${head}\n\n<pre>${esc(FORMAT_HELP)}</pre>When you're done, tap Done or send /quesdone.`;
}

async function askQuestions(c, flow, full = true) {
  const d = flow.data;
  d.stage = "questions";
  const showTimeToggle = full && d.mode !== "bulk" && flow.kind !== "replace" || flow.kind === "addq";
  const rows = [];
  if (showTimeToggle) rows.push([btn(`⏱ Ask time for every question: ${d.perQ ? "✅ on" : "⬜ off"}`, "cr:vt")]);
  rows.push([btn("✅ Done adding", "cr:done")]);
  const m = await say(c, flow, questionsPrompt(flow, full), { html: true, kb: kb(...rows) });
  d.promptId = m.message_id;
  if (full && d.mode !== "bulk" && d.mode !== "quick") {
    d.rk = true;
    await say(c, flow, "📊 Or tap the button below to add one quiz poll at a time.", { extra: { reply_markup: { keyboard: [[{ text: "📊 Add a quiz poll", request_poll: { type: "quiz" } }], [{ text: "/quesdone" }]], resize_keyboard: true } } });
  }
  await save(c, flow);
}

function formatBatchReport(rep, veryLong) {
  const parts = [];
  if (rep.foundNothing) parts.push("I couldn't find any questions in that message. Every question starts with +, followed by at least 2 options (put * in front of the correct one or ones).");
  else parts.push(`✅ Added ${plural(rep.added, "question")} (${rep.total} in total).`);
  if (rep.overflow) parts.push(`⚠️ ${plural(rep.overflow, "question")} ignored: a quiz can have at most ${MAX_QUESTIONS}.`);
  if (rep.errors.length) {
    const lines = [`⚠️ ${plural(rep.errors.length, "block")} skipped:`];
    for (const e of rep.errors.slice(0, 10)) lines.push(`• ${e.blockNo ? `#${e.blockNo} ` : ""}“${e.preview}”: ${e.reason}`);
    if (rep.errors.length > 10) lines.push(`…and ${rep.errors.length - 10} more.`);
    lines.push("Fix them and send them again if you want them included.");
    parts.push(lines.join("\n"));
  }
  if (rep.warnings.length) parts.push(rep.warnings.slice(0, 5).map((w) => `ℹ️ ${w.blockNo ? `#${w.blockNo} ` : ""}“${w.preview}” ${w.reason}`).join("\n"));
  if (rep.needMedia) parts.push(`🖼 ${plural(rep.needMedia, "question")} marked with ++ will need a picture/video/audio – I'll ask for them after /quesdone.`);
  if (veryLong) parts.push("ℹ️ That message was very long. Telegram can split long pastes into several messages, sometimes in the middle of a question. If you see errors at the start or end of a message, upload your questions as a .txt file instead.");
  parts.push("Send the next batch, or tap Done / send /quesdone. To abort, press Cancel.");
  return parts.join("\n\n");
}

async function report(c, flow, text) {
  const d = flow.data;
  if (d.reportId) await dropMsg(c, flow, d.reportId);
  const m = await say(c, flow, text);
  d.reportId = m.message_id;
}

async function addBatch(c, flow, text, veryLong = false) {
  const d = flow.data, res = parseQuestions(text);
  const room = Math.max(0, MAX_QUESTIONS - d.questions.length);
  const accepted = res.questions.slice(0, room);
  accepted.forEach((q) => d.questions.push(qToFlow(q)));
  await report(c, flow, formatBatchReport({
    added: accepted.length, total: d.questions.length, errors: res.errors, warnings: res.warnings, overflow: res.questions.length - accepted.length,
    foundNothing: !res.questions.length && !res.errors.length, needMedia: accepted.filter((q) => q.needsMedia).length,
  }, veryLong));
  await save(c, flow);
}

const TIME_ROW = [...TIME_CHOICES.map((t) => btn(`${t}s`, `cr:qt:${t}`)), btn("♾", "cr:qt:u"), btn("Default", "cr:qt:d")];

async function addPoll(c, flow, poll) {
  const d = flow.data, { q, error } = questionFromPoll(poll);
  if (error) return report(c, flow, `⚠️ ${error}`);
  if (d.questions.length >= MAX_QUESTIONS) return report(c, flow, `⚠️ A quiz can have at most ${MAX_QUESTIONS} questions.`);
  d.questions.push(qToFlow(q));
  if (d.perQ) {
    d.stage = "qtime"; d.qtimeIdx = d.questions.length - 1;
    if (d.timePromptId) await dropMsg(c, flow, d.timePromptId);
    const m = await say(c, flow, `⏱ How much time for this question?\n“${q.text.slice(0, 60)}”\n\nTap a button, or type a time such as 45 or 1-30 (1 min 30 s).`, { kb: kb(TIME_ROW) });
    d.timePromptId = m.message_id;
    await save(c, flow);
  } else { await report(c, flow, `✅ Poll added (${d.questions.length} in total). Send more, or tap Done / send /quesdone.`); await save(c, flow); }
}

async function setPollTime(c, flow, value) {
  const d = flow.data, entry = d.questions[d.qtimeIdx];
  if (entry) { if (value === null) delete entry.t; else entry.t = value; }
  d.stage = "questions";
  await dropMsg(c, flow, d.timePromptId); d.timePromptId = null;
  await report(c, flow, `✅ Poll added${value === null ? "" : ` with ${formatLimit(value)}`} (${d.questions.length} in total). Send more, or tap Done / send /quesdone.`);
  await save(c, flow);
}

export async function questionsDone(c, flow) {
  const d = flow.data;
  if (!["questions", "qtime"].includes(d.stage)) return c.send(flow.userId, "There's nothing to finish right now.");
  if (!d.questions.length) return c.send(flow.userId, "I don't have any valid questions yet. Send some, or press Cancel.");
  if (d.stage === "qtime") await setPollTime(c, flow, null);
  const pending = d.questions.map((q, i) => (q.nm ? i : -1)).filter((i) => i >= 0);
  if (pending.length) {
    d.stage = "media"; d.media = { queue: pending, i: 0 };
    const list = pending.map((i) => `#${i + 1} “${d.questions[i].q.slice(0, 40)}”`).join("\n");
    await say(c, flow, `🖼 These questions need a picture, video, audio or file as their stem:\n\n${list}\n\nI'll ask for them one by one, in this order.`);
    return askMedia(c, flow);
  }
  return afterQuestions(c, flow);
}

async function askMedia(c, flow) {
  const d = flow.data, { queue, i } = d.media;
  if (i >= queue.length) { await dropMsg(c, flow, d.mediaPromptId); return afterQuestions(c, flow); }
  if (d.mediaPromptId) await dropMsg(c, flow, d.mediaPromptId);
  const idx = queue[i];
  const m = await say(c, flow, `🖼 (${i + 1}/${queue.length}) Send the stem for #${idx + 1}:\n“${d.questions[idx].q.slice(0, 100)}”\n\nA photo, video, audio, voice message, GIF or file – or plain text to use as its description.`, { kb: kb([btn("⏭ Leave it out", "cr:ms")]) });
  d.mediaPromptId = m.message_id;
  await save(c, flow);
}

async function takeMedia(c, flow, msg, skip = false) {
  const d = flow.data, idx = d.media.queue[d.media.i], entry = d.questions[idx];
  if (!skip) {
    const media = mediaFromMessage(msg);
    if (media) entry.m = media;
    else if (msg.text) entry.d = msg.text.trim().slice(0, 900);
    else return c.send(flow.userId, "I can't use that kind of message as a stem. Send a photo, video, audio, voice message, GIF, file or text.");
  }
  delete entry.nm;
  d.media.i++;
  await askMedia(c, flow);
}

// ---------------------------------------------------- after the questions
async function trimTimes(c, flow, qs) {
  const lim = await c.limits(flow.userId);
  let used = 0, trimmed = 0;
  for (const q of qs) if (q.time !== null && q.time !== undefined) { if (++used > lim.timedQuestions) { q.time = null; trimmed++; } }
  return trimmed ? `ℹ️ Your account can give a custom time to ${lim.timedQuestions} questions per quiz; ${plural(trimmed, "question")} now use the quiz timer. ✨ Premium removes this limit.` : null;
}

async function afterQuestions(c, flow) {
  const d = flow.data;
  if (flow.kind === "replace") return doReplace(c, flow);
  if (flow.kind === "addq") return doAppend(c, flow);
  if (d.mode === "quick") return createNow(c, flow, (await c.db.getPreset(flow.userId)) || normSettings({}));
  if (d.mode === "bulk") {
    d.stage = "bulktime";
    await say(c, flow, `⏱ How much time should each of the ${d.questions.length} questions get?`, { kb: kb(TIME_CHOICES.map((t) => btn(`${t} sec`, `cr:bt:${t}`)), [btn("♾ Untimed", "cr:bt:0")]) });
    return save(c, flow);
  }
  d.stage = "settings";
  await save(c, flow);
  return showPanel(c, flow);
}

async function doReplace(c, flow) {
  const d = flow.data, qs = flowQs(flow);
  const note = await trimTimes(c, flow, qs);
  qs.forEach((q) => { q.needsMedia = false; });
  const ok = await c.db.replaceQuiz(d.quizId, flow.userId, { name: d.name, questions: qs });
  await endFlow(c, flow);
  if (!ok) return c.send(flow.userId, "That quiz no longer exists.");
  return c.send(flow.userId, `✅ Quiz updated!\n\n<b>${esc(d.name)}</b>\nQuestions: ${qs.length}\n\nLink: ${esc(c.link(d.quizId))}` + (note ? `\n\n${note}` : ""), { html: true });
}

async function doAppend(c, flow) {
  const d = flow.data, head = await c.db.quizHead(d.quizId);
  const qs = flowQs(flow);
  if (!head || head.owner_id !== flow.userId) { await endFlow(c, flow); return c.send(flow.userId, "That quiz no longer exists."); }
  const room = Math.max(0, MAX_QUESTIONS - head.n_questions);
  const note = await trimTimes(c, flow, qs);
  const add = qs.slice(0, room).map((q) => { q.needsMedia = false; return q; });
  await c.db.addQuestions(head.qid, add);
  await endFlow(c, flow);
  return c.send(flow.userId, `✅ Added ${plural(add.length, "question")} to “${esc(head.name)}” (${head.n_questions + add.length} in total).` + (add.length < qs.length ? `\n⚠️ ${qs.length - add.length} left out: the limit is ${MAX_QUESTIONS}.` : "") + (note ? `\n\n${note}` : ""), { html: true });
}

// ------------------------------------------------------ the quiz is made
export function folderButton(db, folder, quizId) {
  return btn(folder ? `📂 In: ${folder.name.slice(0, 30)} (change)` : "⇨ 📂 Add to folder", `afl:${quizId}`);
}

function stripHtml(c, quizId, n) {
  const glyphs = [];
  for (let k = 1; k <= Math.min(n, 40); k++) glyphs.push(`<a href="${c.appLink(quizId, k)}">${k === 1 ? "○" : "-"}</a>`);
  return glyphs.join("") + (n > 40 ? " …" : "");
}

async function createNow(c, flow, settings) {
  const d = flow.data, uid = flow.userId, qs = flowQs(flow);
  const lim = await c.limits(uid);
  if ((await c.db.countQuizzes(uid)) >= lim.quizzes) { await endFlow(c, flow); return c.send(uid, `You already have ${lim.quizzes} quizzes, which is the limit.`); }
  const note = await trimTimes(c, flow, qs);
  qs.forEach((q) => { q.needsMedia = false; });
  const s = normSettings(settings);
  if (d.timeOverride !== undefined) s.time = d.timeOverride;
  const quizId = await c.db.createQuiz({ owner: uid, name: d.name, description: d.desc || "", settings: s, questions: qs });
  let cloneId = null;
  if (d.cloneRetake) cloneId = await c.db.cloneQuiz(quizId, uid, { name: `${d.name} (no retake)`, settings: { ...s, retake: "off" } });

  // the Cancel-button message turns into the question strip (each dash opens the mini app at that question); the rest goes
  const keep = [d.first];
  if (c.env.MINIAPP_SHORTNAME) {
    await c.tg.editMessageText(uid, d.first, `🗺 <b>${esc(d.name)}</b>\n${stripHtml(c, quizId, qs.length)}\nTap a dash to edit or delete that question.`, { parse_mode: "HTML", reply_markup: noKb }).catch(() => {});
  } else keep.length = 0;
  await endFlow(c, flow, keep);
  const text = `✅ Quiz created!\n\n<b>${esc(d.name)}</b>\n${d.desc ? esc(d.desc) + "\n" : ""}Questions: ${qs.length}\nTime per question: ${esc(timeSummary(qs, s.time))}\n\nParticipation link:\n${esc(c.link(quizId))}` +
    (cloneId ? `\n\nLink with retake disabled:\n${esc(c.link(cloneId))}` : "") + (note ? `\n\n${note}` : "");
  return c.send(uid, text, { html: true, kb: kb([folderButton(c.db, null, quizId)], [btn("⚙️ Edit this quiz", `eq:${quizId}`)]) });
}

// -------------------------------------------------------- settings panel
const mk = (label, cur, isDefault) => `${cur ? "✓ " : ""}${label}${isDefault ? " ★" : ""}`;
const onOff = (v) => (v ? "on" : "off");
const SHUFFLE_LABEL = { none: "none", questions: "questions only", options: "options only", both: "questions & options" };
const TR_LABEL = { locked: "🔒 locked", unlocked: "🔓 unlocked", open: "🌐 open" };
const D = DEFAULT_SETTINGS;

function passLabel(p) { return p.on ? (p.type === "percent" ? `${fmtMarks(p.value)}%` : `${fmtMarks(p.value)} marks`) : "off"; }

function panelText(flow) {
  const s = normSettings(flow.data.settings), d = flow.data;
  const own = (d.questions || []).filter((q) => q.t !== undefined).length;
  const lines = [
    "⚙️ <b>Quiz settings</b>",
    `⏱ Timer: ${formatLimit(s.time)}${own ? ` (${plural(own, "question")} with their own time)` : ""}`,
    `➖ Negative marking: ${s.neg ? "−" + fmtMarks(s.neg) + " per wrong answer" : "off"}`,
    `🎯 Pass mark: ${passLabel(s.pass)}`,
    `🔀 Shuffle: ${SHUFFLE_LABEL[s.shuffle]}`,
    `🔁 Retake: ${s.retake === "on" ? "enabled" : "disabled"}${d.cloneRetake ? " + a second link with retake disabled" : ""}`,
    `🔍 Transparency: ${TR_LABEL[s.tr.mode]}`,
    `📝 Review: ${reviewOn(s) ? "on" + (s.review.sort ? " + sort in topics" : "") : "off" + (s.review.toCreator ? " (results go to you)" : "")}`,
    `☑️ Single-answer questions lock to one choice: ${onOff(s.singleLock)}`,
  ];
  if (flow.kind === "create" && d.perQ) lines.push("", "ℹ️ Questions without their own time use the timer above.");
  return lines.join("\n");
}

function panelKb(flow) {
  const s = normSettings(flow.data.settings);
  const rows = [];
  if (flow.kind === "create") rows.push([btn("⚡ Apply my default & create", "st:def")]);
  rows.push([btn("⏱ Timer", "st:t"), btn("➖ Marking", "st:ng")], [btn("🎯 Pass mark", "st:pm"), btn("🔀 Shuffle", "st:sh")],
    [btn("🔁 Retake", "st:rt"), btn("🔍 Transparency", "st:tr")], [btn("📝 Review", "st:rv"), btn(`☑️ Single lock: ${onOff(s.singleLock)}`, "st:sg")]);
  const label = { create: "✅ Create quiz", preset: "✅ Save as my default", qset: "✅ Save settings", chclone: "▶️ Create the channel copy & start" }[flow.kind] || "✅ Done";
  rows.push([btn(label, "st:go")]);
  return kb(...rows);
}

export async function showPanel(c, flow, query = null) {
  const d = flow.data;
  const m = await c.show(flow.userId, panelText(flow), panelKb(flow), query, true);
  if (!query) flow.msgs.push(m.message_id);
  d.panelId = m.message_id; d.input = null;
  await save(c, flow);
}

function subMenu(section, flow) {
  const s = normSettings(flow.data.settings), back = [btn("⬅️ Back", "st:back")];
  const row = (...items) => items;
  if (section === "t") {
    const custom = s.time > 0 && !TIME_CHOICES.includes(s.time);
    return { text: "⏱ <b>Timer</b> – seconds per question (a question with its own :time keeps it). ★ = default.",
      rows: [TIME_CHOICES.map((t) => btn(mk(`${t}s`, s.time === t, t === D.time), `st:t:${t}`)),
        [btn(mk(`✍️ Custom${custom ? ` (${formatLimit(s.time)})` : ""}`, custom, false), "st:t:c"), btn(mk("♾ Untimed", s.time === 0, false), "st:t:u")], back] };
  }
  if (section === "ng") {
    const vals = [[0, "Off"], [0.25, "¼"], [0.33, "⅓"], [0.5, "½"], [1, "1"]];
    const custom = !vals.some(([v]) => v === s.neg);
    return { text: "➖ <b>Negative marking</b> – marks lost for each WRONG answer (skipped ones cost nothing).",
      rows: [vals.map(([v, l]) => btn(mk(l, s.neg === v, v === 0), `st:ng:${v}`)), [btn(mk(`✍️ Custom${custom ? ` (${fmtMarks(s.neg)})` : ""}`, custom, false), "st:ng:c")], back] };
  }
  if (section === "pm") return { text: "🎯 <b>Pass mark</b> – shows ✅ Passed / ❌ Not passed in the result.",
    rows: [[btn(mk("Off", !s.pass.on, true), "st:pm:off"), btn(mk("% of total" + (s.pass.on && s.pass.type === "percent" ? ` (${fmtMarks(s.pass.value)}%)` : ""), s.pass.on && s.pass.type === "percent", false), "st:pm:pct"),
      btn(mk("Marks" + (s.pass.on && s.pass.type === "marks" ? ` (${fmtMarks(s.pass.value)})` : ""), s.pass.on && s.pass.type === "marks", false), "st:pm:marks")], back] };
  if (section === "sh") return { text: "🔀 <b>Shuffling</b>",
    rows: [["none", "questions", "options", "both"].map((v) => btn(mk(SHUFFLE_LABEL[v].replace(" & ", "+"), s.shuffle === v, v === D.shuffle), `st:sh:${v}`)), back] };
  if (section === "rt") return { text: "🔁 <b>Retake</b>\n• Enabled – people can take it again.\n• Disabled – one attempt per person (you can always test).\n• Clone – you get TWO links: this one and a second one with retake disabled.",
    rows: [[btn(mk("Enabled", s.retake === "on", true), "st:rt:on"), btn(mk("Disabled", s.retake === "off", false), "st:rt:off"), btn(mk("🧬 Clone", !!flow.data.cloneRetake, false), "st:rt:clone")], back] };
  if (section === "tr") {
    const t = s.tr, rows = [[["locked", "🔒 Locked"], ["unlocked", "🔓 Unlocked"], ["open", "🌐 Open"]].map(([v, l]) => btn(mk(l, t.mode === v, v === D.tr.mode), `st:tr:${v}`))];
    let text = "🔍 <b>Transparency</b>\n";
    if (t.mode === "locked") {
      text += "🔒 Answers can't be changed.";
      rows.push([btn(mk(`Remove question after it is answered: ${onOff(t.removeAfterAnswer)}`, false, t.removeAfterAnswer === D.tr.removeAfterAnswer), "st:trk:removeAfterAnswer")],
        [btn(mk(`Hide the right answer until the end: ${onOff(t.hideAnswer)}`, false, t.hideAnswer === D.tr.hideAnswer), "st:trk:hideAnswer")]);
    } else if (t.mode === "unlocked") text += "🔓 The question disappears when the quiz is finished and the right answer is shown right away (how the bot always worked).";
    else {
      text += "🌐 The questions are NOT removed when the quiz finishes.";
      rows.push([btn(mk(`Re-send the polls after the quiz so anyone can vote: ${onOff(t.reopen)}`, false, t.reopen === D.tr.reopen), "st:trk:reopen")],
        [btn(mk(`Allow taking a vote back: ${onOff(t.retract)}`, false, t.retract === D.tr.retract), "st:trk:retract")]);
    }
    return { text: text + "\n★ marks the default of each switch.", rows: [...rows, back] };
  }
  if (section === "rv") {
    const on = reviewOn(s), rows = [[btn(mk("Review on", on === true, reviewDefault(s)), "st:rv:on"), btn(mk("Review off", on === false, !reviewDefault(s)), "st:rv:off")]];
    let text = "📝 <b>Review</b> – the questions a person got wrong or skipped.\n(Default is on, or off when answers are hidden until the end.)";
    if (on) rows.push([btn(mk(`Sort in topics (Gemini): ${onOff(s.review.sort)}`, false, s.review.sort === D.review.sort), "st:rvk:sort")]), text += "\n\n🔃 “Sort in topics” adds a button that sends the wrong/skipped questions to Google Gemini to group them by topic. The text of those questions may be used by Google to train its models – quiz takers are told this.";
    else {
      text += "\n\nExam style: the taker doesn't get the review.";
      rows.push([btn(mk(`Ask name and ID before the quiz: ${onOff(s.review.askName)}`, false, s.review.askName === D.review.askName), "st:rvk:askName")],
        [btn(`${flow.data.prem ? "" : "🔒 "}${mk(`Send result & review to me instead: ${onOff(s.review.toCreator)}`, false, s.review.toCreator === D.review.toCreator)}`, "st:rvk:toCreator")]);
    }
    return { text, rows: [...rows, back] };
  }
  return null;
}

async function askInput(c, flow, query, what, prompt) {
  flow.data.input = what;
  const m = await say(c, flow, prompt, { kb: kb([btn("⬅️ Back", "st:inputcancel")]) });
  flow.data.inputMsg = m.message_id;
  await save(c, flow);
  await c.tg.answerCallback(query.id);
}

export async function settingsCallback(c, flow, query) {
  const parts = query.data.split(":"), a = parts[1], v = parts[2], uid = flow.userId, d = flow.data;
  const s = normSettings(d.settings);
  const redraw = async (section) => {
    d.settings = s;
    const sub = section && subMenu(section, flow);
    await save(c, flow);
    await c.tg.answerCallback(query.id);
    if (sub) return c.show(uid, sub.text, kb(...sub.rows), query, true);
    return showPanel(c, flow, query);
  };
  if (a === "back") return redraw(null);
  if (a === "inputcancel") { if (d.inputMsg) await dropMsg(c, flow, d.inputMsg); d.input = null; d.inputMsg = null; await save(c, flow); return c.tg.answerCallback(query.id); }
  if (a === "sg") { s.singleLock = !s.singleLock; return redraw(null); }
  if (a === "go") return settingsDone(c, flow, query, false);
  if (a === "def") return settingsDone(c, flow, query, true);
  if (v === undefined && subMenu(a, flow)) return redraw(a);

  if (a === "t") {
    if (v === "c") return askInput(c, flow, query, "timer", "✍️ Send the time per question: seconds (45), or d-h-m-s from the right: 1-30 = 1 min 30 s, 1-0-0 = 1 hour, 2-0-0-0 = 2 days. Max 7 days.");
    s.time = v === "u" ? 0 : Number(v); return redraw("t");
  }
  if (a === "ng") {
    if (v === "c") return askInput(c, flow, query, "neg", "✍️ Send the marks to take off for each wrong answer, for example 0.25");
    s.neg = Number(v); return redraw("ng");
  }
  if (a === "pm") {
    if (v === "off") { s.pass.on = false; return redraw("pm"); }
    return askInput(c, flow, query, v === "pct" ? "passpct" : "passmarks", v === "pct" ? "✍️ Send the pass mark as a percentage of the total, for example 60" : "✍️ Send the pass mark in marks, for example 7.5");
  }
  if (a === "sh") { s.shuffle = v; return redraw("sh"); }
  if (a === "rt") {
    if (v === "clone") d.cloneRetake = !d.cloneRetake; else { s.retake = v; if (v === "off") d.cloneRetake = false; }
    return redraw("rt");
  }
  if (a === "tr") { s.tr.mode = v; return redraw("tr"); }
  if (a === "trk") { s.tr[v] = !s.tr[v]; return redraw("tr"); }
  if (a === "rv") { s.review.on = v === "on"; return redraw("rv"); }
  if (a === "rvk") {
    if (v === "toCreator" && !s.review.toCreator && !d.prem) return c.tg.answerCallback(query.id, lockedAlert, true);
    s.review[v] = !s.review[v]; return redraw("rv");
  }
  return c.tg.answerCallback(query.id);
}

async function applyInput(c, flow, text) {
  const d = flow.data, s = normSettings(d.settings), what = d.input;
  try {
    if (what === "timer") s.time = parseDuration(text);
    else {
      const n = Number(text.replace(",", "."));
      if (!Number.isFinite(n) || n < 0) throw new Error("number");
      if (what === "neg") { if (n > 10) throw new Error("number"); s.neg = n; }
      else s.pass = { on: true, type: what === "passpct" ? "percent" : "marks", value: what === "passpct" ? Math.min(100, n) : n };
    }
  } catch {
    return c.send(flow.userId, what === "timer" ? "I couldn't read that time. Try 45, or 1-30 for 1 min 30 s (max 7 days)." : "Please send a number, for example 0.25 or 60.");
  }
  d.settings = s;
  await dropMsg(c, flow, d.inputMsg); d.inputMsg = null; d.input = null;
  if (d.panelId) {
    try { await c.tg.editMessageText(flow.userId, d.panelId, panelText(flow), { parse_mode: "HTML", reply_markup: panelKb(flow) }); await save(c, flow); return; } catch { /* fall through */ }
  }
  await showPanel(c, flow);
}

async function settingsDone(c, flow, query, useDefault) {
  const d = flow.data, uid = flow.userId;
  let s = normSettings(d.settings);
  await c.tg.answerCallback(query.id);
  if (flow.kind === "create") {
    if (useDefault) { s = (await c.db.getPreset(uid)) || normSettings({}); d.cloneRetake = false; }
    return createNow(c, flow, s);
  }
  if (flow.kind === "preset") { await c.db.setPreset(uid, s); await endFlow(c, flow); return c.send(uid, "✅ Default settings saved. They are used when you tap “Apply default” while creating a quiz.", { kb: kb([homeBtn]) }); }
  if (flow.kind === "qset") {
    await c.db.updateQuiz(d.quizId, uid, { settings: s });
    let extra = "";
    if (d.cloneRetake) { const id = await c.db.cloneQuiz(d.quizId, uid, { name: `${(await c.db.quizHead(d.quizId)).name} (no retake)`, settings: { ...s, retake: "off" } }); extra = `\n\nSecond link with retake disabled:\n${c.link(id)}`; }
    await endFlow(c, flow);
    return c.send(uid, "✅ Settings saved." + extra, { kb: kb([btn("⬅️ Quiz", `eq:${d.quizId}`)]) });
  }
  if (hooks[flow.kind]) return hooks[flow.kind](c, flow, s);
}

// --------------------------------------------------- routing into flows
const TEXT_KINDS = new Set(["create", "replace", "addq", "qdesc", "qname", "qset", "preset", "qrep"]);
export const ownsFlow = (kind) => TEXT_KINDS.has(kind);

export async function flowText(c, flow, msg) {
  const d = flow.data, uid = flow.userId, text = (msg.text || "").trim();
  if (flow.kind === "qdesc") {
    const desc = text === "-" ? "" : text.slice(0, MAX_DESC_LEN);
    await c.db.updateQuiz(d.quizId, uid, { description: desc }); await endFlow(c, flow);
    return c.send(uid, desc ? "✅ Description saved." : "✅ Description removed.", { kb: kb([btn("⬅️ Quiz", `eq:${d.quizId}`)]) });
  }
  if (flow.kind === "qname") {
    const name = text.replace(/\s+/g, " ");
    if (!name || name.length > MAX_NAME_LEN) return c.send(uid, `Please send a name between 1 and ${MAX_NAME_LEN} characters.`);
    await c.db.updateQuiz(d.quizId, uid, { name }); await endFlow(c, flow);
    return c.send(uid, "✅ Renamed.", { kb: kb([btn("⬅️ Quiz", `eq:${d.quizId}`)]) });
  }
  if (flow.kind === "qrep") return singleReplace(c, flow, text, null);
  if ((flow.kind === "preset" || flow.kind === "qset" || d.stage === "settings") && d.input) return applyInput(c, flow, text);
  if (d.stage === "settings" || d.stage === "bulktime") return c.send(uid, "Please use the buttons above, or press Cancel.");
  if (d.stage === "media") return takeMedia(c, flow, msg);
  if (d.stage === "desc") { d.desc = text.slice(0, MAX_DESC_LEN); await dropMsg(c, flow, d.descPrompt); return askQuestions(c, flow, true); }
  if (d.stage === "name") {
    const name = text.replace(/\s+/g, " ");
    if (flow.kind === "replace" && text === "/keep") return afterName(c, flow, d.keepName || (await c.db.quizHead(d.quizId)).name);
    if (!name || name.length > MAX_NAME_LEN) return c.send(uid, `Please send a name between 1 and ${MAX_NAME_LEN} characters.`);
    return afterName(c, flow, name);
  }
  if (d.stage === "qtime") {
    try { return await setPollTime(c, flow, parseDuration(text)); } catch { /* not a time: treat as questions */ }
    d.stage = "questions"; await dropMsg(c, flow, d.timePromptId); d.timePromptId = null;
  }
  if (d.stage === "questions") return addBatch(c, flow, msg.text, (msg.text || "").length >= 3900);
}

async function afterName(c, flow, name) {
  const d = flow.data;
  d.name = name;
  if (flow.kind === "create" && d.mode === "full") {
    d.stage = "desc";
    const m = await say(c, flow, "📝 Quiz description (optional) – shown when someone opens the link. Send it, or skip.", { kb: kb([btn("⏭ Skip", "cr:sd")]) });
    d.descPrompt = m.message_id;
    return save(c, flow);
  }
  return askQuestions(c, flow, flow.kind !== "create" || d.mode === "full");
}

export async function flowPoll(c, flow, msg) {
  const d = flow.data;
  if (flow.kind === "qrep") return singleReplace(c, flow, null, msg.poll);
  if (!["questions", "qtime"].includes(d.stage)) return c.send(flow.userId, "I'm not expecting a poll right now.");
  if (d.stage === "qtime") await setPollTime(c, flow, null);
  return addPoll(c, flow, msg.poll);
}

export async function flowDocument(c, flow, msg) {
  const d = flow.data, doc = msg.document;
  if (d.stage === "media") return takeMedia(c, flow, msg);
  if (!["questions", "qtime"].includes(d.stage) && flow.kind !== "qrep") return c.send(flow.userId, "I only accept files while you're adding questions.");
  if (!((doc.file_name || "").toLowerCase().endsWith(".txt") || doc.mime_type === "text/plain")) return c.send(flow.userId, "Please send a plain text (.txt) file.");
  if (doc.file_size && doc.file_size > 1_000_000) return c.send(flow.userId, "That file is too big (the limit is 1 MB).");
  const text = await c.tg.downloadText(doc.file_id, 1_000_000);
  if (flow.kind === "qrep") return singleReplace(c, flow, text, null);
  if (d.stage === "qtime") await setPollTime(c, flow, null);
  return addBatch(c, flow, text, false);
}

export async function flowMedia(c, flow, msg) {
  if (flow.data.stage === "media") return takeMedia(c, flow, msg);
  return c.send(flow.userId, "I only need pictures, videos or audio when I ask for a question's stem.");
}

async function singleReplace(c, flow, text, poll) {
  const d = flow.data, uid = flow.userId;
  let q;
  if (poll) { const r = questionFromPoll(poll); if (r.error) return c.send(uid, r.error); q = r.q; }
  else {
    const res = parseQuestions(text);
    if (res.questions.length !== 1) return c.send(uid, `I need exactly one question, and found ${res.questions.length}.${res.errors.length ? "\n" + res.errors.map((e) => `• ${e.reason}`).join("\n") : ""}`);
    q = res.questions[0];
  }
  const head = await c.db.quizHead(d.quizId);
  if (!head || head.owner_id !== uid) { await endFlow(c, flow); return c.send(uid, "That quiz no longer exists."); }
  const old = await c.db.getQuestion(head.qid, d.rowId);
  if (!old) { await endFlow(c, flow); return c.send(uid, "That question no longer exists."); }
  if (old.media && !q.media) q.media = q.needsMedia || text === null ? old.media : null;   // ++ keeps the stem; a plain question drops it
  if (poll && old.media) q.media = old.media;
  q.needsMedia = false;
  await c.db.replaceQuestion(head.qid, d.rowId, q);
  await endFlow(c, flow);
  return c.send(uid, `✅ Question replaced. The old version, in case you need it back:\n\n<pre>${esc(formatQuestions([old]))}</pre>`, { html: true });
}

export async function flowCallback(c, flow, query) {
  const d = flow.data, uid = flow.userId, parts = query.data.split(":");
  const a = parts[1];
  await c.tg.answerCallback(query.id);
  if (a === "vt") {
    d.perQ = !d.perQ; await save(c, flow);
    const rows = [[btn(`⏱ Ask time for every question: ${d.perQ ? "✅ on" : "⬜ off"}`, "cr:vt")], [btn("✅ Done adding", "cr:done")]];
    return c.tg.editMarkup(uid, query.message.message_id, kb(...rows));
  }
  if (a === "done") return questionsDone(c, flow);
  if (a === "sd" && d.stage === "desc") { await dropMsg(c, flow, d.descPrompt); return askQuestions(c, flow, true); }
  if (a === "qt" && d.stage === "qtime") { const v = parts[2]; return setPollTime(c, flow, v === "d" ? null : v === "u" ? 0 : Number(v)); }
  if (a === "ms" && d.stage === "media") return takeMedia(c, flow, null, true);
  if (a === "bt" && d.stage === "bulktime") {
    const preset = (await c.db.getPreset(uid)) || normSettings({});
    d.timeOverride = Number(parts[2]);
    return createNow(c, flow, preset);
  }
}

/** /skip while adding media. */
export async function flowSkip(c, flow) {
  if (flow.data.stage === "media") return takeMedia(c, flow, null, true);
  return false;
}
