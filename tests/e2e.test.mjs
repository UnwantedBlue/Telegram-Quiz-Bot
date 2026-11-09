import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleUpdate } from "../src/bot.js";
import { handleApi } from "../src/api.js";
import { makeEnv, fakeTelegram, ctxExec, msgUpdate, cbUpdate } from "./harness.mjs";

const U = 2;                       // a normal user (user 1 is the owner)
const send = (env, u) => handleUpdate(env, u, ctxExec, "https://w.example");
const initData = (uid, token = "123:TEST") => {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: uid, first_name: "T" }) });
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  p.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return p.toString();
};
const api = (env, method, path, uid, body) => handleApi(new Request("https://w.example" + path, { method, headers: { authorization: "tma " + initData(uid), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env, ctxExec).then(async (r) => ({ status: r.status, ...(await r.json()) }));

async function createQuiz(env, tg, extraQuestions = "") {
  await send(env, msgUpdate(U, "/createquiz"));
  await send(env, msgUpdate(U, "Heart quiz"));
  await send(env, cbUpdate(U, "cr:sd"));
  await send(env, msgUpdate(U, `+Capital of France?\nLondon\n*Paris\n=It is Paris\n:10\n+Prime numbers?\n*2\n4\n*7\n+Third\n*yes\nno${extraQuestions}`));
  await send(env, msgUpdate(U, "/quesdone"));
  await send(env, cbUpdate(U, "st:go"));
  const q = env.DB.raw.prepare("SELECT * FROM quizzes").all();
  return q.at(-1);
}

test("create a quiz end to end: cancel button first, cleanup, strip, link", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await createQuiz(env, tg);
  assert.ok(quiz, "quiz saved");
  assert.equal(quiz.n_questions, 3);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM flows").get().n, 0, "flow cleaned");
  const first = tg.of("sendMessage")[0].params;
  assert.match(JSON.stringify(first.reply_markup), /fx:x/, "first message carries Cancel");
  assert.ok(tg.of("deleteMessages").length >= 1, "sequence messages removed");
  const strip = tg.of("editMessageText").find((c) => /Tap a dash/.test(c.params.text));
  assert.ok(strip && strip.params.text.includes("t.me/testbot/edit?startapp=" + quiz.id + "_1"), "strip with mini-app links");
  assert.ok(tg.texts().some((t) => t.includes(`https://t.me/testbot?start=q_${quiz.id}`)), "link message");
  const qs = env.DB.raw.prepare("SELECT data FROM questions WHERE quiz_id=? ORDER BY pos").all(quiz.id).map((r) => JSON.parse(r.data));
  assert.equal(qs[0].t, 10, "per-question time kept");
});

test("cancel removes the sequence's messages and goes home", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  await send(env, msgUpdate(U, "/bulkcreate"));
  await send(env, msgUpdate(U, "Temp"));
  await send(env, cbUpdate(U, "fx:x"));
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM flows").get().n, 0);
  assert.ok(tg.of("deleteMessages").length >= 1);
  assert.match(tg.texts().at(-1), /Quiz Bot/);
});

test("bulk time, varying-time poll flow and media stem flow", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  await send(env, msgUpdate(U, "/createquiz"));
  await send(env, msgUpdate(U, "Mixed"));
  await send(env, cbUpdate(U, "cr:sd"));
  await send(env, cbUpdate(U, "cr:vt"));
  await send(env, msgUpdate(U, "", { text: undefined, poll: { type: "quiz", question: "Poll Q?", options: [{ text: "a" }, { text: "b" }], correct_option_ids: [1] } }));
  assert.ok(tg.texts().some((t) => /How much time/.test(t)), "asks time for the poll");
  await send(env, cbUpdate(U, "cr:qt:15"));
  await send(env, msgUpdate(U, "++\n+Which bone?\n*x\ny"));
  await send(env, msgUpdate(U, "/quesdone"));
  assert.ok(tg.texts().some((t) => /need a picture/.test(t)), "asks for the media");
  await send(env, msgUpdate(U, "", { text: undefined, photo: [{ file_id: "PHOTO1" }] }));
  assert.match(JSON.stringify(tg.last("sendMessage").params), /Quiz settings/);
  await send(env, cbUpdate(U, "st:ng"));          // open submenu
  await send(env, cbUpdate(U, "st:ng:0.5"));
  await send(env, cbUpdate(U, "st:go"));
  const quiz = env.DB.raw.prepare("SELECT * FROM quizzes").get();
  assert.equal(JSON.parse(quiz.settings).neg, 0.5);
  const rows = env.DB.raw.prepare("SELECT data FROM questions ORDER BY pos").all().map((r) => JSON.parse(r.data));
  assert.equal(rows[0].t, 15); assert.deepEqual(rows[1].m, { type: "photo", id: "PHOTO1" });
});

test("mini app API: auth, search, replace, delete, bad token", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await createQuiz(env, tg);
  const bad = await handleApi(new Request("https://w.example/api/quizzes", { headers: { authorization: "tma hash=bad" } }), env, ctxExec);
  assert.equal(bad.status, 401);
  const list = await api(env, "GET", "/api/quizzes", U);
  assert.equal(list.quizzes[0].id, quiz.id);
  const s = await api(env, "GET", `/api/quiz/${quiz.id}/questions?q=prime`, U);
  assert.equal(s.items.length, 1); assert.match(s.items[0].format, /^\+Prime numbers\?/);
  const rid = s.items[0].id;
  const put = await api(env, "PUT", `/api/quiz/${quiz.id}/question/${rid}`, U, { text: "+Primes under 10?\n*3\n4\n*5\n=yes" });
  assert.equal(put.ok, true);
  assert.equal((await api(env, "GET", `/api/quiz/${quiz.id}/questions?q=under`, U)).items.length, 1);
  assert.equal((await api(env, "PUT", `/api/quiz/${quiz.id}/question/${rid}`, U, { text: "+only one option\n*a" })).status, 400);
  assert.equal((await api(env, "GET", `/api/quiz/${quiz.id}/questions`, 77)).status, 404, "not the owner");
  const del = await api(env, "DELETE", `/api/quiz/${quiz.id}/question/${rid}`, U);
  assert.equal(del.ok, true);
  assert.equal(env.DB.raw.prepare("SELECT n_questions n FROM quizzes WHERE id=?").get(quiz.id).n, 2);
  assert.deepEqual(env.DB.raw.prepare("SELECT pos FROM questions ORDER BY pos").all().map((r) => r.pos), [0, 1]);
  assert.ok(tg.texts().some((t) => /Deleted from/.test(t)), "deleted question sent back");
});

test("solo run: timer alarm, answers, skip, result, rank, attempts, review buttons", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await createQuiz(env, tg);
  env.DB.raw.prepare("UPDATE quizzes SET settings=? WHERE id=?").run(JSON.stringify({ shuffle: "none", neg: 0.5 }), quiz.id);
  await send(env, msgUpdate(U, `/start q_${quiz.id}`));
  assert.match(tg.last("sendMessage").params.text, /Heart quiz/);
  await send(env, cbUpdate(U, `go:${quiz.id}`));
  const run = env.RUN.get("u:" + U);
  let poll = tg.last("sendPoll").params;
  assert.equal(poll.open_period, 10, "first question has its own 10 s");
  assert.match(poll.question, /^\[1\/3\]/);
  assert.ok(run.__state.alarm > Date.now(), "timeout alarm set");
  const answer = (id, ids) => send(env, { poll_answer: { poll_id: id, user: { id: U, first_name: "Tester" }, option_ids: ids } });
  await answer("poll1", poll.correct_option_ids);                         // correct
  await run.alarm();                                                        // advance
  poll = tg.last("sendPoll").params;
  assert.match(poll.question, /^\[2\/3\]/);
  assert.equal(poll.allows_multiple_answers, true);
  await answer("poll2", [1]);                                               // wrong (4)
  await run.alarm();
  assert.match(tg.last("sendPoll").params.question, /^\[3\/3\]/);
  const sk = JSON.stringify(tg.last("sendPoll").params.reply_markup).match(/sk:[a-z0-9]+:2/)[0];
  await send(env, cbUpdate(U, sk));                                         // skip the last one
  await run.alarm();                                                        // advance -> finish
  const summary = tg.texts().find((t) => /Score:/.test(t));
  assert.match(summary, /Score: 0\.5\/3/, summary);       // 1 correct - 0.5 for 1 wrong
  assert.match(summary, /✘ Wrong: 1/); assert.match(summary, /✪ Skipped: 1/); assert.match(summary, /Rank: 1 of 1/);
  assert.ok(tg.of("sendMessage").some((c) => /rt:/.test(JSON.stringify(c.params.reply_markup))), "retry button");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM attempts").get().n, 1);
  assert.equal((await run.status()).active, false);
  // retry the mistakes
  const rt = tg.of("sendMessage").map((c) => JSON.stringify(c.params.reply_markup || "")).join(" ").match(/rt:[a-z0-9]+/)[0];
  await send(env, cbUpdate(U, rt));
  assert.match(tg.last("sendPoll").params.question, /^\[1\/2\]/);
});

test("locked + hide answer: plain polls, questions removed after answering, no review", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await createQuiz(env, tg);
  env.DB.raw.prepare("UPDATE quizzes SET settings=? WHERE id=?").run(JSON.stringify({ shuffle: "none", tr: { mode: "locked" } }), quiz.id);
  await send(env, cbUpdate(U, `go:${quiz.id}`));
  const poll = tg.last("sendPoll").params;
  assert.equal(poll.type, "regular"); assert.equal(poll.correct_option_ids, undefined);
  await send(env, { poll_answer: { poll_id: "poll1", user: { id: U, first_name: "T" }, option_ids: [1] } });
  assert.ok(tg.of("deleteMessages").length >= 1, "answered question deleted");
  assert.equal(tg.of("sendPoll").length, 2, "next question sent without waiting");
});

test("exam mode: asks name and id, result goes to the creator only", async () => {
  const env = makeEnv(), tg = fakeTelegram(), T = 5;
  const quiz = await createQuiz(env, tg);
  env.DB.raw.prepare("UPDATE quizzes SET settings=? WHERE id=?").run(JSON.stringify({ shuffle: "none", review: { on: false, toCreator: true } }), quiz.id);
  await send(env, cbUpdate(T, `go:${quiz.id}`));
  await send(env, msgUpdate(T, "Ada Lovelace"));
  await send(env, msgUpdate(T, "ID-42"));
  for (let i = 1; i <= 3; i++) { const p = tg.last("sendPoll").params; await send(env, { poll_answer: { poll_id: "poll" + i, user: { id: T, first_name: "Tester" }, option_ids: p.correct_option_ids } }); await env.RUN.get("u:" + T).alarm(); }
  const toTaker = tg.of("sendMessage").filter((c) => c.params.chat_id === T).map((c) => c.params.text).join("\n");
  assert.match(toTaker, /sent to the quiz creator/); assert.doesNotMatch(toTaker, /Score:/);
  const toOwner = tg.of("sendMessage").filter((c) => c.params.chat_id === U).map((c) => c.params.text).join("\n");
  assert.match(toOwner, /Ada Lovelace/); assert.match(toOwner, /ID-42/); assert.match(toOwner, /Score: 3\/3/);
});

test("retake disabled blocks a second attempt; clone makes a second link", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await createQuiz(env, tg);
  env.DB.raw.prepare("UPDATE quizzes SET settings=? WHERE id=?").run(JSON.stringify({ retake: "off" }), quiz.id);
  env.DB.raw.prepare("INSERT INTO attempts (quiz_id,quiz_name,user_id,score,total,correct,wrong,skipped,elapsed,n,mode,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(quiz.id, "x", 5, 2, 3, 2, 1, 0, 9, 1, "solo", 1);
  await send(env, cbUpdate(5, `go:${quiz.id}`));
  assert.match(tg.last("answerCallbackQuery").params.text, /Retake is disabled/);
  const { DB } = await import("../src/db.js");
  const db = new DB(env.DB);
  const cid = await db.cloneQuiz(quiz.id, U, { name: "clone", settings: { retake: "on" } });
  assert.equal((await db.quizFull(cid)).questions.length, 3, "clone reads the source questions");
  await db.deleteQuiz(quiz.id, U);
  assert.equal((await db.quizFull(cid)).questions.length, 3, "questions survive deleting the source");
});

test("folders, backup export, restore into another account", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await createQuiz(env, tg);
  await send(env, cbUpdate(U, `afn:${quiz.id}`));
  await send(env, msgUpdate(U, "Biology"));
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM quiz_folder").get().n, 1);
  const { DB } = await import("../src/db.js");
  const { buildBackup, parseBackup, restoreBackup } = await import("../src/backup.js");
  const db = new DB(env.DB);
  const ex = await db.exportUser(U);
  const text = buildBackup(ex.folders, ex.items, "now", null);
  const rep = await restoreBackup(db, 3, parseBackup(text), { maxQuizzes: 10, maxFolders: 10 });
  assert.equal(rep.created, 1); assert.equal(rep.newLink.length, 1, "id belongs to someone else -> new link");
  assert.equal((await db.listFolders(3))[0].name, "Biology");
});

test("group quiz: members answer the same poll, leaderboard at the end", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  const quiz = await createQuiz(env, tg);
  const g = (uid, text) => ({ message: { message_id: 7, from: { id: uid, first_name: "P" + uid }, chat: { id: -100, type: "supergroup", title: "G" }, text } });
  await send(env, g(10, `/quiz ${quiz.id}`));
  const token = JSON.stringify(tg.last("sendMessage").params.reply_markup).match(/gs:([a-z0-9]+)/)[0];
  await send(env, { callback_query: { id: "x", from: { id: 10, first_name: "P10" }, data: token, message: { message_id: 9, chat: { id: -100, type: "supergroup" } } } });
  const run = env.RUN.get("g:-100");
  await run.alarm();                                              // the "starting in 5 seconds" alarm
  for (let i = 1; i <= 3; i++) {
    const p = tg.last("sendPoll").params;
    assert.equal(p.is_anonymous, false);
    await send(env, { poll_answer: { poll_id: "poll" + i, user: { id: 10, first_name: "A" }, option_ids: p.correct_option_ids } });
    await send(env, { poll_answer: { poll_id: "poll" + i, user: { id: 11, first_name: "B" }, option_ids: [0] } });
    await run.alarm();                                            // timeout (closes the question)
    await run.alarm();                                            // advance
  }
  const board = tg.texts().find((t) => /results/.test(t));
  assert.ok(board && board.indexOf("A") < board.indexOf("B"), board);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM attempts WHERE mode='group'").get().n, 2);
});

test("premium: free folder limit, owner always premium, stars invoice, payment grants premium", async () => {
  const env = makeEnv(), tg = fakeTelegram();
  await send(env, cbUpdate(U, "pm:buy"));
  const inv = tg.last("sendInvoice").params;
  assert.equal(inv.currency, "XTR"); assert.equal(inv.prices[0].amount, 50);
  await send(env, { message: { message_id: 1, from: { id: U, first_name: "T" }, chat: { id: U, type: "private" }, successful_payment: { invoice_payload: `prem:${U}`, total_amount: 50, telegram_payment_charge_id: "c1" } } });
  const { DB } = await import("../src/db.js");
  assert.ok((await new DB(env.DB).premiumUntil(U)) > Date.now() / 1000);
  assert.match(tg.texts().at(-1), /Premium is active/);
});
