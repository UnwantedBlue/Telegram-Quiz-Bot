// Everything you can look at or manage from the menus: quizzes and folders (inline buttons), the edit menu, history,
// saved mistakes (review), export / backup / import, and the lists of your groups and channels.
import { btn, kb, urlBtn, webBtn, homeBtn, cancelBtn, esc, BUSY, lockedAlert, TgError } from "./ui.js";
import {
  MAX_FOLDER_NAME_LEN, MAX_NAME_LEN, MAX_BACKUP_BYTES, chunkBlocks, plural, slug, reviewBlock, quoteHtml, formatLimit, nowSec, fmtMarks,
} from "./engine.js";
import { buildBackup, formatRestoreReport, looksLikeBackup, looksLikeVault, parseBackup, parseImportList, restoreBackup } from "./backup.js";
import { Question } from "./qparser.js";
import { sendAsset } from "./assets.js";
import { busyText, endFlow, folderButton, startFlow, beginReplace, beginAdd, beginText, beginQuizSettings } from "./flows.js";

// ------------------------------------------------------------------ lists
const quizLines = (c, quizzes) => quizzes.map((q, i) => `${i + 1}. ${q.name} – ${c.link(q.id)}`);
const back = (target = "vq:home") => btn("⬅️ Back", target);

async function showLines(c, chat, lines, markup, query) {
  const chunks = chunkBlocks(lines, 3900, "\n");
  if (query && chunks.length === 1) return c.show(chat, chunks[0], markup, query);
  if (query) await c.tg.deleteMessage(chat, query.message.message_id);
  for (let i = 0; i < chunks.length; i++) await c.send(chat, chunks[i], { kb: i === chunks.length - 1 ? markup : undefined });
}

export async function showQuizHome(c, uid, query = null) {
  const quizzes = await c.db.listQuizzes(uid), folders = await c.db.listFolders(uid);
  if (!quizzes.length && !folders.length) return c.show(uid, "You haven't created any quizzes yet.", kb([btn("📝 Create a quiz", "m:q_create")], [homeBtn]), query);
  const unfiled = quizzes.filter((q) => q.folder_id === null);
  const lines = ["📚 Your quizzes", ""];
  if (!folders.length) lines.push(...quizLines(c, unfiled));
  else {
    if (unfiled.length) lines.push("Not in a folder:", ...quizLines(c, unfiled)); else lines.push(quizzes.length ? "Every quiz is in a folder." : "You haven't created any quizzes yet.");
    lines.push("", "Tap a folder to open it, or All to see every quiz.");
  }
  const rows = folders.map((f) => [btn(`📁 ${f.name} (${f.n})`, `vq:f:${f.id}`)]);
  const last = [];
  if (folders.length) last.push(btn(`📋 All (${quizzes.length})`, "vq:all"));
  last.push(btn("➕ Add folder", "vq:nf"), homeBtn);
  rows.push(last);
  return showLines(c, uid, lines, kb(...rows), query);
}

async function showAll(c, uid, query) {
  const quizzes = await c.db.listQuizzes(uid);
  return showLines(c, uid, [`📋 All your quizzes (${quizzes.length})`, "", ...quizLines(c, quizzes)], kb([back()]), query);
}

async function showFolder(c, uid, folder, query) {
  const quizzes = (await c.db.listQuizzes(uid)).filter((q) => q.folder_id === folder.id);
  const lines = [`📁 ${folder.name}`, "", ...(quizzes.length ? quizLines(c, quizzes) : ["This folder is empty."])];
  const f = folder.id;
  return showLines(c, uid, lines, kb(
    [btn("➕ Add quiz", `vq:add:${f}`), btn("➖ Remove quiz", `vq:rm:${f}`)],
    [btn("🗑 Delete quiz", `vq:dl:${f}`), btn("✏️ Rename", `vq:rn:${f}`)],
    [btn("📤 Share folder", `vq:sh:${f}`), btn("⬆️ Export folder", `vq:ex:${f}`)],
    [btn("🗑 Delete folder", `vq:df:${f}`), back()]), query);
}

async function showAdd(c, uid, folder, query) {
  const quizzes = (await c.db.listQuizzes(uid)).filter((q) => q.folder_id !== folder.id);
  const names = new Map((await c.db.listFolders(uid)).map((f) => [f.id, f.name]));
  const lines = [`➕ Add quizzes to 📁 ${folder.name}`, ""];
  if (quizzes.length) {
    lines.push("Tap the command under a quiz to put it in this folder. I react with 👍 to every quiz that was added. Press Done when you're finished.", "");
    quizzes.forEach((q, i) => lines.push(`${i + 1}. ${q.name}${names.has(q.folder_id) ? `  (now in 📁 ${names.get(q.folder_id)})` : ""}`, `/addq_${folder.id}_${q.id}`, ""));
  } else lines.push("All your quizzes are already in this folder.");
  return showLines(c, uid, lines, kb([btn("✅ Done", `vq:f:${folder.id}`)]), query);
}

/** Pick one quiz of a folder: used by "Remove quiz" and "Delete quiz". */
async function showPick(c, uid, folder, query, mode) {
  const quizzes = (await c.db.listQuizzes(uid)).filter((q) => q.folder_id === folder.id);
  const text = mode === "rm" ? `➖ Tap a quiz to take it out of 📁 ${folder.name} (it is not deleted).` : `🗑 Tap a quiz of 📁 ${folder.name} to delete it for good.`;
  const rows = quizzes.map((q) => [btn(`${mode === "rm" ? "➖" : "🗑"} ${q.name.slice(0, 40)}`, mode === "rm" ? `vq:rmq:${folder.id}:${q.id}` : `dq:${q.id}`)]);
  rows.push([btn("✅ Done", `vq:f:${folder.id}`)]);
  return c.show(uid, quizzes.length ? text : "This folder is empty.", kb(...rows), query);
}

export async function folderViewCallback(c, query) {
  const uid = query.from.id, parts = (query.data || "").split(":"), a = parts[1] || "";
  const folderOf = async () => {
    const f = parts[2] && /^\d+$/.test(parts[2]) ? await c.db.getFolder(Number(parts[2])) : null;
    return f && f.owner_id === uid ? f : null;
  };
  if (a === "nf") {
    const err = await beginFolderFlow(c, uid);
    return c.tg.answerCallback(query.id, err || undefined, !!err);
  }
  await c.tg.answerCallback(query.id);
  if (a === "all") return showAll(c, uid, query);
  if (a === "home") return showQuizHome(c, uid, query);
  const f = await folderOf();
  if (!f) return showQuizHome(c, uid, query);
  if (a === "f") return showFolder(c, uid, f, query);
  if (a === "add") return showAdd(c, uid, f, query);
  if (a === "rm" || a === "dl") return showPick(c, uid, f, query, a);
  if (a === "rmq") { const q = await c.db.quizHead(parts[3]); if (q && q.owner_id === uid) await c.db.removeFromFolder(q.id); return showPick(c, uid, f, query, "rm"); }
  if (a === "rn") {
    const blocked = await busyText(c, uid);
    if (blocked) return c.send(uid, blocked);
    return startFlow(c, uid, "frename", { folderId: f.id }, `✏️ <b>Rename</b> 📁 ${esc(f.name)}\n\nSend the new name (max ${MAX_FOLDER_NAME_LEN} characters).`);
  }
  if (a === "sh") {
    const quizzes = (await c.db.listQuizzes(uid)).filter((q) => q.folder_id === f.id);
    return showLines(c, uid, [`📁 ${f.name} – ${plural(quizzes.length, "quiz")}`, "", ...quizLines(c, quizzes), "", "Forward this message to share the folder."], kb([btn("⬅️ Folder", `vq:f:${f.id}`)]), null);
  }
  if (a === "ex") return exportToChat(c, uid, { folderId: f.id }, `folder-${slug(f.name)}`);
  if (a === "df") {
    return c.show(uid, `⚠️ Delete 📁 ${f.name} and all ${f.n} of its quizzes?\n\nYou can also use “Unfolder”: it removes only the folder (and /unfolder does the same for several folders) and keeps every quiz.`,
      kb([btn("🗑 Yes, delete it", `vq:dfy:${f.id}`)], [btn("📂 Unfolder instead", `vq:dfu:${f.id}`)], [btn("❌ Cancel", `vq:f:${f.id}`)]), query);
  }
  if (a === "dfy") { const n = await c.db.deleteFolderWithQuizzes(f.id, uid); await c.show(uid, `🗑 Folder deleted with ${plural(Math.max(0, n), "quiz")}.`, kb([back()]), query); return; }
  if (a === "dfu") { await c.db.deleteFolder(f.id, uid); return c.show(uid, `📂 Folder “${f.name}” removed. Its quizzes are all still there.`, kb([back()]), query); }
}

export async function addqCommand(c, msg) {
  const uid = msg.from.id, m = (msg.text || "").match(/^\/addq_(\d+)_([a-z0-9]+)/);
  const folder = m ? await c.db.getFolder(Number(m[1])) : null, head = m ? await c.db.quizHead(m[2]) : null;
  if (!folder || folder.owner_id !== uid || !head || head.owner_id !== uid) return c.send(uid, "I couldn't find that quiz or folder among yours. Open My quizzes to start again.");
  await c.db.setQuizFolder(head.id, folder.id);
  try { await c.tg.call("setMessageReaction", { chat_id: uid, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "👍" }] }); }
  catch { await c.send(uid, `✅ “${head.name}” is now in 📁 ${folder.name}.`); }
}

// ------------------------------------------------------------- folders
export async function beginFolderFlow(c, uid, { quizId = null, originId = null } = {}) {
  const blocked = await busyText(c, uid);
  if (blocked) return blocked;
  const lim = await c.limits(uid), folders = await c.db.listFolders(uid);
  if (folders.length >= lim.folders) return `You already have ${lim.folders} folders, which is the limit.${lim.paid ? "" : " ✨ Premium raises it."} Remove one with /unfolder first.`;
  const head = folders.length ? "📁 Your folders:\n" + folders.map((f) => `• ${esc(f.name)}`).join("\n") : "📁 You don't have any folders yet.";
  await startFlow(c, uid, "folder", { quizId, originId }, `${head}\n\nSend the name for the new folder.`);
  return null;
}

export async function folderText(c, flow, msg) {
  const uid = flow.userId, d = flow.data, name = (msg.text || "").replace(/\s+/g, " ").trim();
  if (flow.kind === "frename") {
    if (!name || name.length > MAX_FOLDER_NAME_LEN) return c.send(uid, `Please send a name between 1 and ${MAX_FOLDER_NAME_LEN} characters.`);
    const other = await c.db.findFolderByName(uid, name);
    if (other && other.id !== d.folderId) return c.send(uid, `You already have a folder called “${name}”. Send a different name.`);
    await c.db.renameFolder(d.folderId, uid, name); await endFlow(c, flow);
    const f = await c.db.getFolder(d.folderId);
    return f && showFolder(c, uid, f, null);
  }
  if (!name || name.length > MAX_FOLDER_NAME_LEN) return c.send(uid, `Please send a name between 1 and ${MAX_FOLDER_NAME_LEN} characters.`);
  if (await c.db.findFolderByName(uid, name)) return c.send(uid, `You already have a folder called “${name}”. Send a different name.`);
  const folderId = await c.db.createFolder(uid, name);
  await endFlow(c, flow);
  const head = d.quizId ? await c.db.quizHead(d.quizId) : null;
  if (head && head.owner_id === uid) {
    await c.db.setQuizFolder(head.id, folderId);
    if (d.originId) await c.tg.editMarkup(uid, d.originId, kb([folderButton(c.db, { name }, head.id)], [btn("⚙️ Edit this quiz", `eq:${head.id}`)])).catch(() => {});
    return c.send(uid, `📁 Folder “${name}” created, and “${head.name}” is in it.`);
  }
  return showAdd(c, uid, await c.db.getFolder(folderId), null);
}

/** Buttons under "Quiz created": afl / af / afn / afb. */
export async function folderPickCallback(c, query) {
  const uid = query.from.id, parts = query.data.split(":"), action = parts[0], quizId = parts[1];
  const head = await c.db.quizHead(quizId);
  if (!head || head.owner_id !== uid) return c.tg.answerCallback(query.id, "That quiz no longer exists.", true);
  const origin = query.message.message_id;
  const baseRows = async () => {
    const folder = await c.db.quizFolder(quizId);
    return [[folderButton(c.db, folder, quizId)], [btn("⚙️ Edit this quiz", `eq:${quizId}`)]];
  };
  if (action === "afl") {
    const rows = (await c.db.listFolders(uid)).map((f) => [btn(`📁 ${f.name}`, `af:${quizId}:${f.id}`)]);
    rows.push([btn("➕ New folder", `afn:${quizId}`)], [btn("↩️ Back", `afb:${quizId}`)]);
    await c.tg.answerCallback(query.id);
    return c.tg.editMarkup(uid, origin, kb(...rows));
  }
  if (action === "afb") { await c.tg.answerCallback(query.id); return c.tg.editMarkup(uid, origin, kb(...(await baseRows()))); }
  if (action === "afn") {
    const err = await beginFolderFlow(c, uid, { quizId, originId: origin });
    return c.tg.answerCallback(query.id, err || undefined, !!err);
  }
  const f = parts[2] && /^\d+$/.test(parts[2]) ? await c.db.getFolder(Number(parts[2])) : null;
  if (!f || f.owner_id !== uid) return c.tg.answerCallback(query.id, "That folder no longer exists.", true);
  await c.db.setQuizFolder(quizId, f.id);
  await c.tg.answerCallback(query.id, `Added to ${f.name}`);
  return c.tg.editMarkup(uid, origin, kb(...(await baseRows())));
}

const unfolderKb = (folders) => kb(...folders.map((f) => [btn(`❌ ${f.name} (${f.n})`, `uf:${f.id}`)]), [btn("✅ Done", "ufd")]);
export async function showUnfolder(c, uid) {
  const folders = await c.db.listFolders(uid);
  if (!folders.length) return c.send(uid, "You don't have any folders. Use ➕ Add folder in My quizzes to make one.");
  return c.send(uid, "🗑 Tap a folder to remove it. The quizzes in it are not deleted; they just are not in a folder any more.\n\nPress Done when you're finished.", { kb: unfolderKb(folders) });
}
export async function unfolderCallback(c, query) {
  const uid = query.from.id;
  if (query.data === "ufd") { await c.tg.answerCallback(query.id); return c.show(uid, "✅ Done.", null, query); }
  const id = Number(query.data.split(":")[1]), f = await c.db.getFolder(id);
  if (!f || f.owner_id !== uid || !(await c.db.deleteFolder(id, uid))) await c.tg.answerCallback(query.id, "That folder was already removed.");
  else await c.tg.answerCallback(query.id, `Removed ${f.name}`);
  const folders = await c.db.listFolders(uid);
  if (!folders.length) return c.show(uid, "✅ All folders are removed. Your quizzes are all still there.", null, query);
  return c.tg.editMarkup(uid, query.message.message_id, unfolderKb(folders));
}

// ------------------------------------------------------------- editing
export async function showEditList(c, uid, query = null) {
  const quizzes = await c.db.listQuizzes(uid);
  if (!quizzes.length) return c.show(uid, "You haven't created any quizzes yet.", kb([btn("📝 Create a quiz", "m:q_create")], [homeBtn]), query);
  const rows = quizzes.slice(0, 50).map((q) => [btn(`${q.name.slice(0, 40)} (${q.n})`, `eq:${q.id}`)]);
  rows.push([homeBtn]);
  return c.show(uid, "✏️ Tap a quiz to edit it:" + (quizzes.length > 50 ? "\n(showing the first 50; use /editquiz_<id> for others)" : ""), kb(...rows), query);
}

export async function showQuizMenu(c, uid, quizId, query = null) {
  const head = await c.db.quizHead(quizId);
  if (!head || head.owner_id !== uid) return c.show(uid, "I couldn't find that quiz among yours.", kb([btn("⬅️ My quizzes", "m:q_edit")]), query);
  const rows = [
    [btn("➕ Add questions", `eqa:${quizId}`), btn("🔄 Replace quiz", `eqr:${quizId}`)],
    [btn("✏️ Rename", `eqn:${quizId}`), btn("📝 Description", `eqd:${quizId}`)],
    [btn("⚙️ Settings", `eqs:${quizId}`), btn("🏆 Leaderboard", `lb:${quizId}`)],
    [btn("👥 Start in group", `gr:${quizId}`), btn("📢 Start in channel", `cr2:${quizId}`)],
  ];
  if (c.env.PAGES_URL && !c.env.PAGES_URL.includes("YOURNAME")) rows.unshift([webBtn("🧩 Edit / delete / search questions", c.appUrl(quizId))]);
  rows.push([btn("⬆️ Export", `xp:qq:${quizId}`), btn("🗑 Delete quiz", `dq:${quizId}`)], [btn("⬅️ Quizzes", "m:q_edit"), homeBtn]);
  const text = `✏️ <b>${esc(head.name)}</b>${head.src_id ? " (clone)" : ""}\nQuestions: ${head.n_questions} · Timer: ${formatLimit(head.settings.time)}\n${esc(c.link(quizId))}`;
  return c.show(uid, text, kb(...rows), query, true);
}

export async function editCallback(c, query) {
  const uid = query.from.id, [a, id] = query.data.split(":");
  await c.tg.answerCallback(query.id);
  if (a === "eq") return showQuizMenu(c, uid, id, query);
  if (a === "eqa") return beginAdd(c, uid, id);
  if (a === "eqr") return beginReplace(c, uid, id);
  if (a === "eqn") return beginText(c, uid, id, "qname");
  if (a === "eqd") return beginText(c, uid, id, "qdesc");
  if (a === "eqs") return beginQuizSettings(c, uid, id);
}

/** /editquiz_<id> */
export async function editQuizCommand(c, msg) {
  const m = (msg.text || "").match(/^\/editquiz_([a-z0-9]+)/);
  return showQuizMenu(c, msg.from.id, m ? m[1] : "", null);
}

/** dq: ask / dqy: delete / dqn: keep */
export async function deleteCallback(c, query) {
  const uid = query.from.id, [action, quizId] = query.data.split(":");
  const head = await c.db.quizHead(quizId);
  if (!head || head.owner_id !== uid) { await c.tg.answerCallback(query.id, "That quiz no longer exists.", true); return c.tg.editMarkup(uid, query.message.message_id, null); }
  await c.tg.answerCallback(query.id);
  if (action === "dq") return c.show(uid, `⚠️ Delete “${head.name}”?\n\nThe quiz and its link are gone for good. This can't be undone.`,
    kb([btn("🗑 Yes, delete it", `dqy:${quizId}`), btn("↩️ No, keep it", `dqn:${quizId}`)]), query);
  if (action === "dqn") return showQuizMenu(c, uid, quizId, query);
  await c.db.deleteQuiz(quizId, uid);
  return c.show(uid, `🗑 “${head.name}” was deleted.`, kb([btn("⬅️ My quizzes", "m:q_view"), homeBtn]), query);
}

// -------------------------------------------------------------- history
export async function showHistory(c, uid, query = null, offset = 0) {
  const rows = await c.db.history(uid, 12, offset), more = rows.length > 12, items = rows.slice(0, 12);
  if (!items.length) return c.show(uid, "📜 You haven't taken any quiz yet. Open a quiz link to take one.", kb([homeBtn]), query);
  const lines = ["📜 Quizzes you took", ""];
  items.forEach((a) => {
    const date = new Date(a.created_at * 1000).toISOString().slice(0, 10);
    lines.push(`• ${a.quiz_name} – ${fmtMarks(a.score)}/${a.total}${a.passed === 1 ? " ✅" : a.passed === 0 ? " ❌" : ""} · ${date}${a.n > 1 ? ` · attempt ${a.n}` : ""}\n  ${c.link(a.quiz_id)}`);
  });
  const nav = [];
  if (offset > 0) nav.push(btn("◀️ Newer", `hs:${Math.max(0, offset - 12)}`));
  if (more) nav.push(btn("Older ▶️", `hs:${offset + 12}`));
  return showLines(c, uid, lines, kb(nav, [homeBtn]), query);
}

export async function leaderboardCallback(c, query) {
  const uid = query.from.id, id = query.data.split(":")[1];
  const head = await c.db.quizHead(id);
  await c.tg.answerCallback(query.id);
  if (!head) return c.send(uid, "That quiz no longer exists.");
  const rows = await c.db.leaderboard(id, 10), medals = ["🥇", "🥈", "🥉"];
  const text = `🏆 <b>${esc(head.name)}</b>\n\n` + (rows.length ? rows.map((r, i) => `${medals[i] || i + 1 + "."} ${esc(r.name)} – ${fmtMarks(r.marks)}`).join("\n") : "Nobody has taken this quiz yet.");
  return c.send(uid, text, { html: true });
}

// --------------------------------------------------------------- review
const REVIEW_PAGE = 5;
export async function showReviewHome(c, uid, query = null) {
  const [p, r] = await Promise.all([c.db.countReviews(uid, "pending"), c.db.countReviews(uid, "resolved")]);
  return c.show(uid, "📝 <b>Review</b>\nQuestions you saved from your results.\n\n🧪 Sandbox: practise your pending mistakes – every one you get right moves to resolved.",
    kb([btn(`📌 Pending (${p})`, "rv:p:0"), btn(`✅ Resolved (${r})`, "rv:r:0")], [btn("🧪 Sandbox", "rv:sb")], [homeBtn]), query, true);
}

async function showReviewList(c, uid, status, page, query) {
  const { items, more } = await c.db.listReviews(uid, status, REVIEW_PAGE, page * REVIEW_PAGE);
  if (!items.length && page === 0) return c.show(uid, status === "pending" ? "📌 No pending mistakes. Save some with “💾 Save mistakes” under your results." : "✅ Nothing resolved yet.", kb([btn("⬅️ Review", "rv:home")]), query);
  const blocks = items.map((it) => {
    const q = it.question;
    const text = reviewBlock(q.text, q.correct.map((i) => q.options[i]));
    return `<i>${esc(it.quiz_name || "")}</i>\n${quoteHtml(text)}\n${status === "pending" ? `/rvok_${it.id}` : `/rvback_${it.id}`}  ·  /rvdel_${it.id}`;
  });
  const nav = [];
  if (page > 0) nav.push(btn("◀️", `rv:${status[0]}:${page - 1}`));
  if (more) nav.push(btn("▶️", `rv:${status[0]}:${page + 1}`));
  const rows = [nav, status === "pending" ? [btn("✅ Resolve this page", `rv:ok:${page}`), btn("🧪 Sandbox", "rv:sb")] : [], [btn("🗑 Clear all", `rv:clr:${status}`), btn("⬅️ Review", "rv:home")]];
  return c.show(uid, `${status === "pending" ? "📌 Pending" : "✅ Resolved"} – page ${page + 1}\n\n${blocks.join("\n\n")}`.slice(0, 4000), kb(...rows), query, true);
}

export async function reviewCallback(c, query, startSandbox) {
  const uid = query.from.id, parts = query.data.split(":"), a = parts[1];
  await c.tg.answerCallback(query.id);
  if (a === "home") return showReviewHome(c, uid, query);
  if (a === "p" || a === "r") return showReviewList(c, uid, a === "p" ? "pending" : "resolved", Number(parts[2]) || 0, query);
  if (a === "ok") {
    const { items } = await c.db.listReviews(uid, "pending", REVIEW_PAGE, (Number(parts[2]) || 0) * REVIEW_PAGE);
    await c.db.setReviewStatus(uid, items.map((i) => i.id), "resolved");
    return showReviewList(c, uid, "pending", 0, query);
  }
  if (a === "clr") { await c.db.deleteReviews(uid, parts[2] === "resolved" ? "resolved" : "pending"); return showReviewHome(c, uid, query); }
  if (a === "sb") return startSandbox(c, uid);
}

/** /rvok_12 /rvback_12 /rvdel_12 */
export async function reviewCommand(c, msg) {
  const uid = msg.from.id, m = (msg.text || "").match(/^\/rv(ok|back|del)_(\d+)/);
  if (!m) return;
  const id = Number(m[2]);
  if (m[1] === "del") await c.db.deleteReview(uid, id); else await c.db.setReviewStatus(uid, [id], m[1] === "ok" ? "resolved" : "pending");
  try { await c.tg.call("setMessageReaction", { chat_id: uid, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: "👍" }] }); } catch { await c.send(uid, "Done."); }
}

export async function saveMistakes(c, query) {
  const uid = query.from.id, set = await c.db.getRetrySet(query.data.split(":")[1]);
  if (!set || set.user_id !== uid) return c.tg.answerCallback(query.id, "This button has expired.", true);
  const n = await c.db.addReviews(uid, set.quiz_id, set.name.replace(/ – wrong & skipped$/, ""), set.items.map((i) => i.q));
  return c.tg.answerCallback(query.id, n ? `Saved ${plural(n, "question")} to Review → Pending.` : "Already saved.", true);
}

// ------------------------------------------------- backup / export / import
async function exportToChat(c, uid, only, name) {
  const { folders, items } = await c.db.exportUser(uid, only);
  if (!items.length && !folders.length) return c.send(uid, "There's nothing to export.");
  const now = new Date(), preset = only.folderId || only.quizId ? null : await c.db.getPreset(uid);
  const text = buildBackup(folders, items, now.toISOString().slice(0, 16).replace("T", " ") + " UTC", preset);
  await c.tg.sendDocument(uid, `quizbot-${name}-${now.toISOString().slice(0, 10)}.txt`, text,
    `💾 ${plural(items.length, "quiz")} and ${plural(folders.length, "folder")}, with their links and settings. To restore it, use Home → Import and send this file.`);
}

export async function showBackup(c, uid, query = null) {
  const prem = (await c.limits(uid)).encrypted;
  return c.show(uid, "🔃 <b>Backup</b>\n\n📄 Plain backup: a readable text file with all your quizzes, folders and settings.\n🔐 Encrypted backup: you pick a password in your browser; the password never reaches the bot." + (prem ? "" : "\n(🔒 premium)"),
    kb([btn("📄 Plain backup", "bk:plain")], [btn(`${prem ? "" : "🔒 "}🔐 Encrypted backup`, "bk:enc")], [homeBtn]), query, true);
}

export async function backupCallback(c, query) {
  const uid = query.from.id, a = query.data.split(":")[1];
  if (a === "plain") { await c.tg.answerCallback(query.id); return exportToChat(c, uid, {}, "backup"); }
  if (!(await c.limits(uid)).encrypted) return c.tg.answerCallback(query.id, lockedAlert, true);
  if (!c.env.PAGES_URL || c.env.PAGES_URL.includes("YOURNAME")) return c.tg.answerCallback(query.id, "The web pages are not set up yet (PAGES_URL).", true);
  await c.tg.answerCallback(query.id);
  const token = await c.db.createToken(uid, "vault-encrypt");
  const url = `${c.env.PAGES_URL.replace(/\/$/, "")}/vault.html?mode=encrypt&t=${token}&api=${encodeURIComponent(c.origin)}`;
  return c.send(uid, "🔐 Open the page, type a password and press Encrypt. The encrypted file is then sent to you here. The link works for 15 minutes.", { kb: kb([webBtn("🔐 Open encryption page", url)]) });
}

export async function showExport(c, uid, query = null) {
  return c.show(uid, "⬆️ <b>Export</b> – what do you want to export? (The file can be restored with Import.)",
    kb([btn("📚 A quiz", "xp:q"), btn("📁 A folder", "xp:f")], [btn("💾 Everything (backup)", "xp:b")], [homeBtn]), query, true);
}

export async function exportCallback(c, query) {
  const uid = query.from.id, parts = query.data.split(":"), a = parts[1];
  await c.tg.answerCallback(query.id);
  if (a === "b") return exportToChat(c, uid, {}, "backup");
  if (a === "qq") { const h = await c.db.quizHead(parts[2]); if (h && h.owner_id === uid) return exportToChat(c, uid, { quizId: h.id }, `quiz-${slug(h.name)}`); return; }
  if (a === "ff") { const f = await c.db.getFolder(Number(parts[2])); if (f && f.owner_id === uid) return exportToChat(c, uid, { folderId: f.id }, `folder-${slug(f.name)}`); return; }
  if (a === "f") {
    const folders = await c.db.listFolders(uid);
    if (!folders.length) return c.show(uid, "You don't have any folders.", kb([btn("⬅️ Export", "m:exp")]), query);
    return c.show(uid, "📁 Choose a folder to export:", kb(...folders.map((f) => [btn(`📁 ${f.name} (${f.n})`, `xp:ff:${f.id}`)]), [btn("⬅️ Export", "m:exp")]), query);
  }
  if (a === "q") {   // the foldered list, as in My quizzes
    const quizzes = await c.db.listQuizzes(uid), folders = await c.db.listFolders(uid);
    if (!quizzes.length) return c.show(uid, "You haven't created any quizzes yet.", kb([btn("⬅️ Export", "m:exp")]), query);
    const rows = [];
    if (parts[2] && /^\d+$/.test(parts[2])) {
      const fid = Number(parts[2]);
      quizzes.filter((q) => q.folder_id === fid).forEach((q) => rows.push([btn(`⬆️ ${q.name.slice(0, 40)}`, `xp:qq:${q.id}`)]));
      rows.push([btn("⬅️ Back", "xp:q")]);
    } else {
      quizzes.filter((q) => q.folder_id === null).forEach((q) => rows.push([btn(`⬆️ ${q.name.slice(0, 40)}`, `xp:qq:${q.id}`)]));
      folders.forEach((f) => rows.push([btn(`📁 ${f.name} (${f.n})`, `xp:q:${f.id}`)]));
      rows.push([btn("⬅️ Export", "m:exp")]);
    }
    return c.show(uid, "📚 Choose a quiz to export:", kb(...rows), query);
  }
}

export async function beginImport(c, uid) {
  const blocked = await busyText(c, uid);
  if (blocked) return c.send(uid, blocked);
  return startFlow(c, uid, "import", { waiting: true, entries: [], total: 0, done: 0, skipped: 0 },
    "📥 <b>Import</b>\n\nSend me one of these:\n\n• A backup or export file (the .txt file). Everything in it is restored, with the same links.\n\n• An encrypted backup (.json) from 🔐 Encrypted backup – I'll give you a page to decrypt it.\n\n" +
    "• A list, one per line: <code>Quiz name: link</code> (the participation link, or just the identifier after start=q_). I then ask for the questions of each quiz in turn, and every quiz gets the link you wrote down.\n\nSend it as a message or a .txt file. Use /skip to leave a listed quiz out.");
}

async function importInput(c, flow, text) {
  const uid = flow.userId, d = flow.data, lim = await c.limits(uid);
  if (looksLikeVault(text)) {
    if (!c.env.PAGES_URL || c.env.PAGES_URL.includes("YOURNAME")) return c.send(uid, "The web pages are not set up yet (PAGES_URL).");
    const token = await c.db.createToken(uid, "vault-decrypt", { ciphertext: text });
    const url = `${c.env.PAGES_URL.replace(/\/$/, "")}/vault.html?mode=decrypt&t=${token}&api=${encodeURIComponent(c.origin)}`;
    await endFlow(c, flow);
    return c.send(uid, "🔐 That file is encrypted. Open the page, type the password, and the backup is restored automatically. The link works for 15 minutes.", { kb: kb([webBtn("🔓 Open decryption page", url)]) });
  }
  if (looksLikeBackup(text)) {
    await sendAsset(c, uid, "loading");
    const rep = await restoreBackup(c.db, uid, parseBackup(text), { maxQuizzes: lim.quizzes, maxFolders: lim.folders });
    await endFlow(c, flow);
    return c.send(uid, formatRestoreReport(rep), { kb: kb([btn("📚 My quizzes", "m:q_view")]) });
  }
  const { entries, problems } = parseImportList(text, MAX_NAME_LEN);
  const usable = [];
  for (const [name, id] of entries) {
    const owner = await c.db.quizOwner(id);
    if (owner === null) usable.push([name, id]);
    else problems.push(owner === uid ? `• “${name}”: you already have a quiz with that link.` : `• “${name}”: that link is already used by someone else.`);
  }
  const room = Math.max(0, lim.quizzes - (await c.db.countQuizzes(uid)));
  if (usable.length > room) { problems.push(`• ${usable.length - room} more left out: you can have at most ${lim.quizzes} quizzes.`); usable.length = room; }
  const pt = problems.length ? "\n\n⚠️ Skipped:\n" + problems.slice(0, 10).join("\n") + (problems.length > 10 ? `\n…and ${problems.length - 10} more.` : "") : "";
  if (!usable.length) return c.send(uid, "I couldn't find a quiz to import in that." + pt + "\n\nSend a corrected list or a backup file, or press Cancel.");
  d.waiting = false; d.entries = usable; d.total = usable.length;
  await c.db.saveFlow(flow);
  await c.send(uid, `📥 I'll recreate ${plural(usable.length, "quiz")}, one at a time. Send /skip to leave one out.${pt}`, { flow });
  return nextImport(c, flow);
}

/** Asks for the questions of the next quiz of a list import by starting an ordinary create flow with a fixed id. */
async function nextImport(c, flow) {
  const uid = flow.userId, d = flow.data;
  if (!d.entries.length) {
    await endFlow(c, flow);
    return c.send(uid, `📥 Import finished: ${d.done} of ${d.total} quizzes created.${d.skipped ? ` ${d.skipped} skipped.` : ""}`, { kb: kb([btn("📚 My quizzes", "m:q_view")]) });
  }
  const [name, id] = d.entries[0];
  d.stage = "questions"; d.current = { name, id };
  await c.db.saveFlow(flow);
  await c.send(uid, `📥 Quiz ${d.done + d.skipped + 1} of ${d.total}: “${name}”\nIt will get this link:\n${c.link(id)}\n\nNow send its questions (text or .txt). /skip leaves it out; /quesdone finishes it.`, { flow });
}

export async function importText(c, flow, msg) {
  const d = flow.data, text = (msg.text || "").trim();
  if (d.waiting) return importInput(c, flow, msg.text || "");
  if (text === "/quesdone") return importQuizDone(c, flow);
  const res = (await import("./qparser.js")).parseQuestions(msg.text || "");
  d.pool = d.pool || [];
  res.questions.forEach((q) => d.pool.push(q.toData()));
  await c.db.saveFlow(flow);
  const errs = res.errors.slice(0, 5).map((e) => `• ${e.reason}`).join("\n");
  return c.send(uid(flow), `✅ ${d.pool.length} question(s) so far.${errs ? "\n⚠️ Skipped:\n" + errs : ""}\nSend more, or /quesdone.`, { flow });
}
const uid = (flow) => flow.userId;

export async function importDocument(c, flow, msg) {
  const doc = msg.document, d = flow.data;
  if (!((doc.file_name || "").toLowerCase().match(/\.(txt|json)$/) || doc.mime_type === "text/plain" || doc.mime_type === "application/json")) return c.send(flow.userId, "Please send a .txt file (or the .json encrypted backup).");
  if (doc.file_size && doc.file_size > MAX_BACKUP_BYTES) return c.send(flow.userId, `That file is too big (the limit is ${(MAX_BACKUP_BYTES / 1e6).toFixed(1)} MB).`);
  const text = await c.tg.downloadText(doc.file_id, MAX_BACKUP_BYTES);
  if (d.waiting) return importInput(c, flow, text);
  return importText(c, flow, { text });
}

async function importQuizDone(c, flow) {
  const d = flow.data, uid = flow.userId, cur = d.current;
  if (!cur || !d.pool || !d.pool.length) return c.send(uid, "I don't have any valid questions for this quiz yet. Send some, or /skip.");
  const preset = (await c.db.getPreset(uid)) || undefined;
  try {
    await c.db.createQuiz({ owner: uid, name: cur.name, settings: preset, questions: d.pool.map((x) => Question.fromData(x)), id: cur.id });
    d.done++;
  } catch { d.skipped++; await c.send(uid, "That quiz identifier is already taken, so this quiz was skipped.", { flow }); }
  d.entries.shift(); d.pool = []; d.current = null;
  await c.db.saveFlow(flow);
  return nextImport(c, flow);
}

export async function importSkip(c, flow) {
  const d = flow.data;
  if (!d.current) return c.send(flow.userId, "There's nothing to skip right now.");
  d.skipped++; d.entries.shift(); d.pool = []; d.current = null;
  await c.db.saveFlow(flow);
  await c.send(flow.userId, "⏭ Left out.", { flow });
  return nextImport(c, flow);
}

// ---------------------------------------------------- groups & channels
export async function showChats(c, uid, kind, query = null) {
  const chats = await c.db.listChats(uid, kind), noun = kind === "channel" ? "channel" : "group";
  const rows = chats.map((x) => [btn(`${kind === "channel" ? "📢" : "💬"} ${x.title || x.chat_id}`, `${kind === "channel" ? "ch" : "gp"}:s:${x.chat_id}`)]);
  rows.push([btn(`➕ Add ${noun}`, `${kind === "channel" ? "ch" : "gp"}:a`)], [homeBtn]);
  const text = kind === "channel"
    ? `📢 <b>Channels</b>\n\n${chats.length ? "Tap a channel to start a quiz there as its admin." : "No channel yet."}\nThe bot must be an admin of the channel (with permission to post). Polls in channels are anonymous, so there is no leaderboard there.`
    : `💬 <b>Groups</b>\n\n${chats.length ? "Tap a group to start a quiz there." : "No group yet."}\nIn any group where the bot is a member, anyone can also start a quiz with /quiz <i>id</i>.`;
  return c.show(uid, text, kb(...rows), query, true);
}

export async function chatCallback(c, query) {
  const uid = query.from.id, parts = query.data.split(":"), kind = parts[0] === "ch" ? "channel" : "group", a = parts[1];
  await c.tg.answerCallback(query.id);
  if (a === "l") return showChats(c, uid, kind, query);
  if (a === "a") {
    if (kind === "group") {
      return c.show(uid, "💬 <b>Add a group</b>\n\nTap the button, pick the group, and add the bot as a member. The group then appears in your list.",
        kb([urlBtn("➕ Add the bot to a group", `https://t.me/${c.bn}?startgroup=reg`)], [btn("⬅️ Groups", "gp:l")]), query, true);
    }
    const blocked = await busyText(c, uid);
    if (blocked) return c.send(uid, blocked);
    return startFlow(c, uid, "chadd", {}, "📢 <b>Add a channel</b>\n\n1. Add the bot to the channel as an administrator (permission: post messages).\n2. Forward any post of that channel to me, or send its @username.");
  }
  const chatId = Number(parts[2]);
  const chat = await c.db.getChat(uid, chatId);
  if (!chat) return showChats(c, uid, kind, query);
  if (a === "r") { await c.db.removeChat(uid, chatId); return showChats(c, uid, kind, query); }
  if (a === "s") {
    const quizzes = await c.db.listQuizzes(uid);
    const cmd = kind === "channel" ? "chq" : "gpq";
    const rows = quizzes.slice(0, 40).map((q) => [btn(`▶️ ${q.name.slice(0, 40)} (${q.n})`, `${cmd}:${chatId}:${q.id}`)]);
    rows.push([btn("🗑 Remove from my list", `${parts[0]}:r:${chatId}`)], [btn("⬅️ Back", `${parts[0]}:l`)]);
    return c.show(uid, `${kind === "channel" ? "📢" : "💬"} <b>${esc(chat.title || chatId)}</b>\n\nWhich quiz do you want to start there?`, kb(...(quizzes.length ? rows : [[btn("📝 Create a quiz", "m:q_create")], ...rows.slice(-2)])), query, true);
  }
}

export async function chatAddText(c, flow, msg) {
  const uid = flow.userId;
  let ref = null;
  if (msg.forward_origin && msg.forward_origin.type === "channel") ref = msg.forward_origin.chat.id;
  else if (msg.forward_from_chat) ref = msg.forward_from_chat.id;
  else if (msg.text && /^(@\w{4,}|-100\d+)$/.test(msg.text.trim())) ref = msg.text.trim();
  if (ref === null) return c.send(uid, "Forward a post from the channel, or send its @username.");
  try {
    const chat = await c.tg.call("getChat", { chat_id: ref });
    if (chat.type !== "channel") return c.send(uid, "That is not a channel.");
    const me = await c.tg.call("getChatMember", { chat_id: chat.id, user_id: (await c.tg.call("getMe")).id });
    if (me.status !== "administrator" || me.can_post_messages === false) return c.send(uid, "I'm not an admin there (or I can't post). Add me as an administrator with permission to post, then try again.");
    const you = await c.tg.call("getChatMember", { chat_id: chat.id, user_id: uid });
    if (!["administrator", "creator"].includes(you.status)) return c.send(uid, "You need to be an admin of that channel.");
    await c.db.addChat(uid, chat.id, "channel", chat.title);
    await endFlow(c, flow);
    return c.send(uid, `✅ “${chat.title}” added.`, { kb: kb([btn("📢 Channels", "ch:l")]) });
  } catch (e) {
    return c.send(uid, "I couldn't reach that channel. Make sure I'm an administrator there, then try again.");
  }
}
