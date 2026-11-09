// Test harness: D1 over node:sqlite, a fake Durable Object namespace, and a fake Telegram.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { QuizRun } from "../src/run.js";

const clean = (a) => a.map((x) => (x === undefined ? null : typeof x === "boolean" ? Number(x) : x));
class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.db, this.sql, clean(a)); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
}
export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) { db.exec("BEGIN"); try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
}

export class FakeNamespace {
  constructor(env) { this.env = env; this.objs = new Map(); }
  idFromName(n) { return n; }
  get(id) {
    if (!this.objs.has(id)) {
      const sdb = new DatabaseSync(":memory:");
      const state = { alarm: null };
      const ctx = {
        storage: {
          sql: { exec: (sql, ...a) => { const st = sdb.prepare(sql); const isRead = /^\s*select/i.test(sql); if (isRead) { const rows = st.all(...a); return { toArray: () => rows }; } st.run(...a); return { toArray: () => [] }; } },
          setAlarm: async (t) => { state.alarm = t; }, deleteAlarm: async () => { state.alarm = null; },
          deleteAll: async () => { sdb.exec("DROP TABLE IF EXISTS kv"); },
        },
      };
      const obj = new QuizRun(ctx, this.env);
      obj.__state = state;
      this.objs.set(id, obj);
    }
    return this.objs.get(id);
  }
}

export function makeEnv() {
  const env = { BOT_TOKEN: "123:TEST", WEBHOOK_SECRET: "s3cret", OWNER_ID: "1", PAGES_URL: "https://me.github.io/quizbot", MINIAPP_SHORTNAME: "edit", PREMIUM_STARS: "50" };
  env.DB = makeD1();
  env.RUN = new FakeNamespace(env);
  return env;
}

/** Fake Telegram: records every call; message ids and poll ids count up. */
export function fakeTelegram() {
  const calls = []; let mid = 100, pid = 0;
  const handler = async (url, init) => {
    const method = String(url).split("/").pop();
    const params = init && init.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ method, params });
    let result = true;
    if (method === "getMe") result = { id: 999, username: "testbot" };
    else if (/^send/.test(method) && method !== "sendInvoice") result = { message_id: ++mid };
    if (method === "sendPoll") result = { message_id: ++mid, poll: { id: "poll" + ++pid } };
    if (method === "getChatMember") result = { status: "administrator" };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  globalThis.fetch = handler;
  return { calls, of: (m) => calls.filter((c) => c.method === m), last: (m) => calls.filter((c) => c.method === m).at(-1), texts: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.params.text) };
}

export const ctxExec = { waitUntil: (p) => p };
export const msgUpdate = (uid, text, extra = {}) => ({ message: { message_id: Math.floor(Math.random() * 1e6), from: { id: uid, first_name: "Tester" }, chat: { id: uid, type: "private" }, text, ...extra } });
export const cbUpdate = (uid, data, mid = 500) => ({ callback_query: { id: "cb" + Math.random(), from: { id: uid, first_name: "Tester" }, data, message: { message_id: mid, chat: { id: uid, type: "private" } } } });
