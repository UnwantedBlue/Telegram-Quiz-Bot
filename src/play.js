// Taking quizzes: the offer card, starting a run (alone, retry, sandbox, group, channel), inline sharing, payments.
import { btn, kb, noKb, urlBtn, esc, BUSY, showPremium } from "./ui.js";
import { userLabel } from "./tg.js";
import { busyText, runStatus, runStub, startFlow, endFlow, showPanel as showPanelFor, hooks } from "./flows.js";
import { RETRY_SUFFIX, formatLimit, isExam, normSettings, plural, fmtMarks, nowSec } from "./engine.js";
import { PREMIUM_DAYS, isOwner, starsPrice } from "./premium.js";

const who = (u) => ({ id: u.id, name: userLabel(u), username: u.username || null });
const isUntimed = (head, questions) => questions.some((q) => (q.time ?? head.settings.time) === 0);

// ------------------------------------------------------------------ offer
export async function offerQuiz(c, chat, quizId) {
  const head = await c.db.quizHead(quizId);
  if (!head) return c.send(chat, "Sorry, I couldn't find that quiz. It may have been removed.");
  const lines = [`<b>${esc(head.name)}</b>`];
  if (head.description) lines.push(esc(head.description));
  lines.push(`Questions: ${head.n_questions}`, `Time per question: ${formatLimit(head.settings.time)}`);
  if (head.price > 0) lines.push(`💰 Price: ${head.price} ⭐`);
  if (isExam(head.settings)) lines.push("🎓 Exam: your result is sent to the quiz creator.");
  lines.push("", "Press the button when you're ready.");
  return c.send(chat, lines.join("\n"), { html: true, kb: kb(
    [btn("▶️ Start quiz", `go:${head.id}`)],
    [{ text: "📤 Share", switch_inline_query: `q_${head.id}` }, urlBtn("👥 Start in group", `https://t.me/${c.bn}?startgroup=q_${head.id}`)],
    [btn("🏆 Leaderboard", `lb:${head.id}`)]) });
}

// ------------------------------------------------------------- solo runs
async function guardStart(c, user) {
  const st = await runStatus(c.env, "u:" + user.id);
  if (st.active) return st.suspended ? BUSY.paused : BUSY.quiz;
  if (await c.db.getFlow(user.id)) return "Finish or cancel what you're creating first (press ❌ Cancel on its first message), then open the link again.";
  return null;
}

async function launch(c, user, init) {
  const r = await runStub(c.env, "u:" + user.id).start({ mode: "solo", chatId: user.id, starter: who(user), botUsername: c.bn, ...init });
  return r;
}

export async function goCallback(c, query) {
  const user = query.from, quizId = query.data.split(":")[1];
  const blocked = await guardStart(c, user);
  if (blocked) return c.tg.answerCallback(query.id, blocked, true);
  const quiz = await c.db.quizFull(quizId);
  if (!quiz) return c.tg.answerCallback(query.id, "This quiz no longer exists.", true);
  const owner = quiz.owner_id === user.id;
  if (quiz.settings.retake === "off" && !owner && (await c.db.attemptCount(quiz.id, user.id)) > 0) {
    const a = await c.db.lastAttempt(quiz.id, user.id);
    return c.tg.answerCallback(query.id, `Retake is disabled for this quiz. Your result: ${fmtMarks(a.score)}/${a.total}.`, true);
  }
  if (quiz.price > 0 && !owner && !(await c.db.hasPurchase(user.id, "quiz", quiz.id))) {
    await c.tg.answerCallback(query.id);
    return sendQuizInvoice(c, user.id, quiz);
  }
  await c.tg.answerCallback(query.id);
  if (isExam(quiz.settings) && quiz.settings.review.askName) {
    await c.tg.editMarkup(user.id, query.message.message_id, noKb).catch(() => {});
    return startFlow(c, user.id, "examid", { quizId, stage: "name" }, `🎓 <b>${esc(quiz.name)}</b>\n\nBefore you start, send your <b>full name</b>.`);
  }
  await c.tg.editMarkup(user.id, query.message.message_id, noKb).catch(() => {});
  return runSolo(c, user, quiz, null);
}

async function runSolo(c, user, quiz, exam) {
  const r = await launch(c, user, {
    ownerId: quiz.owner_id, quiz: { id: quiz.id, name: quiz.name, description: quiz.description }, settings: quiz.settings,
    questions: quiz.questions, link: c.link(quiz.id), kind: "normal", exam,
  });
  if (!r.ok) await c.send(user.id, r.suspended ? BUSY.paused : BUSY.quiz);
}

export async function examText(c, flow, msg) {
  const d = flow.data, text = (msg.text || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 60) return c.send(flow.userId, "Please send a short text (up to 60 characters).");
  if (d.stage === "name") {
    d.name = text; d.stage = "id";
    const m = await c.send(flow.userId, "Now send your <b>ID</b> (student / roll / registration number).", { html: true, flow });
    await c.db.saveFlow(flow);
    return m;
  }
  const quiz = await c.db.quizFull(d.quizId);
  await endFlow(c, flow);
  if (!quiz) return c.send(flow.userId, "This quiz no longer exists.");
  return runSolo(c, msg.from, quiz, { name: d.name, id: text });
}

export async function retryCallback(c, query) {
  const user = query.from, set = await c.db.getRetrySet(query.data.split(":")[1]);
  const blocked = await guardStart(c, user);
  if (blocked) return c.tg.answerCallback(query.id, blocked, true);
  if (!set || set.user_id !== user.id) return c.tg.answerCallback(query.id, "This button has expired. Open the quiz link to take the quiz again.", true);
  await c.tg.answerCallback(query.id);
  await c.tg.editMarkup(user.id, query.message.message_id, noKb).catch(() => {});
  const n = set.items.length;
  await c.send(user.id, `🔁 Retrying your ${plural(n, "wrong or skipped question")}, same settings. Good luck!`);
  const settings = normSettings(set.settings);
  const r = await launch(c, user, {
    ownerId: user.id, quiz: { id: set.quiz_id, name: set.name, description: "" }, settings, questions: set.items.map((i) => i.q),
    link: c.link(set.quiz_id), kind: "retry",
  });
  if (!r.ok) await c.send(user.id, BUSY.quiz);
}

export async function startSandbox(c, uid) {
  const user = { id: uid }, blocked = await guardStart(c, user);
  if (blocked) return c.send(uid, blocked);
  const items = await c.db.pendingForPractice(uid, 30);
  if (!items.length) return c.send(uid, "🧪 You have no pending mistakes to practise. Save some with “💾 Save mistakes” under your results.");
  const u = (await c.db.getUser(uid)) || {};
  await c.send(uid, `🧪 Sandbox: ${plural(items.length, "pending question")}. Every one you get right moves to resolved. Nothing here counts in your history.`);
  const r = await runStub(c.env, "u:" + uid).start({
    mode: "solo", chatId: uid, starter: { id: uid, name: u.name || "You", username: u.username || null }, botUsername: c.bn, ownerId: uid,
    quiz: { id: "sandbox", name: "🧪 Sandbox", description: "" }, settings: normSettings({ time: 30, retake: "off" }), questions: items.map((i) => i.question),
    link: "", kind: "sandbox", reviewIds: items.map((i) => i.id),
  });
  if (!r.ok) await c.send(uid, BUSY.quiz);
}

// ----------------------------------------------- Skip / Next / Resume / Stop
export async function pressCallback(c, query) {
  const [kind, sid, pos] = query.data.split(":");
  const ok = await runStub(c.env, "u:" + query.from.id).press({ sid, pos: Number(pos), userId: query.from.id, next: kind === "nx" });
  return c.tg.answerCallback(query.id, ok ? undefined : "This button is no longer active.");
}

export async function resumeCallback(c, query) {
  const sid = query.data.split(":")[1];
  const ok = await runStub(c.env, "u:" + query.from.id).resume({ sid, userId: query.from.id });
  if (!ok) return c.tg.answerCallback(query.id, "This button is no longer active.", true);
  await c.tg.answerCallback(query.id);
  return c.tg.editMarkup(query.from.id, query.message.message_id, noKb).catch(() => {});
}

export async function resumeCommand(c, msg) {
  const st = await runStatus(c.env, "u:" + msg.from.id);
  if (!st.active) return c.send(msg.from.id, "There's no interrupted quiz to resume.");
  if (!st.suspended) return c.send(msg.from.id, "Your quiz is running. Send /stop to end it.");
  await runStub(c.env, "u:" + msg.from.id).resume({ sid: null, userId: msg.from.id });
}

export async function stopCommand(c, msg) {
  const ok = await runStub(c.env, "u:" + msg.from.id).stop();
  if (!ok) await c.send(msg.from.id, "No quiz is running, so there's nothing to stop.");
}

export async function routePollAnswer(c, pa) {
  const key = await c.db.pollRun(pa.poll_id);
  if (!key || !pa.user) return;
  await runStub(c.env, key).answer({ pollId: pa.poll_id, user: who(pa.user), optionIds: pa.option_ids });
}

// ---------------------------------------------------------- groups & channels
async function isChatAdmin(c, chatId, userId) {
  try { const m = await c.tg.call("getChatMember", { chat_id: chatId, user_id: userId }); return ["creator", "administrator"].includes(m.status); } catch { return false; }
}

export async function startChatRun(c, { quizId, chatId, kind, user, time = 0 }) {
  const mode = kind === "channel" ? "channel" : "group", key = "g:" + chatId;
  const st = await runStatus(c.env, key);
  if (st.active) return { error: "A quiz is already running there. Stop it with /stop in the group first." };
  const quiz = await c.db.quizFull(quizId);
  if (!quiz) return { error: "That quiz no longer exists." };
  const r = await runStub(c.env, key).start({
    mode, chatId, starter: who(user), ownerId: quiz.owner_id, botUsername: c.bn, quiz: { id: quiz.id, name: quiz.name, description: quiz.description },
    settings: quiz.settings, questions: quiz.questions, link: c.link(quiz.id), kind: "normal", groupTime: time, delayMs: mode === "group" ? 5000 : 3000,
  });
  return r.ok ? {} : { error: "A quiz is already running there." };
}

const TIME_PICK = [5, 10, 15, 30].map((t) => t);

/** Ask who/what/when: for untimed quizzes the starter must pick a time first. Works in a group (card) and in private (picker). */
async function offerStart(c, { quizId, chatId, kind, user, replyChat, inGroup }) {
  const quiz = await c.db.quizFull(quizId);
  if (!quiz) return c.send(replyChat, "That quiz no longer exists.");
  const untimed = isUntimed(quiz, quiz.questions);
  const token = await c.db.createPending({ quizId, chatId, kind, byUser: user.id });
  if (!inGroup && !untimed) {                             // from private: start right away
    const r = await startChatRun(c, { quizId, chatId, kind, user });
    await c.db.delPending(token);
    return c.send(replyChat, r.error ? `⚠️ ${r.error}` : "▶️ Starting in a few seconds…");
  }
  const text = `<b>${esc(quiz.name)}</b>\n${quiz.description ? esc(quiz.description) + "\n" : ""}${plural(quiz.n_questions, "question")}${untimed ? "\n\n⏱ Some questions have no time limit, which doesn't work in a group or channel. Pick the time per question for those:" : "\n\nPress Start when everyone is ready."}`;
  const rows = untimed ? [TIME_PICK.map((t) => btn(`${t}s`, `gt:${token}:${t}`))] : [[btn("▶️ Start now", `gs:${token}`)]];
  return c.send(replyChat, text, { html: true, kb: kb(...rows) });
}

export async function pendingCallback(c, query) {
  const [kind, token, sec] = query.data.split(":"), p = await c.db.getPending(token), user = query.from;
  if (!p) return c.tg.answerCallback(query.id, "This button has expired.", true);
  if (user.id !== p.by_user && !(await isChatAdmin(c, p.chat_id, user.id))) return c.tg.answerCallback(query.id, "Only the person who asked for the quiz, or an admin, can start it.", true);
  await c.db.delPending(token);
  await c.tg.answerCallback(query.id);
  await c.tg.editMarkup(query.message.chat.id, query.message.message_id, noKb).catch(() => {});
  const r = await startChatRun(c, { quizId: p.quiz_id, chatId: p.chat_id, kind: p.kind, user, time: kind === "gt" ? Number(sec) : 0 });
  if (r.error) await c.send(query.message.chat.id, `⚠️ ${r.error}`);
}

/** Commands typed in a group: /quiz <id>, /start q_<id> (the "Start in group" button), /start reg, /stop, /leaderboard. */
export async function groupCommand(c, msg) {
  const chat = msg.chat, user = msg.from, text = (msg.text || "").trim();
  const [cmdRaw, ...args] = text.split(/\s+/), cmd = cmdRaw.replace(/^\//, "").replace(/@.*$/, "").toLowerCase();
  const arg = (args[0] || "").replace(/^q_/, "").toLowerCase();
  if (cmd === "start" && arg === "reg") {
    if (!(await isChatAdmin(c, chat.id, user.id))) return c.send(chat.id, "Only a group admin can add this group to their list.");
    await c.db.addChat(user.id, chat.id, "group", chat.title);
    return c.send(chat.id, `✅ “${chat.title}” is in ${userLabel(user)}'s group list. Open the bot in private chat → Groups to start quizzes here.`);
  }
  if (cmd === "start" || cmd === "quiz") {
    if (!arg) return c.send(chat.id, "Use /quiz followed by a quiz id, or open a quiz link and tap “Start in group”.");
    const head = await c.db.quizHead(arg);
    if (!head) return c.send(chat.id, "I couldn't find that quiz.");
    return offerStart(c, { quizId: arg, chatId: chat.id, kind: "group", user, replyChat: chat.id, inGroup: true });
  }
  if (cmd === "stop") {
    const st = await runStatus(c.env, "g:" + chat.id);
    if (!st.active) return c.send(chat.id, "No quiz is running here.");
    if (user.id !== st.startedBy && !(await isChatAdmin(c, chat.id, user.id))) return c.send(chat.id, "Only the person who started the quiz, or an admin, can stop it.");
    return runStub(c.env, "g:" + chat.id).stop();
  }
  if (cmd === "leaderboard") {
    const id = arg;
    const head = id ? await c.db.quizHead(id) : null;
    if (!head) return c.send(chat.id, "Use /leaderboard followed by a quiz id.");
    const rows = await c.db.leaderboard(id, 10);
    return c.send(chat.id, `🏆 <b>${esc(head.name)}</b>\n\n` + (rows.length ? rows.map((r, i) => `${i + 1}. ${esc(r.name)} – ${fmtMarks(r.marks)}`).join("\n") : "Nobody has taken this quiz yet."), { html: true });
  }
}

/** Private chat: "Start in group" / "Start in channel" from the quiz menu and the lists. */
export async function chooseChat(c, query, kind) {
  const uid = query.from.id, quizId = query.data.split(":")[1];
  const head = await c.db.quizHead(quizId);
  await c.tg.answerCallback(query.id);
  if (!head) return c.send(uid, "That quiz no longer exists.");
  const chats = await c.db.listChats(uid, kind), cmd = kind === "channel" ? "chq" : "gpq";
  const rows = chats.map((x) => [btn(`${kind === "channel" ? "📢" : "💬"} ${x.title || x.chat_id}`, `${cmd}:${x.chat_id}:${quizId}`)]);
  rows.push([btn(`➕ Add ${kind}`, kind === "channel" ? "ch:a" : "gp:a")], [btn("⬅️ Back", `eq:${quizId}`)]);
  return c.show(uid, `Where do you want to start “${head.name}”?`, kb(...rows), query);
}

export async function startInChatCallback(c, query) {
  const uid = query.from.id, [cmd, chatIdS, quizId] = query.data.split(":"), chatId = Number(chatIdS), kind = cmd === "chq" ? "channel" : "group";
  const head = await c.db.quizHead(quizId), chat = await c.db.getChat(uid, chatId);
  if (!head || head.owner_id !== uid || !chat) return c.tg.answerCallback(query.id, "I couldn't find that quiz or chat.", true);
  if (!(await isChatAdmin(c, chatId, uid))) return c.tg.answerCallback(query.id, "You need to be an admin there.", true);
  await c.tg.answerCallback(query.id);
  if (kind === "channel") {
    const token = await c.db.createPending({ quizId, chatId, kind, byUser: uid });
    return c.show(uid, `📢 <b>${esc(chat.title)}</b>\nStart “${esc(head.name)}” there?\n\n• As is – with the quiz's own settings.\n• Customise – I ask the bulk settings again and make a copy of the quiz just for this channel.`,
      kb([btn("▶️ Start as is", `chs:${token}`)], [btn("⚙️ Customise (makes a copy)", `chc:${token}`)], [btn("⬅️ Back", `ch:s:${chatId}`)]), query, true);
  }
  return offerStart(c, { quizId, chatId, kind, user: query.from, replyChat: uid, inGroup: false });
}

export async function channelStartCallback(c, query) {
  const uid = query.from.id, [cmd, token] = query.data.split(":"), p = await c.db.getPending(token);
  if (!p || p.by_user !== uid) return c.tg.answerCallback(query.id, "This button has expired.", true);
  await c.tg.answerCallback(query.id);
  await c.db.delPending(token);
  if (cmd === "chs") return offerStart(c, { quizId: p.quiz_id, chatId: p.chat_id, kind: "channel", user: query.from, replyChat: uid, inGroup: false });
  const blocked = await busyText(c, uid);
  if (blocked) return c.send(uid, blocked);
  const head = await c.db.quizHead(p.quiz_id);
  const flow = await startFlow(c, uid, "chclone", { quizId: p.quiz_id, chatId: p.chat_id, stage: "settings", settings: head.settings, prem: (await c.limits(uid)).exam }, `📢 <b>Settings for the channel copy</b> of “${esc(head.name)}”.`);
  return showPanelFor(c, flow);
}

// the finished settings panel of a channel copy
hooks.chclone = async (c, flow, settings) => {
  const d = flow.data, uid = flow.userId;
  const head = await c.db.quizHead(d.quizId), chat = await c.db.getChat(uid, d.chatId);
  await endFlow(c, flow);
  if (!head || !chat) return c.send(uid, "That quiz or channel no longer exists.");
  const cloneId = await c.db.cloneQuiz(d.quizId, uid, { name: `${head.name} (${chat.title})`.slice(0, 100), settings });
  return offerStart(c, { quizId: cloneId, chatId: d.chatId, kind: "channel", user: { id: uid, first_name: "Admin" }, replyChat: uid, inGroup: false });
};

// ------------------------------------------------------------ inline mode
export async function inlineQuery(c, iq) {
  const uid = iq.from.id, text = (iq.query || "").trim().toLowerCase();
  let quizzes = [];
  const m = text.match(/^(?:q_)?([a-z0-9]{6,32})$/);
  if (m) { const h = await c.db.quizHead(m[1]); if (h) quizzes = [h]; }
  if (!quizzes.length) {
    const mine = await c.db.listQuizzes(uid);
    quizzes = mine.filter((q) => !text || q.name.toLowerCase().includes(text)).slice(0, 20).map((q) => ({ id: q.id, name: q.name, description: q.description, n_questions: q.n }));
  }
  const results = quizzes.map((q) => ({
    type: "article", id: q.id, title: q.name, description: `${q.n_questions} questions`,
    input_message_content: { message_text: `🎯 ${q.name}${q.description ? "\n" + q.description : ""}\n${q.n_questions} questions – tap Start to take the quiz.`, link_preview_options: { is_disabled: true } },
    reply_markup: kb([urlBtn("▶️ Start quiz", c.link(q.id))]),
  }));
  return c.tg.call("answerInlineQuery", { inline_query_id: iq.id, results, cache_time: 5, is_personal: true });
}

// ---------------------------------------------------------------- payments
export async function buyPremium(c, query) {
  const uid = query.from.id;
  await c.tg.answerCallback(query.id);
  const stars = starsPrice(c.env);
  return c.tg.call("sendInvoice", {
    chat_id: uid, title: "Quiz Bot Premium", description: `${PREMIUM_DAYS} days of premium: more folders, encrypted backups, exam mode, paid quizzes, no sponsored lines.`,
    payload: `prem:${uid}`, currency: "XTR", prices: [{ label: `Premium ${PREMIUM_DAYS} days`, amount: stars }],
  });
}

function sendQuizInvoice(c, uid, quiz) {
  return c.tg.call("sendInvoice", {
    chat_id: uid, title: quiz.name.slice(0, 32), description: `Access to the quiz “${quiz.name}”`.slice(0, 255),
    payload: `quiz:${quiz.id}`, currency: "XTR", prices: [{ label: "Quiz", amount: quiz.price }],
  });
}

export const preCheckout = (c, q) => c.tg.call("answerPreCheckoutQuery", { pre_checkout_query_id: q.id, ok: true });

export async function successfulPayment(c, msg) {
  const uid = msg.from.id, pay = msg.successful_payment, [kind, ref] = pay.invoice_payload.split(":");
  await c.db.addPurchase(uid, kind, ref, pay.total_amount, pay.telegram_payment_charge_id);
  if (kind === "prem") {
    const base = Math.max(nowSec(), await c.db.premiumUntil(uid));
    const until = base + PREMIUM_DAYS * 86400;
    await c.db.setPremium(uid, until);
    return c.send(uid, `✨ Premium is active until ${new Date(until * 1000).toISOString().slice(0, 10)}. Thank you!`);
  }
  if (kind === "quiz") return c.send(uid, "✅ Thank you! You can start the quiz now.", { kb: kb([btn("▶️ Start quiz", `go:${ref}`)]) });
}

export const paySupport = (c, msg) => c.send(msg.from.id, "💬 Payment help: for refunds or problems with a Stars payment, contact the bot owner and include your Telegram user id: " + msg.from.id + ".");

/** /setprice <quiz id> <stars>  (premium feature: paid quizzes) */
export async function setPriceCommand(c, msg) {
  const uid = msg.from.id, [, id, stars] = msg.text.trim().split(/\s+/);
  if (!(await c.limits(uid)).paid) return c.send(uid, "💰 Paid quizzes are a premium feature. Open Home → Go Premium.");
  const head = id ? await c.db.quizHead(id.toLowerCase()) : null;
  if (!head || head.owner_id !== uid || !/^\d+$/.test(stars || "")) return c.send(uid, "Use: /setprice <quiz id> <stars>  (0 = free). The id is the part after q_ in the quiz link.");
  await c.db.updateQuiz(head.id, uid, { price: Math.min(100000, Number(stars)) });
  return c.send(uid, Number(stars) ? `💰 “${head.name}” now costs ${stars} ⭐ to take.` : `“${head.name}” is free again.`);
}
