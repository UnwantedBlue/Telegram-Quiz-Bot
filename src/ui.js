// Shared plumbing for the bot handlers: the per-update context, sending/editing helpers, texts and the home menus.
import { Tg, TgError, btn, kb, noKb, urlBtn, webBtn } from "./tg.js";
import { DB } from "./db.js";
import { esc, MAX_QUESTIONS } from "./engine.js";
import { isPremium, limitsFor, FREE, PREMIUM } from "./premium.js";

export const COMMANDS = [
  ["start", "Home"], ["home", "Open the home menu"], ["createquiz", "Create a quiz (text, files, polls)"], ["bulkcreate", "Create a quiz from pasted text"],
  ["quesdone", "Finish adding questions"], ["viewmyquiz", "My quizzes, folders and links"], ["editmyquiz", "Edit or delete my quizzes"],
  ["folder", "Make a new folder"], ["unfolder", "Remove folders"], ["history", "Quizzes I took"], ["review", "My saved mistakes"],
  ["default", "My default quiz settings"], ["channels", "Start a quiz in my channel"], ["groups", "Start a quiz in my group"],
  ["backup", "Download a backup of everything"], ["import", "Restore a backup or recreate quizzes"], ["export", "Export a quiz, a folder or everything"],
  ["store", "Store"], ["premium", "Go premium"], ["resume", "Continue an interrupted quiz"], ["stop", "Stop the quiz I'm taking"],
  ["cancel", "Cancel what I'm doing"], ["skip", "Skip (while importing or adding media)"], ["keep", "Keep the current name (while editing)"],
  ["commands", "List of all commands"],
];

let BOT_NAME = null;
export function makeCtx(env, exec) {
  const c = { env, exec, tg: new Tg(env.BOT_TOKEN), db: new DB(env.DB), bn: BOT_NAME || "", origin: "" };
  c.link = (id) => `https://t.me/${c.bn}?start=q_${id}`;
  c.appLink = (quizId, n) => (env.MINIAPP_SHORTNAME ? `https://t.me/${c.bn}/${env.MINIAPP_SHORTNAME}?startapp=${quizId}_${n}` : null);
  c.appUrl = (quizId, extra = "") => `${(env.PAGES_URL || "").replace(/\/$/, "")}/?quiz=${quizId}${extra}`;
  c.send = async (chat, text, o = {}) => {
    const extra = {};
    if (o.html) extra.parse_mode = "HTML";
    if (o.kb) extra.reply_markup = o.kb;
    if (o.extra) Object.assign(extra, o.extra);
    const msg = await c.tg.sendMessage(chat, text, extra);
    if (o.flow) o.flow.msgs.push(msg.message_id);
    return msg;
  };
  /** Show text with a keyboard. From a button press the message is edited in place; otherwise a new one is sent. */
  c.show = async (chat, text, markup, query = null, html = false) => {
    const extra = { ...(html ? { parse_mode: "HTML" } : {}), reply_markup: markup || { inline_keyboard: [] } };
    if (query && query.message) {
      try { await c.tg.editMessageText(chat, query.message.message_id, text.slice(0, 4096), extra); return query.message; }
      catch (e) { if (/not modified/i.test(e.message)) return query.message; await c.tg.deleteMessage(chat, query.message.message_id); }
    }
    return c.send(chat, text.slice(0, 4096), { html, kb: markup });
  };
  c.premium = (uid) => isPremium(env, c.db, uid);
  c.limits = (uid) => limitsFor(env, c.db, uid);
  return c;
}

export async function ensureBotName(c) {
  if (BOT_NAME) { c.bn = BOT_NAME; return; }
  let n = await c.db.kvGet("bot_username");
  if (!n) { n = (await c.tg.call("getMe")).username; await c.db.kvSet("bot_username", n); }
  BOT_NAME = c.bn = n;
}

export const BUSY = {
  quiz: "You're in the middle of a quiz. Finish it, or send /stop to end it first.",
  paused: "Your quiz was interrupted. Send /resume to carry on, or /stop to end it and see your score.",
  flow: "You're in the middle of something else. Press ❌ Cancel on the first message of it (or send /cancel), then try again.",
};

export const FORMAT_HELP =
  "Format:\n\n+What is the capital of France?\nLondon\nBerlin\n*Paris\nMadrid\n=Paris is the capital and largest city of France.\n:20\n\n" +
  "• Every question starts with +\n• Put * in front of every correct option (more than one is allowed)\n" +
  "• //description under the + line (optional, shown above the poll)\n• =explanation line (optional, max 200 characters)\n" +
  "• :seconds for this question's own time (optional) – :14, or d-h-m-s like :1-30 for 1 min 30 s; :0 = untimed\n" +
  "• ++ on its own line before a + line: that question needs a picture / video / audio – I'll ask for it afterwards\n" +
  "• 2 to 12 options per question\n• To start an option with + * = or // put a backslash first, like \\+5 mg\n" +
  "• Send several messages, a .txt file" + "\n";

export const cancelBtn = btn("❌ Cancel", "fx:x");
export const homeBtn = btn("🏠 Home", "m:home");

// ------------------------------------------------------------------- menus
export const HOME_TEXT =
  "👋 <b>Quiz Bot</b>\n\nCreate quizzes from pasted text, files or polls, share a link, and anyone can take them as timed Telegram quiz polls – on their own, in a group or in a channel.\n\nTap a button to begin.";

export const homeKb = () => kb(
  [btn("➕ Create", "m:create"), btn("📂 View", "m:view")],
  [btn("✏️ Edit", "m:edit"), btn("★ Default", "m:def")],
  [btn("📢 Channels", "m:chan"), btn("💬 Groups", "m:grp"), btn("⁉️ Commands", "m:cmds")],
  [btn("🛒 Store", "m:store"), btn("✨ Go Premium", "m:prem")],
  [btn("🔃 Backup", "m:bkp"), btn("⬇️ Import", "m:imp"), btn("⬆️ Export", "m:exp")],
);

export function showHome(c, chat, query = null) { return c.show(chat, HOME_TEXT, homeKb(), query, true); }

export async function showMenu(c, chat, name, query = null) {
  if (name === "home") return showHome(c, chat, query);
  const back = [homeBtn];
  if (name === "create") return c.show(chat, "➕ <b>Create</b>", kb(
    [btn("📝 Quiz", "m:q_create")], [btn("⚡ Quick quiz", "m:q_quick"), btn("📋 Bulk paste", "m:q_bulk")], [btn("📄 Form (soon)", "m:soon")], back), query, true);
  if (name === "view") return c.show(chat, "📂 <b>View</b>", kb(
    [btn("📚 My quizzes", "m:q_view"), btn("🗂 My forms (soon)", "m:soon")], [btn("📜 History", "m:q_hist"), btn("📝 Review", "m:q_rev")], back), query, true);
  if (name === "edit") return c.show(chat, "✏️ <b>Edit</b>", kb([btn("📚 Quizzes", "m:q_edit"), btn("📄 Forms (soon)", "m:soon")], back), query, true);
  if (name === "cmds") {
    const text = "⁉️ <b>Commands</b>\nEverything can be done with the buttons; these work too:\n\n" + COMMANDS.map(([n, d]) => `/${n} – ${esc(d)}`).join("\n");
    return c.show(chat, text, kb(back), query, true);
  }
  if (name === "store") return c.show(chat, "🛒 <b>Store</b>\n\n✨ Premium – more folders, encrypted backups, exam mode, paid quizzes and no sponsored lines.\n🤖 Your own copy of this bot – run it under your own name.",
    kb([btn("✨ Go Premium", "m:prem")], [btn("🤖 Get your own bot", "m:own")], back), query, true);
  if (name === "own") return c.show(chat, "🤖 <b>Your own bot</b>\n\nThis bot is open source and runs on free Cloudflare + GitHub accounts, so you can host your own copy under your own name and token. The step-by-step guide is in the README of the project (“Deploy”). Buying a ready-made copy is not available yet.", kb([btn("⬅️ Store", "m:store")]), query, true);
  return null;
}

export async function showPremium(c, chat, uid, query = null) {
  const until = await c.db.premiumUntil(uid), owner = String(uid) === String(c.env.OWNER_ID);
  const active = owner || until > Math.floor(Date.now() / 1000);
  const perks = (await import("./premium.js")).PREMIUM_PERKS.join("\n");
  const stars = (await import("./premium.js")).starsPrice(c.env);
  const text = `✨ <b>Premium</b>\n\n${perks}\n\n` +
    (active ? `✅ You have premium${owner ? "" : " until " + new Date(until * 1000).toISOString().slice(0, 10)}.` : `${stars} ⭐ Telegram Stars for 30 days.`);
  return c.show(chat, text, kb([btn(active ? `⭐ Extend 30 days (${stars})` : `⭐ Buy 30 days (${stars})`, "pm:buy")], [homeBtn]), query, true);
}

export const lockedAlert = "✨ This is a premium feature. Open Home → Go Premium.";
export { TgError, btn, kb, noKb, urlBtn, webBtn, esc, MAX_QUESTIONS, FREE, PREMIUM };
