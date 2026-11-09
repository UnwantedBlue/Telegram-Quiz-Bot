import test from "node:test";
import assert from "node:assert/strict";
import { handleUpdate } from "../src/bot.js";
import { makeEnv, fakeTelegram, ctxExec, msgUpdate, cbUpdate } from "./harness.mjs";

const U = 2;
const send = (env, u) => handleUpdate(env, u, ctxExec, "https://w.example");
async function quick(env) {
  await send(env, msgUpdate(U, "/bulkcreate")); await send(env, msgUpdate(U, "Q"));
  await send(env, msgUpdate(U, "+a?\n*x\ny\n+b?\n*x\ny"));
  await send(env, msgUpdate(U, "/quesdone")); await send(env, cbUpdate(U, "cr:bt:10"));
  return env.DB.raw.prepare("SELECT * FROM quizzes").all().at(-1);
}

test("bulk create applies the chosen bulk time", async () => {
  const env = makeEnv(); fakeTelegram();
  const q = await quick(env);
  assert.equal(q.time_limit, 10); assert.equal(q.n_questions, 2);
});

test("free accounts are limited to 10 folders; premium lifts it", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  for (let i = 0; i < 10; i++) { await send(env, msgUpdate(U, "/folder")); await send(env, msgUpdate(U, "F" + i)); }
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM folders").get().n, 10);
  await send(env, msgUpdate(U, "/folder"));
  assert.match(tg.texts().at(-1), /limit/);
  env.DB.raw.prepare("INSERT INTO users (id,premium_until,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET premium_until=excluded.premium_until").run(U, 9999999999, 1);
  await send(env, msgUpdate(U, "/folder"));
  assert.match(tg.texts().at(-1), /Send the name for the new folder/);
});

test("import: list of 'name: link' asks for the questions and keeps the link", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  await send(env, msgUpdate(U, "/import"));
  await send(env, msgUpdate(U, "Heart: https://t.me/testbot?start=q_abcd2345"));
  assert.ok(tg.texts().some((t) => /Quiz 1 of 1/.test(t)));
  await send(env, msgUpdate(U, "+a?\n*x\ny"));
  await send(env, msgUpdate(U, "/quesdone"));
  assert.equal(env.DB.raw.prepare("SELECT id FROM quizzes").get().id, "abcd2345");
  assert.match(tg.texts().at(-1), /Import finished: 1 of 1/);
});

test("import: backup file text restores quizzes", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  await send(env, msgUpdate(U, "/import"));
  await send(env, msgUpdate(U, "#QUIZBOT-BACKUP 2\n#FOLDER Bio\n#QUIZ wxyz9876\n#NAME Lungs\n#FOLDER Bio\n+q?\n*a\nb\n:25"));
  assert.match(tg.texts().at(-1), /Restored 1 quiz/);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM quiz_folder").get().n, 1);
});

test("a failed send suspends the quiz and Resume continues it", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await quick(env);
  const realFetch = globalThis.fetch;
  await send(env, cbUpdate(U, `go:${quiz.id}`));
  const run = env.RUN.get("u:" + U);
  const answer = (id, ids) => send(env, { poll_answer: { poll_id: id, user: { id: U, first_name: "T" }, option_ids: ids } });
  await answer("poll1", tg.last("sendPoll").params.correct_option_ids);
  globalThis.fetch = async (url, init) => { if (String(url).endsWith("sendPoll")) throw new Error("offline"); return realFetch(url, init); };
  await run.alarm();                                       // advance: sending fails -> a resend alarm is armed
  assert.ok(run.__state.alarm, "resend armed");
  run.m.resend.started -= 200000;                          // pretend the 2 minutes of retrying are over
  await run.alarm();
  assert.equal((await run.status()).suspended, true);
  assert.ok(tg.texts().some((t) => /interrupted/.test(t)), "person is told");
  globalThis.fetch = realFetch;
  const rs = JSON.stringify(tg.last("sendMessage").params.reply_markup).match(/rs:[a-z0-9]+/)[0];
  await send(env, cbUpdate(U, rs));
  assert.match(tg.last("sendPoll").params.question, /^\[2\/2\]/);
});

test("open mode: polls are kept and re-sent after the quiz", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await quick(env);
  env.DB.raw.prepare("UPDATE quizzes SET settings=? WHERE id=?").run(JSON.stringify({ shuffle: "none", tr: { mode: "open" } }), quiz.id);
  await send(env, cbUpdate(U, `go:${quiz.id}`));
  const run = env.RUN.get("u:" + U);
  for (let i = 1; i <= 2; i++) { await send(env, { poll_answer: { poll_id: "poll" + i, user: { id: U, first_name: "T" }, option_ids: [0] } }); await run.alarm(); }
  const before = tg.of("sendPoll").length;
  await run.alarm();                                        // reopen step
  assert.equal(tg.of("sendPoll").length, before + 2, "both polls re-sent");
  assert.equal(tg.of("deleteMessages").filter((c) => c.params.message_ids.length > 3).length, 0, "polls not cleaned up");
});

test("retract mode waits for Next and lets the vote be taken back", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await quick(env);
  env.DB.raw.prepare("UPDATE quizzes SET settings=? WHERE id=?").run(JSON.stringify({ shuffle: "none", tr: { mode: "open", retract: true } }), quiz.id);
  await send(env, cbUpdate(U, `go:${quiz.id}`));
  const p = tg.last("sendPoll").params, polls = tg.of("sendPoll").length;
  assert.equal(p.type, "regular");
  const ans = (ids) => send(env, { poll_answer: { poll_id: "poll1", user: { id: U, first_name: "T" }, option_ids: ids } });
  await ans([0]); await ans([]); await ans([0]);
  assert.equal(tg.of("sendPoll").length, polls, "still the same question");
  const nx = JSON.stringify(p.reply_markup).match(/nx:[a-z0-9]+:0/)[0];
  await send(env, cbUpdate(U, nx));
  await env.RUN.get("u:" + U).alarm();
  assert.equal(tg.of("sendPoll").length, polls + 1);
});

test("inline query returns the quiz with a start button", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await quick(env);
  await send(env, { inline_query: { id: "iq1", from: { id: U, first_name: "T" }, query: "q_" + quiz.id } });
  const r = tg.last("answerInlineQuery").params.results[0];
  assert.equal(r.id, quiz.id); assert.match(JSON.stringify(r.reply_markup), /start=q_/);
});

test("untimed question in a group asks for a time first", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await quick(env);
  env.DB.raw.prepare("UPDATE quizzes SET settings=? WHERE id=?").run(JSON.stringify({ time: 0 }), quiz.id);
  await send(env, { message: { message_id: 1, from: { id: 10, first_name: "P" }, chat: { id: -100, type: "supergroup", title: "G" }, text: `/quiz ${quiz.id}` } });
  assert.match(JSON.stringify(tg.last("sendMessage").params.reply_markup), /gt:/);
});

test("per-question time above 10 s only for 5 free questions beyond the limit is trimmed", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  await send(env, msgUpdate(U, "/bulkcreate")); await send(env, msgUpdate(U, "T"));
  const qs = Array.from({ length: 12 }, (_, i) => `+q${i}?\n*a\nb\n:20`).join("\n");
  await send(env, msgUpdate(U, qs)); await send(env, msgUpdate(U, "/quesdone")); await send(env, cbUpdate(U, "cr:bt:30"));
  const rows = env.DB.raw.prepare("SELECT data FROM questions ORDER BY pos").all().map((r) => JSON.parse(r.data));
  assert.equal(rows.filter((r) => r.t !== undefined).length, 10);
  assert.ok(tg.texts().some((t) => /custom time to 10 questions/.test(t)));
});
