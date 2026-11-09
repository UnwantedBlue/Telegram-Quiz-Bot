// D1 (SQLite) storage. Questions are rows of their own, so one question can be replaced, deleted or searched
// without rewriting the whole quiz. A clone quiz reads its questions from the quiz it was cloned from (src_id).
import { Question } from "./qparser.js";
import { normSettings, nowSec } from "./engine.js";

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";   // no look-alikes; safe inside /editquiz_<id> and deep links
export function newId(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

export class DB {
  constructor(d1) { this.d = d1; }
  prep(sql, ...a) { return this.d.prepare(sql).bind(...a); }
  first(sql, ...a) { return this.prep(sql, ...a).first(); }
  async all(sql, ...a) { return (await this.prep(sql, ...a).all()).results || []; }
  run(sql, ...a) { return this.prep(sql, ...a).run(); }
  async batch(stmts) { for (const part of chunks(stmts, 40)) await this.d.batch(part); }

  // ------------------------------------------------------------- users
  async upsertUser(u) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
    await this.run(
      "INSERT INTO users (id,name,username,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username",
      u.id, name, u.username || null, nowSec());
  }
  getUser(id) { return this.first("SELECT * FROM users WHERE id=?", id); }
  async premiumUntil(id) { return (await this.first("SELECT premium_until p FROM users WHERE id=?", id))?.p || 0; }
  async setPremium(id, until) {
    await this.run("INSERT INTO users (id,premium_until,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET premium_until=excluded.premium_until", id, until, nowSec());
  }
  async getPreset(id) {
    const r = await this.first("SELECT preset FROM users WHERE id=?", id);
    return r && r.preset ? normSettings(JSON.parse(r.preset)) : null;
  }
  async setPreset(id, settings) {
    await this.run("INSERT INTO users (id,preset,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET preset=excluded.preset", id, JSON.stringify(normSettings(settings)), nowSec());
  }

  // ----------------------------------------------------------- quizzes
  static head(r) {
    return r && { id: r.id, owner_id: r.owner_id, name: r.name, description: r.description, time_limit: r.time_limit,
      settings: normSettings(JSON.parse(r.settings || "{}")), src_id: r.src_id, n_questions: r.n_questions, price: r.price, qid: r.src_id || r.id };
  }
  async quizHead(id) { return DB.head(await this.first("SELECT * FROM quizzes WHERE id=?", id)); }
  async quizOwner(id) { return (await this.first("SELECT owner_id o FROM quizzes WHERE id=?", id))?.o ?? null; }
  async countQuizzes(owner) { return (await this.first("SELECT COUNT(*) n FROM quizzes WHERE owner_id=?", owner)).n; }

  async freeId() {
    for (;;) { const id = newId(); if (!(await this.first("SELECT 1 x FROM quizzes WHERE id=?", id))) return id; }
  }

  /** Save a new quiz. `id` is for /import (the quiz gets that identifier); throws if it is taken. `src` makes it a clone. */
  async createQuiz({ owner, name, description = "", settings, questions = [], id = null, src = null, price = 0 }) {
    const s = normSettings(settings), now = nowSec();
    const quizId = id || (await this.freeId());
    await this.run(
      "INSERT INTO quizzes (id,owner_id,name,description,time_limit,settings,src_id,n_questions,price,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      quizId, owner, name, description, s.time, JSON.stringify(s), src, src ? 0 : questions.length, price, now, now);
    if (src) await this.touchCount(src); else await this.addQuestions(quizId, questions, 0);
    return quizId;
  }

  async updateQuiz(id, owner, f) {
    const sets = [], vals = [];
    if (f.name !== undefined) { sets.push("name=?"); vals.push(f.name); }
    if (f.description !== undefined) { sets.push("description=?"); vals.push(f.description); }
    if (f.settings !== undefined) { const s = normSettings(f.settings); sets.push("settings=?", "time_limit=?"); vals.push(JSON.stringify(s), s.time); }
    if (f.price !== undefined) { sets.push("price=?"); vals.push(f.price); }
    if (!sets.length) return false;
    const r = await this.run(`UPDATE quizzes SET ${sets.join(",")}, updated_at=? WHERE id=? AND owner_id=?`, ...vals, nowSec(), id, owner);
    return r.meta.changes === 1;
  }

  /** Replace name, questions (and optionally settings/description) of a quiz the user owns. The id stays. */
  async replaceQuiz(id, owner, { name, settings, description, questions }) {
    const head = await this.quizHead(id);
    if (!head || head.owner_id !== owner) return false;
    const f = { name };
    if (settings) f.settings = settings;
    if (description !== undefined) f.description = description;
    await this.updateQuiz(id, owner, f);
    if (questions) {
      await this.run("DELETE FROM questions WHERE quiz_id=?", head.qid);
      await this.addQuestions(head.qid, questions, 0);
    }
    return true;
  }

  async deleteQuiz(id, owner) {
    const head = await this.quizHead(id);
    if (!head || head.owner_id !== owner) return false;
    const clones = await this.all("SELECT id FROM quizzes WHERE src_id=? ORDER BY created_at", id);
    if (!head.src_id && clones.length) {            // hand the questions to the first clone, so the others keep working
      const [first, ...rest] = clones.map((c) => c.id);
      await this.batch([
        this.prep("UPDATE questions SET quiz_id=? WHERE quiz_id=?", first, id),
        this.prep("UPDATE quizzes SET src_id=NULL WHERE id=?", first),
        ...rest.map((c) => this.prep("UPDATE quizzes SET src_id=? WHERE id=?", first, c)),
      ]);
    } else if (!head.src_id) await this.run("DELETE FROM questions WHERE quiz_id=?", id);
    await this.batch([this.prep("DELETE FROM quizzes WHERE id=?", id), this.prep("DELETE FROM quiz_folder WHERE quiz_id=?", id)]);
    if (head.src_id) await this.touchCount(head.src_id);
    return true;
  }

  async cloneQuiz(id, owner, { name, settings }) {
    const head = await this.quizHead(id);
    return this.createQuiz({ owner, name, description: head.description, settings, src: head.qid });
  }

  async listQuizzes(owner) {
    return this.all(
      "SELECT q.id,q.name,q.description,q.n_questions n,q.time_limit,q.src_id,q.price,m.folder_id FROM quizzes q LEFT JOIN quiz_folder m ON m.quiz_id=q.id WHERE q.owner_id=? ORDER BY q.created_at,q.rowid", owner);
  }

  touchCount(qid) {
    return this.run("UPDATE quizzes SET n_questions=(SELECT COUNT(*) FROM questions WHERE quiz_id=?1) WHERE id=?1 OR src_id=?1", qid);
  }

  // --------------------------------------------------------- questions
  static qStmt(db, qid, q, pos) {
    return db.prep("INSERT INTO questions (quiz_id,pos,text,search,data) VALUES (?,?,?,?,?)", qid, pos, q.text, q.searchText(), JSON.stringify(q.toData()));
  }
  async addQuestions(qid, qs, startPos = null) {
    if (startPos === null) startPos = ((await this.first("SELECT MAX(pos) m FROM questions WHERE quiz_id=?", qid)).m ?? -1) + 1;
    await this.batch(qs.map((q, i) => DB.qStmt(this, qid, q, startPos + i)));
    await this.touchCount(qid);
  }
  static qRow(r) { return Question.fromData(JSON.parse(r.data), r.id); }
  async getQuestions(qid) { return (await this.all("SELECT id,data FROM questions WHERE quiz_id=? ORDER BY pos", qid)).map(DB.qRow); }
  async getQuestion(qid, rowId) {
    const r = await this.first("SELECT id,pos,data FROM questions WHERE quiz_id=? AND id=?", qid, rowId);
    return r ? Object.assign(DB.qRow(r), { pos: r.pos }) : null;
  }
  /** Search by words in the question, options, explanation or description. term "" lists everything. */
  async searchQuestions(qid, term, limit = 30, offset = 0) {
    const words = term.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    const like = words.map(() => "search LIKE ? ESCAPE '\\'").join(" AND ");
    const args = words.map((w) => `%${w.replace(/[\\%_]/g, "\\$&")}%`);
    const rows = await this.all(
      `SELECT id,pos,text,data FROM questions WHERE quiz_id=?${like ? " AND " + like : ""} ORDER BY pos LIMIT ? OFFSET ?`, qid, ...args, limit + 1, offset);
    return { items: rows.slice(0, limit).map((r) => ({ id: r.id, pos: r.pos, text: r.text, question: DB.qRow(r) })), more: rows.length > limit };
  }
  async replaceQuestion(qid, rowId, q) {
    const r = await this.run("UPDATE questions SET text=?,search=?,data=? WHERE quiz_id=? AND id=?", q.text, q.searchText(), JSON.stringify(q.toData()), qid, rowId);
    return r.meta.changes === 1;
  }
  /** Delete one question; later ones move up. Returns the deleted Question (so it can be sent back as an undo). */
  async deleteQuestion(qid, rowId) {
    const old = await this.getQuestion(qid, rowId);
    if (!old) return null;
    await this.batch([this.prep("DELETE FROM questions WHERE quiz_id=? AND id=?", qid, rowId), this.prep("UPDATE questions SET pos=pos-1 WHERE quiz_id=? AND pos>?", qid, old.pos)]);
    await this.touchCount(qid);
    return old;
  }

  /** A quiz with everything needed to run it. */
  async quizFull(id) {
    const head = await this.quizHead(id);
    if (!head) return null;
    return { ...head, questions: await this.getQuestions(head.qid) };
  }

  // ----------------------------------------------------------- folders
  async listFolders(owner) {
    return this.all("SELECT f.id,f.owner_id,f.name,COUNT(m.quiz_id) n FROM folders f LEFT JOIN quiz_folder m ON m.folder_id=f.id WHERE f.owner_id=? GROUP BY f.id ORDER BY f.created_at,f.id", owner);
  }
  getFolder(id) {
    return this.first("SELECT f.id,f.owner_id,f.name,(SELECT COUNT(*) FROM quiz_folder m WHERE m.folder_id=f.id) n FROM folders f WHERE f.id=?", id);
  }
  async findFolderByName(owner, name) {
    const w = name.toLowerCase();
    return (await this.listFolders(owner)).find((f) => f.name.toLowerCase() === w) || null;
  }
  async createFolder(owner, name) { return (await this.run("INSERT INTO folders (owner_id,name,created_at) VALUES (?,?,?)", owner, name, nowSec())).meta.last_row_id; }
  async renameFolder(id, owner, name) { return (await this.run("UPDATE folders SET name=? WHERE id=? AND owner_id=?", name, id, owner)).meta.changes === 1; }
  /** Remove a folder; its quizzes are kept ("unfolder"). */
  async deleteFolder(id, owner) {
    const r = await this.run("DELETE FROM folders WHERE id=? AND owner_id=?", id, owner);
    if (r.meta.changes === 1) await this.run("DELETE FROM quiz_folder WHERE folder_id=?", id);
    return r.meta.changes === 1;
  }
  /** Remove a folder AND its quizzes. Returns how many quizzes were deleted. */
  async deleteFolderWithQuizzes(id, owner) {
    const f = await this.getFolder(id);
    if (!f || f.owner_id !== owner) return -1;
    const ids = (await this.all("SELECT quiz_id FROM quiz_folder WHERE folder_id=?", id)).map((r) => r.quiz_id);
    for (const q of ids) await this.deleteQuiz(q, owner);
    await this.deleteFolder(id, owner);
    return ids.length;
  }
  setQuizFolder(quizId, folderId) { return this.run("INSERT OR REPLACE INTO quiz_folder (quiz_id,folder_id) VALUES (?,?)", quizId, folderId); }
  removeFromFolder(quizId) { return this.run("DELETE FROM quiz_folder WHERE quiz_id=?", quizId); }
  quizFolder(quizId) { return this.first("SELECT f.id,f.owner_id,f.name FROM quiz_folder m JOIN folders f ON f.id=m.folder_id WHERE m.quiz_id=?", quizId); }

  /** Everything to back up: {folders:[names], items:[{quiz, folder}]}. only = {folderId} or {quizId} to export a part. */
  async exportUser(owner, only = {}) {
    let folders = await this.listFolders(owner);
    const names = new Map(folders.map((f) => [f.id, f.name]));
    let rows = await this.all("SELECT q.*,m.folder_id fid FROM quizzes q LEFT JOIN quiz_folder m ON m.quiz_id=q.id WHERE q.owner_id=? ORDER BY q.created_at,q.rowid", owner);
    if (only.folderId) { rows = rows.filter((r) => r.fid === only.folderId); folders = folders.filter((f) => f.id === only.folderId); }
    else if (only.quizId) { rows = rows.filter((r) => r.id === only.quizId); folders = []; }
    const cache = new Map(), items = [];
    for (const r of rows) {
      const head = DB.head(r);
      if (!cache.has(head.qid)) cache.set(head.qid, await this.getQuestions(head.qid));
      items.push({ quiz: { ...head, questions: cache.get(head.qid) }, folder: only.quizId ? null : names.get(r.fid) || null });
    }
    return { folders: folders.map((f) => f.name), items };
  }

  // ------------------------------------------------------- retry sets
  async saveRetrySet({ user, quizId, name, settings, items }) {
    let token;
    for (;;) { token = newId(); if (!(await this.first("SELECT 1 x FROM retry_sets WHERE token=?", token))) break; }
    await this.run("INSERT INTO retry_sets (token,user_id,quiz_id,name,time_limit,settings,data,created_at) VALUES (?,?,?,?,?,?,?,?)",
      token, user, quizId, name, settings.time, JSON.stringify(settings), JSON.stringify(items.map((i) => ({ q: i.q.toData(), w: i.wrong }))), nowSec());
    return token;
  }
  async getRetrySet(token) {
    const r = await this.first("SELECT * FROM retry_sets WHERE token=?", token);
    if (!r) return null;
    return { ...r, settings: normSettings(JSON.parse(r.settings)), msg_ids: JSON.parse(r.msg_ids), items: JSON.parse(r.data).map((i) => ({ q: Question.fromData(i.q), wrong: i.w || [] })) };
  }
  setRetryMsgs(token, ids) { return this.run("UPDATE retry_sets SET msg_ids=? WHERE token=?", JSON.stringify(ids), token); }

  // ---------------------------------------------------------- attempts
  addAttempt(a) {
    return this.run(
      "INSERT INTO attempts (quiz_id,quiz_name,user_id,user_name,username,taker_info,score,total,correct,wrong,skipped,elapsed,passed,n,mode,chat_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      a.quizId, a.quizName, a.userId, a.userName || null, a.username || null, a.takerInfo || null, a.score, a.total, a.correct, a.wrong, a.skipped,
      a.elapsed, a.passed === null || a.passed === undefined ? null : a.passed ? 1 : 0, a.n || 1, a.mode || "solo", a.chatId || null, nowSec());
  }
  async attemptCount(quizId, userId) { return (await this.first("SELECT COUNT(*) n FROM attempts WHERE quiz_id=? AND user_id=? AND mode IN ('solo','group')", quizId, userId)).n; }
  lastAttempt(quizId, userId) { return this.first("SELECT * FROM attempts WHERE quiz_id=? AND user_id=? AND mode IN ('solo','group') ORDER BY id DESC LIMIT 1", quizId, userId); }
  /** Rank among everybody who took the quiz (each person counts with their best attempt). */
  async rank(quizId, score, elapsed) {
    const r = await this.first(
      `WITH best AS (SELECT user_id, MAX(score) s, MIN(elapsed) e FROM attempts WHERE quiz_id=? AND mode IN ('solo','group') GROUP BY user_id)
       SELECT (SELECT COUNT(*) FROM best WHERE s>? OR (s=? AND e<?)) + 1 AS rank, (SELECT COUNT(*) FROM best) AS total`, quizId, score, score, elapsed);
    return { rank: r.rank, total: r.total };
  }
  leaderboard(quizId, limit = 10) {
    return this.all(
      `SELECT COALESCE(NULLIF(user_name,''), username, 'Anonymous') name, MAX(score) marks, MIN(elapsed) elapsed FROM attempts
       WHERE quiz_id=? AND mode IN ('solo','group') GROUP BY user_id ORDER BY marks DESC, elapsed ASC LIMIT ?`, quizId, limit);
  }
  history(userId, limit = 15, offset = 0) {
    return this.all("SELECT * FROM attempts WHERE user_id=? AND mode IN ('solo','group','retry') ORDER BY id DESC LIMIT ? OFFSET ?", userId, limit + 1, offset);
  }

  // ----------------------------------------------------------- reviews
  async addReviews(userId, quizId, quizName, qs) {
    const existing = new Set((await this.all("SELECT q FROM reviews WHERE user_id=? AND quiz_id=? AND status='pending'", userId, quizId)).map((r) => r.q));
    const stmts = [];
    for (const q of qs) {
      const data = JSON.stringify(q.toData());
      if (existing.has(data)) continue;
      existing.add(data);
      stmts.push(this.prep("INSERT INTO reviews (user_id,quiz_id,quiz_name,status,q,created_at) VALUES (?,?,?,?,?,?)", userId, quizId, quizName, "pending", data, nowSec()));
    }
    await this.batch(stmts);
    return stmts.length;
  }
  async countReviews(userId, status) { return (await this.first("SELECT COUNT(*) n FROM reviews WHERE user_id=? AND status=?", userId, status)).n; }
  async listReviews(userId, status, limit = 5, offset = 0) {
    const rows = await this.all("SELECT * FROM reviews WHERE user_id=? AND status=? ORDER BY id DESC LIMIT ? OFFSET ?", userId, status, limit + 1, offset);
    return { items: rows.slice(0, limit).map((r) => ({ ...r, question: Question.fromData(JSON.parse(r.q)) })), more: rows.length > limit };
  }
  async setReviewStatus(userId, ids, status) {
    if (!ids.length) return;
    await this.batch(ids.map((id) => this.prep("UPDATE reviews SET status=?, resolved_at=? WHERE id=? AND user_id=?", status, status === "resolved" ? nowSec() : null, id, userId)));
  }
  async pendingForPractice(userId, limit = 30) {
    const rows = await this.all("SELECT * FROM reviews WHERE user_id=? AND status='pending' ORDER BY RANDOM() LIMIT ?", userId, limit);
    return rows.map((r) => ({ id: r.id, question: Question.fromData(JSON.parse(r.q)) }));
  }
  deleteReviews(userId, status) { return this.run("DELETE FROM reviews WHERE user_id=? AND status=?", userId, status); }
  deleteReview(userId, id) { return this.run("DELETE FROM reviews WHERE user_id=? AND id=?", userId, id); }

  // ------------------------------------------------------------- flows
  async getFlow(userId) {
    const r = await this.first("SELECT * FROM flows WHERE user_id=?", userId);
    return r ? { userId, kind: r.kind, data: JSON.parse(r.data), msgs: JSON.parse(r.msgs) } : null;
  }
  saveFlow(f) {
    return this.run("INSERT INTO flows (user_id,kind,data,msgs,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind,data=excluded.data,msgs=excluded.msgs,updated_at=excluded.updated_at",
      f.userId, f.kind, JSON.stringify(f.data), JSON.stringify(f.msgs), nowSec());
  }
  delFlow(userId) { return this.run("DELETE FROM flows WHERE user_id=?", userId); }

  // --------------------------------------------------- polls and chats
  mapPoll(pollId, runKey) { return this.run("INSERT OR REPLACE INTO poll_map (poll_id,run_key,created_at) VALUES (?,?,?)", pollId, runKey, nowSec()); }
  async pollRun(pollId) { return (await this.first("SELECT run_key k FROM poll_map WHERE poll_id=?", pollId))?.k || null; }
  unmapPolls(ids) { return this.batch(ids.map((p) => this.prep("DELETE FROM poll_map WHERE poll_id=?", p))); }

  addChat(userId, chatId, kind, title) {
    return this.run("INSERT INTO user_chats (user_id,chat_id,kind,title,created_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id,chat_id) DO UPDATE SET title=excluded.title,kind=excluded.kind", userId, chatId, kind, title || "", nowSec());
  }
  listChats(userId, kind) { return this.all("SELECT * FROM user_chats WHERE user_id=? AND kind=? ORDER BY created_at", userId, kind); }
  getChat(userId, chatId) { return this.first("SELECT * FROM user_chats WHERE user_id=? AND chat_id=?", userId, chatId); }
  removeChat(userId, chatId) { return this.run("DELETE FROM user_chats WHERE user_id=? AND chat_id=?", userId, chatId); }

  async createPending({ quizId, chatId, kind, byUser, time = null }) {
    const token = newId(10);
    await this.run("INSERT INTO pending_starts (token,quiz_id,chat_id,kind,by_user,time_override,created_at) VALUES (?,?,?,?,?,?,?)", token, quizId, chatId, kind, byUser, time, nowSec());
    return token;
  }
  getPending(token) { return this.first("SELECT * FROM pending_starts WHERE token=?", token); }
  setPendingTime(token, t) { return this.run("UPDATE pending_starts SET time_override=? WHERE token=?", t, token); }
  delPending(token) { return this.run("DELETE FROM pending_starts WHERE token=?", token); }

  async createToken(userId, kind, data = null) {
    const token = newId(24);
    await this.run("INSERT INTO tokens (token,user_id,kind,data,created_at) VALUES (?,?,?,?,?)", token, userId, kind, data === null ? null : JSON.stringify(data), nowSec());
    return token;
  }
  async getToken(token, kind, maxAgeSec = 900) {
    const r = await this.first("SELECT * FROM tokens WHERE token=? AND kind=? AND created_at>=?", token, kind, nowSec() - maxAgeSec);
    return r ? { userId: r.user_id, data: r.data ? JSON.parse(r.data) : null } : null;
  }
  delToken(token) { return this.run("DELETE FROM tokens WHERE token=?", token); }

  // --------------------------------------------------- money, ads, misc
  addPurchase(userId, kind, ref, stars, chargeId) {
    return this.run("INSERT INTO purchases (user_id,kind,ref,stars,charge_id,created_at) VALUES (?,?,?,?,?,?)", userId, kind, ref, stars, chargeId || null, nowSec());
  }
  async hasPurchase(userId, kind, ref) { return !!(await this.first("SELECT 1 x FROM purchases WHERE user_id=? AND kind=? AND ref=?", userId, kind, ref)); }
  listAds() { return this.all("SELECT * FROM ads ORDER BY id"); }
  addAd(text, url) { return this.run("INSERT INTO ads (text,url) VALUES (?,?)", text, url || null); }
  delAd(id) { return this.run("DELETE FROM ads WHERE id=?", id); }
  randomAd() { return this.first("SELECT * FROM ads WHERE active=1 ORDER BY RANDOM() LIMIT 1"); }
  async kvGet(k) { return (await this.first("SELECT v FROM kv WHERE k=?", k))?.v ?? null; }
  kvSet(k, v) { return this.run("INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, String(v)); }

  /** Daily clean-up (cron). */
  async purge() {
    const t = nowSec(), day = 86400;
    await this.batch([
      this.prep("DELETE FROM poll_map WHERE created_at<?", t - 8 * day),
      this.prep("DELETE FROM retry_sets WHERE created_at<?", t - 60 * day),
      this.prep("DELETE FROM tokens WHERE created_at<?", t - day),
      this.prep("DELETE FROM pending_starts WHERE created_at<?", t - day),
      this.prep("DELETE FROM flows WHERE updated_at<?", t - 7 * day),
    ]);
  }
}
