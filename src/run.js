// One running quiz = one Durable Object (key "u:<user id>" for a person, "g:<chat id>" for a group or channel).
// Timers are DO alarms (they fire at the exact second); progress is saved after every step, so nothing is lost
// if the object is evicted. A free Worker can't sleep, so every wait is an alarm, never a setTimeout.
import { DurableObject } from "cloudflare:workers";
import { Tg, TgError, btn, kb, MEDIA_METHODS, userLabel } from "./tg.js";
import { DB } from "./db.js";
import { Question } from "./qparser.js";
import {
  AUTO_RETRY_SECONDS, CORRECT, SESSION_KEEP_HOURS, SKIPPED, WRONG, NEXT_DELAY_MS, TIMEOUT_GRACE_MS, REVIEW_TITLE, RETRY_SUFFIX,
  answersHidden, chunkBlocks, esc, formatDuration, grade, isExam, leaderboardHtml, questionOrder, quoteHtml, renderQuestion,
  reviewBlock, reviewOn, scoreOutcomes, shuffleOptions, summaryHtml, usesRegularPoll, shuffleArray,
} from "./engine.js";
import { maybeSponsor } from "./ads.js";

const RESEND_DELAYS = [5, 10, 15, 20];
const GROUP_DELAY_MS = 2000;
const REOPEN_BATCH = 8;

export class QuizRun extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tg = new Tg(env.BOT_TOKEN);
    this.db = new DB(env.DB);
    this.chain = Promise.resolve();
    this.loaded = false; this.ready = false;
    this.m = null; this.qs = null;
  }

  // ---------------------------------------------------------- storage
  _table() {
    if (!this.ready) { this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)"); this.ready = true; }
  }
  _get(k) { this._table(); const r = this.ctx.storage.sql.exec("SELECT v FROM kv WHERE k=?", k).toArray(); return r.length ? JSON.parse(r[0].v) : null; }
  _put(k, v) { this._table(); this.ctx.storage.sql.exec("INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, JSON.stringify(v)); }
  _load() {
    if (this.loaded) return;
    this.m = this._get("m");
    const qs = this._get("qs");
    this.qs = qs ? qs.map((d) => Question.fromData(d)) : null;
    this.loaded = true;
  }
  _save() { this._put("m", this.m); }
  async _wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.m = null; this.qs = null; this.loaded = true; this.ready = false;
  }
  _lock(fn) { const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p; }

  async _arm(kind, atMs, extra = {}) { this.m.alarm = { kind, at: atMs, ...extra }; await this.ctx.storage.setAlarm(atMs); }
  async _disarm() { this.m.alarm = null; await this.ctx.storage.deleteAlarm(); }

  get key() { return `${this.m.mode === "solo" ? "u" : "g"}:${this.m.chatId}`; }
  get total() { return this.m.order.length; }
  get s() { return this.m.settings; }

  // ---------------------------------------------------------- public API (called by the Worker)
  status() {
    return this._lock(async () => {
      this._load();
      return this.m && this.m.status !== "finished" ? { active: true, suspended: this.m.status === "suspended", quizId: this.m.quiz.id, startedBy: this.m.starter.id } : { active: false };
    });
  }

  /** init: {mode, chatId, starter, ownerId, quiz:{id,name,description}, settings, questions:[Question], link, kind, exam, order?, groupTime?, reviewIds?, botUsername, delayMs?} */
  start(init) {
    return this._lock(async () => {
      this._load();
      if (this.m && this.m.status !== "finished") return { ok: false, busy: true, suspended: this.m.status === "suspended" };
      await this._wipe();
      const order = init.order || questionOrder(init.questions.length, init.settings.shuffle);
      this.qs = init.questions;
      this._put("qs", this.qs.map((q) => q.toData()));
      this.m = {
        mode: init.mode, chatId: init.chatId, starter: init.starter, ownerId: init.ownerId, quiz: init.quiz, settings: init.settings,
        link: init.link, kind: init.kind || "normal", exam: init.exam || null, order, pos: -1, status: "running",
        sid: Math.random().toString(16).slice(2, 8), parts: {}, cur: null, next: null, msgIds: [], reviewIds: init.reviewIds || [],
        groupTime: init.groupTime || 0, alarm: null, resend: null, startedAt: Date.now(), botUsername: init.botUsername, reopen: null,
      };
      this._save();
      if (init.delayMs) {
        const secs = Math.round(init.delayMs / 1000);
        await this._say(`🎯 <b>${esc(init.quiz.name)}</b>\n${order.length} questions. Starting in ${secs} seconds – get ready!`, { parse_mode: "HTML" });
        await this._arm("begin", Date.now() + init.delayMs);
        this._save();
      } else await this._sendNext();
      return { ok: true };
    });
  }

  answer({ pollId, user, optionIds }) {
    return this._lock(async () => {
      this._load();
      const m = this.m, cur = m && m.cur;
      if (!m || m.status !== "running" || !cur || cur.resolved || cur.pollId !== pollId) return;
      const picked = this._originalIndexes(cur, optionIds);
      if (m.mode === "solo") {
        if (user.id !== m.starter.id) return;
        if (cur.regular && this.s.tr.mode === "open" && this.s.tr.retract) {      // the vote can be taken back: wait for Next / the timer
          cur.pending = optionIds.length ? optionIds : null; this._save(); return;
        }
        if (!optionIds.length) return;
        await this._resolveSolo(grade(cur.correct, optionIds) ? CORRECT : WRONG, picked);
      } else {
        if (!optionIds.length) return;
        const p = this._part(user);
        if (p.res[cur.pos]) return;
        p.res[cur.pos] = [grade(cur.correct, optionIds) ? CORRECT : WRONG, picked, Math.min((Date.now() - cur.sentAt) / 1000, cur.limit || 1800)];
        this._save();
      }
    });
  }

  /** Skip (sk) or Next (nx) button of the person taking the quiz. */
  press({ sid, pos, userId, next }) {
    return this._lock(async () => {
      this._load();
      const m = this.m, cur = m && m.cur;
      if (!m || m.mode !== "solo" || m.status !== "running" || !cur || cur.resolved || cur.pos !== pos || m.sid !== sid || userId !== m.starter.id) return false;
      if (next && cur.pending) await this._resolveSolo(grade(cur.correct, cur.pending) ? CORRECT : WRONG, this._originalIndexes(cur, cur.pending));
      else await this._resolveSolo(SKIPPED, []);
      return true;
    });
  }

  resume({ sid, userId }) {
    return this._lock(async () => {
      this._load();
      const m = this.m;
      if (!m || m.status !== "suspended" || (sid && m.sid !== sid) || userId !== m.starter.id) return false;
      m.status = "running"; m.sid = Math.random().toString(16).slice(2, 8); m.resend = null; m.next = null;
      await this._disarm();
      const cur = m.cur;
      if (cur && cur.pos === m.pos && !cur.resolved) {          // the question that was on screen is asked again
        await this.tg.stopPoll(m.chatId, cur.msgId);
        await this.tg.deleteMessages(m.chatId, cur.ids);
        m.msgIds = m.msgIds.filter((i) => !cur.ids.includes(i));
        m.pos -= 1;
      } else if (!cur || cur.pos < m.pos) m.pos -= 1;           // the send of this question never worked
      await this._sendNext();
      return true;
    });
  }

  /** End now; everything not answered counts as skipped. */
  stop() {
    return this._lock(async () => {
      this._load();
      const m = this.m;
      if (!m || m.status === "finished") return false;
      const cur = m.cur;
      if (cur && !cur.resolved) {
        cur.resolved = true;
        await this.tg.stopPoll(m.chatId, cur.msgId);
        if (m.mode === "solo") this._part(m.starter).res[cur.pos] = [SKIPPED, [], Math.min((Date.now() - cur.sentAt) / 1000, cur.limit || 1800)];
      }
      await this._finish();
      return true;
    });
  }

  alarm() {
    return this._lock(async () => {
      this._load();
      const m = this.m;
      if (!m || !m.alarm) return;
      const a = m.alarm;
      m.alarm = null;
      try {
        if (a.kind === "begin") { if (m.status === "running") await this._sendNext(); }
        else if (a.kind === "timeout") await this._onTimeout(a.pos);
        else if (a.kind === "advance") { if (m.status === "running" && m.cur && m.cur.resolved && m.cur.pos === a.pos) await this._sendNext(); }
        else if (a.kind === "resend") await this._resend(a.pos);
        else if (a.kind === "notify") await this._notify();
        else if (a.kind === "reopen") await this._reopenStep();
        else if (a.kind === "expire") { if (m.status === "suspended") await this._wipe(); }
        if (this.m) this._save();
      } catch (e) { console.error("alarm failed", a.kind, e && e.stack || e); }
    });
  }

  // ---------------------------------------------------------- sending
  async _say(text, extra = {}) {
    const m = this.m;
    return this.tg.sendMessage(m.chatId, text, extra);
  }

  _limitFor(q) {
    const t = q.time === null || q.time === undefined ? this.s.time : q.time;
    return t === 0 && this.m.groupTime ? this.m.groupTime : t;
  }

  _prepare(pos) {
    const m = this.m, q = this.qs[m.order[pos]];
    const doShuffle = this.s.shuffle === "options" || this.s.shuffle === "both";
    const { options, correctIds } = shuffleOptions(q.options, q.correct, Math.random, doShuffle);
    const multi = correctIds.length > 1 || !this.s.singleLock;
    return {
      pos, options, correctIds, multi, r: renderQuestion(pos + 1, this.total, q, options, multi),
      limit: this._limitFor(q), media: q.media, explanation: q.explanation || null,
      regular: m.mode === "solo" && usesRegularPoll(this.s), ids: [], mediaDone: false, bodyDone: false,
    };
  }

  async _sendNext() {
    const m = this.m;
    m.pos += 1;
    if (m.pos >= this.total) { await this._finish(); return; }
    m.resend = null;
    const ok = await this._trySend();
    if (!ok && m.status === "running") {
      m.resend = { started: Date.now(), attempt: 0 };
      await this._arm("resend", Date.now() + RESEND_DELAYS[0] * 1000, { pos: m.pos });
    }
  }

  async _resend(pos) {
    const m = this.m;
    if (m.status !== "running" || m.pos !== pos || (m.cur && m.cur.pos === pos)) return;
    if (Date.now() - m.resend.started > AUTO_RETRY_SECONDS * 1000) { await this._suspend(); return; }
    if (await this._trySend() || m.status !== "running") return;
    m.resend.attempt += 1;
    await this._arm("resend", Date.now() + RESEND_DELAYS[Math.min(m.resend.attempt, RESEND_DELAYS.length - 1)] * 1000, { pos });
  }

  /** true = sent; false = Telegram can't be reached right now (retry later) or the quiz was aborted. */
  async _trySend() {
    const m = this.m, pos = m.pos;
    const prep = m.next && m.next.pos === pos ? m.next : this._prepare(pos);
    m.next = prep;
    const chat = m.chatId, r = prep.r;
    try {
      if (prep.media && !prep.mediaDone) {
        const [method, field] = MEDIA_METHODS[prep.media.type] || MEDIA_METHODS.document;
        const caption = r.body && r.body.length <= 1000 && !prep.bodyDone ? r.body : undefined;
        try {
          const msg = await this.tg.call(method, { chat_id: chat, [field]: prep.media.id, ...(caption ? { caption } : {}) });
          prep.ids.push(msg.message_id);
          if (caption) prep.bodyDone = true;
        } catch (e) { if (e.transient) throw e; console.error("media failed", e.message); }   // a bad file must not stop the quiz
        prep.mediaDone = true;
      }
      if (r.body && !prep.bodyDone) { const msg = await this._say(esc(r.body), { parse_mode: "HTML" }); prep.ids.push(msg.message_id); prep.bodyDone = true; }
      const params = {
        chat_id: chat, question: r.pollQuestion, options: r.pollOptions.map((text) => ({ text })),
        is_anonymous: m.mode === "channel", type: prep.regular ? "regular" : "quiz", allows_multiple_answers: prep.multi,
      };
      if (!prep.regular) { params.correct_option_ids = prep.correctIds; if (prep.explanation) params.explanation = prep.explanation; }
      const native = prep.limit >= 5 && prep.limit <= 600;
      if (native) params.open_period = prep.limit;
      if (m.mode === "solo") {
        const retract = prep.regular && this.s.tr.mode === "open" && this.s.tr.retract;
        params.reply_markup = kb([btn(retract ? "✅ Next" : "⏭ Skip", `${retract ? "nx" : "sk"}:${m.sid}:${pos}`)]);
      }
      const msg = await this.tg.call("sendPoll", params);
      prep.ids.push(msg.message_id);
      m.cur = { pos, msgId: msg.message_id, pollId: msg.poll.id, correct: prep.correctIds, opts: prep.options, sentAt: Date.now(),
        limit: prep.limit, native, resolved: false, pending: null, regular: prep.regular, ids: prep.ids };
      m.msgIds.push(...prep.ids);
      m.next = null;
      await this.db.mapPoll(msg.poll.id, this.key);
      if (prep.limit > 0) await this._arm("timeout", Date.now() + prep.limit * 1000 + (native ? TIMEOUT_GRACE_MS : 0), { pos });
      if (pos + 1 < this.total) m.next = this._prepare(pos + 1);          // ready before it is needed
      this._save();
      return true;
    } catch (e) {
      if (e instanceof TgError && e.transient) { this._save(); return false; }
      if (e instanceof TgError && (e.code === 403 || /chat not found|kicked|blocked/i.test(e.message))) { await this._drop(); return false; }
      console.error("sendPoll failed", e && e.message);
      await this._abort("⚠️ Sorry, I couldn't send the next question, so the quiz was stopped.");
      return false;
    }
  }

  async _suspend() {
    const m = this.m;
    m.status = "suspended"; m.notified = false;
    this._save();
    await this._notify();
  }

  async _notify() {
    const m = this.m;
    if (m.status !== "suspended") return;
    const done = Object.keys(this._part(m.starter).res).length;
    try {
      await this._say(
        `⏸ Your quiz “${esc(m.quiz.name)}” was interrupted by a connection problem, after ${done} of ${this.total} questions.\n\n` +
        "Press Resume to carry on with the question you were on, or send /stop to end the quiz and see your score.",
        { parse_mode: "HTML", reply_markup: kb([btn(`▶️ Resume (${done}/${this.total} done)`, `rs:${m.sid}`)]) });
      m.notified = true;
      await this._arm("expire", Date.now() + SESSION_KEEP_HOURS * 3600 * 1000);
    } catch (e) {
      if (e.transient) await this._arm("notify", Date.now() + 30000);
      else await this._drop();
    }
  }

  async _drop() { await this._wipe(); }
  async _abort(text) {
    const m = this.m;
    m.status = "finished";
    await this._say(text).catch(() => {});
    await this._wipe();
  }

  // ---------------------------------------------------------- answers and timers
  _part(user) {
    const p = this.m.parts;
    if (!p[user.id]) p[user.id] = { name: user.name || userLabel(user), username: user.username || null, res: {} };
    return p[user.id];
  }

  _originalIndexes(cur, optionIds) {
    const q = this.qs[this.m.order[cur.pos]];
    return optionIds.filter((i) => i >= 0 && i < cur.opts.length && q.options.includes(cur.opts[i])).map((i) => q.options.indexOf(cur.opts[i]));
  }

  async _resolveSolo(outcome, picks) {
    const m = this.m, cur = m.cur, tr = this.s.tr;
    cur.resolved = true;
    this._part(m.starter).res[cur.pos] = [outcome, picks, Math.min((Date.now() - cur.sentAt) / 1000, cur.limit || 1800)];
    await this._disarm();
    await this.tg.stopPoll(m.chatId, cur.msgId);
    const removeNow = tr.mode === "locked" && tr.removeAfterAnswer;
    if (removeNow) { await this.tg.deleteMessages(m.chatId, cur.ids); m.msgIds = m.msgIds.filter((i) => !cur.ids.includes(i)); }
    this._save();
    if (removeNow || answersHidden(this.s)) await this._sendNext();
    else { await this._arm("advance", Date.now() + NEXT_DELAY_MS, { pos: cur.pos }); this._save(); }
  }

  async _onTimeout(pos) {
    const m = this.m, cur = m.cur;
    if (m.status !== "running" || !cur || cur.pos !== pos || cur.resolved) return;
    if (m.mode === "solo") {
      if (!cur.native) await this.tg.stopPoll(m.chatId, cur.msgId);
      if (cur.pending) await this._resolveSolo(grade(cur.correct, cur.pending) ? CORRECT : WRONG, this._originalIndexes(cur, cur.pending));
      else await this._resolveSolo(SKIPPED, []);
      return;
    }
    cur.resolved = true;                                  // group / channel: the poll ran out for everybody
    if (!cur.native) await this.tg.stopPoll(m.chatId, cur.msgId);
    await this._arm("advance", Date.now() + GROUP_DELAY_MS, { pos });
  }

  // ---------------------------------------------------------- finishing
  _outcomesOf(part) {
    const outcomes = [], picks = [];
    let elapsed = 0;
    for (let pos = 0; pos < this.total; pos++) {
      const r = part.res[pos];
      outcomes.push(r ? r[0] : SKIPPED); picks.push(r ? r[1] : []);
      if (r) elapsed += r[2];
    }
    return { outcomes, picks, elapsed };
  }

  async _finish() {
    const m = this.m;
    m.status = "finished";
    await this._disarm();
    try {
      if (m.mode === "solo") await this._finishSolo(); else await this._finishGroup();
    } catch (e) { console.error("finish failed", e && e.stack || e); }
    if (m.mode === "solo" && this.s.tr.mode === "open" && this.s.tr.reopen && m.kind === "normal") {
      m.status = "finished"; m.reopen = { i: 0 };
      this._save();
      await this._arm("reopen", Date.now() + 1500);
      return;                                            // the state stays until the polls are re-sent
    }
    await this._wipe();
  }

  async _finishSolo() {
    const m = this.m, s = this.s, user = m.starter, total = this.total;
    const part = this._part(user);
    const { outcomes, picks, elapsed } = this._outcomesOf(part);
    const score = scoreOutcomes(outcomes, total, s);
    const missed = [];
    outcomes.forEach((o, pos) => {
      if (o !== CORRECT) {
        const q = this.qs[m.order[pos]];
        missed.push({ q, wrong: picks[pos].filter((i) => !q.correct.includes(i)).map((i) => q.options[i]), idx: m.order[pos] });
      }
    });
    const normal = m.kind === "normal", exam = isExam(s) && normal, reviewing = reviewOn(s);

    let rank = null, rankOf = null, attemptNo = 1;
    if (m.kind !== "sandbox") {
      if (normal) attemptNo = (await this.db.attemptCount(m.quiz.id, user.id)) + 1;
      await this.db.addAttempt({
        quizId: m.quiz.id, quizName: m.quiz.name, userId: user.id, userName: user.name, username: user.username,
        takerInfo: m.exam ? `${m.exam.name} (${m.exam.id})` : null, score: score.marks, total, correct: score.correct, wrong: score.wrong,
        skipped: score.skipped, elapsed, passed: score.passed, n: attemptNo, mode: normal ? "solo" : "retry",
      });
      if (normal) { const r = await this.db.rank(m.quiz.id, score.marks, elapsed); rank = r.rank; rankOf = r.total; }
    } else {                                              // sandbox: right answers close the saved mistake
      const ids = outcomes.map((o, pos) => (o === CORRECT ? m.reviewIds[m.order[pos]] : null)).filter(Boolean);
      await this.db.setReviewStatus(user.id, ids, "resolved");
    }

    const takerInfo = [user.name, user.username ? "@" + user.username : null, `id ${user.id}`].filter(Boolean).join(" · ") + (m.exam ? ` · name “${m.exam.name}”, ID “${m.exam.id}”` : "");
    const summary = (extra = {}) => summaryHtml({ name: m.quiz.name, score, total, settings: s, link: m.link, elapsed, rank, rankOf, attemptNo, showLink: s.retake === "on" && m.kind !== "sandbox", ...extra });
    const blocks = missed.map((x) => reviewBlock(x.q.text, x.q.correct.map((i) => x.q.options[i]), x.wrong));
    const chunks = chunkBlocks(blocks);
    const send = (text, extra = {}) => this.tg.sendMessage(m.chatId, text, { parse_mode: "HTML", ...extra });

    if (exam) {                                           // exam mode: the taker only gets a receipt
      await send(`✅ <b>${esc(m.quiz.name)}</b> finished. Thank you! Your answers were sent to the quiz creator.`);
      if (m.ownerId && m.ownerId !== user.id) {
        await this.tg.sendMessage(m.ownerId, summary({ takerInfo, showLink: false }), { parse_mode: "HTML" }).catch(() => {});
        if (reviewing === false && s.review.toCreator) for (let i = 0; i < chunks.length; i++)
          await this.tg.sendMessage(m.ownerId, (i === 0 ? "📝 <b>Mistakes</b>\n" : "") + quoteHtml(chunks[i]), { parse_mode: "HTML" }).catch(() => {});
      } else await send(summary());
    } else {
      await send(summary());
      if (reviewing) {
        if (!missed.length) await send("🎉 Perfect score, nothing to review!");
        else {
          let token = null;
          if (m.kind !== "sandbox") token = await this.db.saveRetrySet({ user: user.id, quizId: m.quiz.id, name: m.quiz.name.endsWith(RETRY_SUFFIX) ? m.quiz.name : m.quiz.name + RETRY_SUFFIX, settings: s, items: missed });
          const rows = [];
          if (token) {
            if (s.retake === "on") rows.push([btn(`🔁 Retry wrong & skipped (${missed.length})`, `rt:${token}`)]);
            const second = [btn("💾 Save mistakes", `sv:${token}`)];
            if (s.review.sort && this.env.GEMINI_API_KEY) second.push(btn("🔃 Sort in topics", `ts:${token}`));
            rows.push(second);
          }
          const ids = [];
          for (let i = 0; i < chunks.length; i++) {
            const msg = await send((i === 0 ? REVIEW_TITLE + "\n" : "") + quoteHtml(chunks[i]), i === chunks.length - 1 && rows.length ? { reply_markup: kb(...rows) } : {});
            ids.push(msg.message_id);
          }
          if (token) await this.db.setRetryMsgs(token, ids);
        }
      }
    }
    if (normal) await maybeSponsor(this.env, this.db, this.tg, m.chatId, user.id);
    if (s.tr.mode !== "open") await this.tg.deleteMessages(m.chatId, m.msgIds);
  }

  async _finishGroup() {
    const m = this.m, total = this.total;
    if (m.mode === "channel") {
      await this.tg.sendMessage(m.chatId, `✅ <b>${esc(m.quiz.name)}</b> is finished. Thanks for taking part!`, { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    const rows = [], stmts = [];
    for (const [uid, p] of Object.entries(m.parts)) {
      const { outcomes, elapsed } = this._outcomesOf(p);
      const score = scoreOutcomes(outcomes, total, this.s);
      rows.push({ name: p.name, marks: score.marks, elapsed });
      stmts.push(this.db.prep(
        "INSERT INTO attempts (quiz_id,quiz_name,user_id,user_name,username,score,total,correct,wrong,skipped,elapsed,passed,n,mode,chat_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,'group',?,?)",
        m.quiz.id, m.quiz.name, Number(uid), p.name, p.username, score.marks, total, score.correct, score.wrong, score.skipped, elapsed,
        score.passed === null ? null : score.passed ? 1 : 0, m.chatId, Math.floor(Date.now() / 1000)));
    }
    rows.sort((a, b) => b.marks - a.marks || a.elapsed - b.elapsed);
    if (stmts.length) await this.db.batch(stmts);
    await this.tg.sendMessage(m.chatId, leaderboardHtml(`${m.quiz.name} – results`, rows) + `\n\n${rows.length} taking part · ${total} questions`, { parse_mode: "HTML" }).catch(() => {});
  }

  /** "Open" transparency + reopen: send the polls again, a few per alarm (free Workers allow 50 calls per invocation). */
  async _reopenStep() {
    const m = this.m;
    if (!m || !m.reopen) return;
    const end = Math.min(this.total, m.reopen.i + REOPEN_BATCH);
    if (m.reopen.i === 0) await this._say("🔓 The questions are open again – anyone can vote. Forward these polls to share them.").catch(() => {});
    for (let pos = m.reopen.i; pos < end; pos++) {
      const q = this.qs[m.order[pos]];
      const { options, correctIds } = shuffleOptions(q.options, q.correct, Math.random, true);
      const multi = correctIds.length > 1 || !this.s.singleLock;
      const r = renderQuestion(pos + 1, this.total, q, options, multi);
      try {
        if (q.media) { const [method, field] = MEDIA_METHODS[q.media.type] || MEDIA_METHODS.document; await this.tg.call(method, { chat_id: m.chatId, [field]: q.media.id }).catch(() => {}); }
        if (r.body) await this._say(esc(r.body), { parse_mode: "HTML" });
        await this.tg.call("sendPoll", { chat_id: m.chatId, question: r.pollQuestion, options: r.pollOptions.map((text) => ({ text })), is_anonymous: true, type: "quiz",
          allows_multiple_answers: multi, correct_option_ids: correctIds, ...(q.explanation ? { explanation: q.explanation } : {}) });
      } catch (e) { if (e.transient) { m.reopen.i = pos; await this._arm("reopen", Date.now() + 5000); return; } }
    }
    m.reopen.i = end;
    if (end < this.total) await this._arm("reopen", Date.now() + 1200);
    else await this._wipe();
  }
}
