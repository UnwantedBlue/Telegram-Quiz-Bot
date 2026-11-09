// Routes every Telegram update (a webhook call) to the right handler.
import { makeCtx, ensureBotName, showHome, showMenu, showPremium, btn, kb, lockedAlert, COMMANDS, BUSY } from "./ui.js";
import {
  beginCreate, beginDefault, cancelFlow, flowCallback, flowDocument, flowMedia, flowPoll, flowSkip, flowText, ownsFlow,
  questionsDone, settingsCallback, runStatus, busyText,
} from "./flows.js";
import {
  addqCommand, backupCallback, beginFolderFlow, beginImport, chatAddText, chatCallback, deleteCallback, editCallback, editQuizCommand,
  exportCallback, folderPickCallback, folderText, folderViewCallback, importDocument, importSkip, importText, leaderboardCallback,
  reviewCallback, reviewCommand, saveMistakes, showBackup, showChats, showEditList, showExport, showHistory, showQuizHome,
  showReviewHome, showUnfolder, unfolderCallback,
} from "./views.js";
import {
  buyPremium, channelStartCallback, chooseChat, examText, goCallback, groupCommand, inlineQuery, offerQuiz, paySupport, pendingCallback,
  preCheckout, pressCallback, resumeCallback, resumeCommand, retryCallback, routePollAnswer, setPriceCommand, startChatRun, startInChatCallback,
  startSandbox, stopCommand, successfulPayment,
} from "./play.js";
import { sortInTopics } from "./gemini.js";
import { RETRY_SUFFIX, chunkBlocks, esc, quoteHtml, reviewBlock } from "./engine.js";
import { isOwner } from "./premium.js";
import { setAsset } from "./assets.js";

export async function handleUpdate(env, update, exec, origin) {
  const c = makeCtx(env, exec);
  c.origin = origin;
  await ensureBotName(c);
  try {
    if (update.callback_query) return await onCallback(c, update.callback_query);
    if (update.message) return await onMessage(c, update.message);
    if (update.poll_answer) return await routePollAnswer(c, update.poll_answer);
    if (update.inline_query) return await inlineQuery(c, update.inline_query);
    if (update.pre_checkout_query) return await preCheckout(c, update.pre_checkout_query);
    if (update.my_chat_member) return await onMyChatMember(c, update.my_chat_member);
  } catch (e) {
    console.error("update failed", e && e.stack || e);
    const chat = (update.message && update.message.chat.type === "private" && update.message.chat.id) || (update.callback_query && update.callback_query.message && update.callback_query.message.chat.type === "private" && update.callback_query.from.id);
    if (chat) await c.tg.sendMessage(chat, "⚠️ Something went wrong on my side. Please try again in a moment.").catch(() => {});
    if (update.callback_query) await c.tg.answerCallback(update.callback_query.id);
  }
}

async function onMyChatMember(c, ev) {
  const status = ev.new_chat_member.status, chat = ev.chat;
  if (["member", "administrator"].includes(status) && ["group", "supergroup", "channel"].includes(chat.type) && !ev.from.is_bot)
    await c.db.addChat(ev.from.id, chat.id, chat.type === "channel" ? "channel" : "group", chat.title);
  if (["left", "kicked"].includes(status)) await c.db.run("DELETE FROM user_chats WHERE chat_id=?", chat.id);
}

// ---------------------------------------------------------------- messages
async function onMessage(c, msg) {
  if (msg.successful_payment) return successfulPayment(c, msg);
  if (!msg.from || msg.from.is_bot) return;
  if (msg.chat.type !== "private") {
    if ((msg.text || "").startsWith("/")) return groupCommand(c, msg);
    return;
  }
  const uid = msg.from.id, text = msg.text || "";
  await c.db.upsertUser(msg.from);
  if (text.startsWith("/")) return onCommand(c, msg);

  const flow = await c.db.getFlow(uid);
  if (!flow) {
    if (msg.poll || msg.document || msg.photo) return c.send(uid, "I'm not expecting that right now. Open the menu with /start.");
    const st = await runStatus(c.env, "u:" + uid);
    if (st.active) return;                                   // taking a quiz: the polls are all that matters
    return text ? c.send(uid, "Send /start to open the menu.") : undefined;
  }
  const k = flow.kind;
  if (k === "chadd") return chatAddText(c, flow, msg);
  if (k === "import") {
    if (msg.document) return importDocument(c, flow, msg);
    return text ? importText(c, flow, msg) : undefined;
  }
  if (msg.poll) return ownsFlow(k) ? flowPoll(c, flow, msg) : c.send(uid, "I'm not expecting a poll right now.");
  if (msg.document) return ownsFlow(k) ? flowDocument(c, flow, msg) : c.send(uid, "I'm not expecting a file right now.");
  if (!text) return ownsFlow(k) ? flowMedia(c, flow, msg) : undefined;
  if (k === "folder" || k === "frename") return folderText(c, flow, msg);
  if (k === "examid") return examText(c, flow, msg);
  if (ownsFlow(k)) return flowText(c, flow, msg);
}

async function onCommand(c, msg) {
  const uid = msg.from.id, text = msg.text.trim();
  const [raw, ...args] = text.split(/\s+/), cmd = raw.slice(1).replace(/@.*$/, "").toLowerCase();
  const flow = async () => c.db.getFlow(uid);

  if (cmd === "start") {
    const p = (args[0] || "").trim();
    if (/^q_[a-z0-9]{4,32}$/i.test(p)) return offerQuiz(c, uid, p.slice(2).toLowerCase());
    return showHome(c, uid);
  }
  const simple = {
    home: () => showHome(c, uid), menu: () => showHome(c, uid),
    createquiz: () => beginCreate(c, uid, "full"), bulkcreate: () => beginCreate(c, uid, "bulk"),
    viewmyquiz: () => showQuizHome(c, uid), editmyquiz: () => showEditList(c, uid), unfolder: () => showUnfolder(c, uid),
    history: () => showHistory(c, uid), review: () => showReviewHome(c, uid), pending: () => showReviewHome(c, uid),
    resolved: () => showReviewHome(c, uid), default: () => beginDefault(c, uid), channels: () => showChats(c, uid, "channel"),
    groups: () => showChats(c, uid, "group"), backup: () => showBackup(c, uid), import: () => beginImport(c, uid), export: () => showExport(c, uid),
    store: () => showMenu(c, uid, "store"), premium: () => showPremium(c, uid, uid), commands: () => showMenu(c, uid, "cmds"), help: () => showMenu(c, uid, "cmds"),
    resume: () => resumeCommand(c, msg), stop: () => stopCommand(c, msg), paysupport: () => paySupport(c, msg), setprice: () => setPriceCommand(c, msg),
    folder: async () => { const err = await beginFolderFlow(c, uid); if (err) await c.send(uid, err); },
  };
  if (simple[cmd]) return simple[cmd]();

  if (cmd === "cancel") { const ok = await cancelFlow(c, uid, null, true); if (!ok) await c.send(uid, "There's nothing to cancel."); return; }
  if (cmd === "quesdone") {
    const f = await flow();
    if (!f) return c.send(uid, "There's nothing to finish. Start with /createquiz.");
    if (f.kind === "import") return importText(c, f, { text });
    if (["create", "replace", "addq"].includes(f.kind)) return questionsDone(c, f);
    return c.send(uid, "There's nothing to finish right now.");
  }
  if (cmd === "skip") {
    const f = await flow();
    if (f && f.kind === "import") return importSkip(c, f);
    if (f && (await flowSkip(c, f)) !== false) return;
    return c.send(uid, "There's nothing to skip right now.");
  }
  if (cmd === "keep") { const f = await flow(); if (f && f.kind === "replace") return flowText(c, f, { text: "/keep" }); return; }
  if (/^editquiz_/.test(cmd)) return editQuizCommand(c, msg);
  if (/^addq_/.test(cmd)) return addqCommand(c, msg);
  if (/^rv(ok|back|del)_/.test(cmd)) return reviewCommand(c, msg);
  if (isOwner(c.env, uid)) return ownerCommand(c, msg, cmd, args);
  return c.send(uid, "I don't know that command. Send /commands to see them all.");
}

async function ownerCommand(c, msg, cmd, args) {
  const uid = msg.from.id;
  if (cmd === "grant") {
    const [id, days = "30"] = args;
    if (!/^\d+$/.test(id || "")) return c.send(uid, "Use: /grant <user id> [days]");
    const until = Math.floor(Date.now() / 1000) + Number(days) * 86400;
    await c.db.setPremium(Number(id), until);
    return c.send(uid, `✅ Premium for ${id} until ${new Date(until * 1000).toISOString().slice(0, 10)}.`);
  }
  if (cmd === "adadd") {
    const [t, u] = msg.text.replace(/^\/adadd\s*/, "").split("|").map((x) => x.trim());
    if (!t) return c.send(uid, "Use: /adadd text | https://link (the link is optional)");
    await c.db.addAd(t, u); return c.send(uid, "✅ Sponsored line added.");
  }
  if (cmd === "adlist") { const ads = await c.db.listAds(); return c.send(uid, ads.length ? ads.map((a) => `${a.id}. ${a.text} ${a.url || ""}`).join("\n") : "No sponsored lines."); }
  if (cmd === "setasset") return setAsset(c, msg, (args[0] || "").toLowerCase());
  if (cmd === "addel") { await c.db.delAd(Number(args[0])); return c.send(uid, "Removed."); }
  return c.send(uid, "I don't know that command. Send /commands to see them all.");
}

// --------------------------------------------------------------- callbacks
const FLOW_PREFIXES = new Set(["cr", "st"]);

async function onCallback(c, q) {
  const uid = q.from.id, data = q.data || "", prefix = data.split(":")[0];
  if (!q.message) return c.tg.answerCallback(q.id);
  if (q.message.chat.type !== "private" && !["gs", "gt"].includes(prefix)) return c.tg.answerCallback(q.id);
  await c.db.upsertUser(q.from);

  if (prefix === "gs" || prefix === "gt") return pendingCallback(c, q);
  if (prefix === "fx") return cancelFlow(c, uid, q, true);
  if (FLOW_PREFIXES.has(prefix)) {
    const flow = await c.db.getFlow(uid);
    if (!flow) { await c.tg.answerCallback(q.id, "This button has expired.", true); return c.tg.editMarkup(uid, q.message.message_id, null).catch(() => {}); }
    return prefix === "st" ? settingsCallback(c, flow, q) : flowCallback(c, flow, q);
  }
  switch (prefix) {
    case "m": return menuCallback(c, q);
    case "go": return goCallback(c, q);
    case "rt": return retryCallback(c, q);
    case "sk": case "nx": return pressCallback(c, q);
    case "rs": return resumeCallback(c, q);
    case "lb": return leaderboardCallback(c, q);
    case "sv": return saveMistakes(c, q);
    case "ts": case "tc": case "tx": return topicsCallback(c, q);
    case "vq": return folderViewCallback(c, q);
    case "afl": case "afb": case "afn": case "af": return folderPickCallback(c, q);
    case "uf": case "ufd": return unfolderCallback(c, q);
    case "eq": case "eqa": case "eqr": case "eqn": case "eqd": case "eqs": return editCallback(c, q);
    case "dq": case "dqy": case "dqn": return deleteCallback(c, q);
    case "hs": await c.tg.answerCallback(q.id); return showHistory(c, uid, q, Number(data.split(":")[1]) || 0);
    case "rv": return reviewCallback(c, q, startSandbox);
    case "xp": return exportCallback(c, q);
    case "bk": return backupCallback(c, q);
    case "ch": case "gp": return chatCallback(c, q);
    case "gr": return chooseChat(c, q, "group");
    case "cr2": return chooseChat(c, q, "channel");
    case "chq": case "gpq": return startInChatCallback(c, q);
    case "chs": case "chc": return channelStartCallback(c, q);
    case "pm": return buyPremium(c, q);
    default: return c.tg.answerCallback(q.id);
  }
}

async function menuCallback(c, q) {
  const uid = q.from.id, name = q.data.split(":")[1];
  if (["home", "create", "view", "edit", "cmds", "store", "own"].includes(name)) { await c.tg.answerCallback(q.id); return showMenu(c, uid, name, q); }
  if (name === "soon") return c.tg.answerCallback(q.id, "Forms are coming in a later update.", true);
  await c.tg.answerCallback(q.id);
  const next = {
    q_create: () => beginCreate(c, uid, "full"), q_bulk: () => beginCreate(c, uid, "bulk"), q_quick: () => beginCreate(c, uid, "quick"),
    q_view: () => showQuizHome(c, uid, q), q_hist: () => showHistory(c, uid, q), q_rev: () => showReviewHome(c, uid, q), q_edit: () => showEditList(c, uid, q),
    def: () => beginDefault(c, uid), chan: () => showChats(c, uid, "channel", q), grp: () => showChats(c, uid, "group", q),
    bkp: () => showBackup(c, uid, q), imp: () => beginImport(c, uid), exp: () => showExport(c, uid, q), prem: () => showPremium(c, uid, uid, q),
  }[name];
  return next && next();
}

// ------------------------------------------------------- sort in topics
async function topicsCallback(c, q) {
  const uid = q.from.id, [kind, token] = q.data.split(":");
  if (kind === "tx") { await c.tg.answerCallback(q.id); return c.tg.deleteMessage(uid, q.message.message_id); }
  const set = await c.db.getRetrySet(token);
  if (!set || set.user_id !== uid) return c.tg.answerCallback(q.id, "This button has expired.", true);
  if (kind === "ts") {
    await c.tg.answerCallback(q.id);
    return c.send(uid, "🔃 <b>Sort in topics</b>\nThis sends the text of your wrong and skipped questions to Google Gemini to group them by topic. Google may use that text to train its models. Continue?", { html: true, kb: kb([btn("✅ Sort", `tc:${token}`), btn("❌ No", "tx:x")]) });
  }
  await c.tg.answerCallback(q.id, "Sorting…");
  await c.tg.deleteMessage(uid, q.message.message_id);
  let groups;
  try { groups = await sortInTopics(c.env, set.items.map((i) => i.q)); }
  catch { return c.send(uid, "⚠️ I couldn't sort the questions just now. Your review is still above."); }
  await c.tg.deleteMessages(uid, set.msg_ids);
  const ids = [];
  const sorted = groups.map((g) => ({ ...g, blocks: g.items.map((i) => { const it = set.items[i]; return reviewBlock(it.q.text, it.q.correct.map((x) => it.q.options[x]), it.wrong); }) }));
  const rows = [[btn(`🔁 Retry wrong & skipped (${set.items.length})`, `rt:${token}`)], [btn("💾 Save mistakes", `sv:${token}`)]];
  const out = [];
  for (const g of sorted) chunkBlocks(g.blocks).forEach((chunk, i) => out.push(`<b><i>${esc(g.topic)}</i></b>${i ? " (cont.)" : ""}\n${quoteHtml(chunk)}`));
  const msgs = out.slice(0, 20);
  for (let i = 0; i < msgs.length; i++) {
    const last = i === msgs.length - 1;
    const m = await c.send(uid, (i === 0 ? "📝 <b>Review</b> – sorted in topics by Google Gemini\n\n" : "") + msgs[i], { html: true, kb: last ? kb(...(set.settings.retake === "on" ? rows : rows.slice(1))) : undefined });
    ids.push(m.message_id);
  }
  await c.db.setRetryMsgs(token, ids);
}
