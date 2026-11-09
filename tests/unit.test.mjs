import test from "node:test";
import assert from "node:assert/strict";
import { parseQuestions, parseDuration, timeParam, formatQuestions, questionFromPoll } from "../src/qparser.js";
import { shuffleOptions, scoreOutcomes, normSettings, renderQuestion, reviewOn, answersHidden, summaryHtml, chunkBlocks } from "../src/engine.js";
import { buildBackup, parseBackup, parseImportList, extractQuizId } from "../src/backup.js";

test("duration: seconds, d-h-m-s from the right, weird overflow", () => {
  assert.equal(parseDuration("14"), 14);
  assert.equal(parseDuration("1-30"), 90);
  assert.equal(parseDuration("1-72-85"), 3600 + 72 * 60 + 85);
  assert.equal(parseDuration("2-0-0-0"), 172800);
  assert.equal(parseDuration("1h30m"), 5400);
  assert.throws(() => parseDuration("abc"));
  assert.throws(() => parseDuration("9-0-0-0"));
  assert.equal(timeParam(90), "1-30");
  assert.equal(parseDuration(timeParam(8005)), 8005);
});

test("parser: description, explanation, time, media markers, escapes", () => {
  const r = parseQuestions(`++
+Name this bone
//Look at the picture
Femur
*Tibia
=It is the shin bone
:1-30
+Sodium charge?
\\+2
*+1
=a
b
c
:0
++Another one
x
*y`);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.questions.length, 3);
  const [a, b, c] = r.questions;
  assert.equal(a.needsMedia, true); assert.equal(a.description, "Look at the picture"); assert.equal(a.time, 90); assert.equal(a.explanation, "It is the shin bone");
  assert.deepEqual(b.options, ["+2", "+1"]); assert.equal(b.time, 0); assert.equal(b.explanation, "a\nb\nc"); assert.equal(b.needsMedia, false);
  assert.equal(c.needsMedia, true);
});

test("parser: errors are reported, not thrown", () => {
  const r = parseQuestions("junk\n+No answer\na\nb\n+Bad time\n*a\nb\n:99-0-0-0\n+Fine\n*a\nb");
  assert.equal(r.questions.length, 1);
  assert.equal(r.errors.length, 3);
});

test("format round-trip keeps everything", () => {
  const src = `+Q1\n//desc line\nA\n*B\n=why\n:45\n+Q2\n\\//weird\n*\\:30\n`;
  const q = parseQuestions(src).questions;
  assert.equal(q.length, 2);
  const again = parseQuestions(formatQuestions(q)).questions;
  assert.deepEqual(again.map((x) => x.toData()), q.map((x) => x.toData()));
});

test("poll to question", () => {
  const { q } = questionFromPoll({ type: "quiz", question: "Capital?", options: [{ text: "Paris" }, { text: "Rome" }], correct_option_ids: [0], explanation: "France" });
  assert.deepEqual(q.correct, [0]); assert.equal(q.explanation, "France");
  assert.ok(questionFromPoll({ type: "regular", options: [] }).error);
});

test("shuffle keeps correct ones and pins 'all of the above'", () => {
  for (let i = 0; i < 50; i++) {
    const { options, correctIds } = shuffleOptions(["a", "b", "c", "All of the above"], [3, 0]);
    assert.equal(options[3], "All of the above");
    assert.deepEqual(correctIds.map((p) => options[p]).sort(), ["All of the above", "a"].sort());
  }
});

test("scoring: negative marking skips nothing, pass mark", () => {
  const s = normSettings({ neg: 0.25, pass: { on: true, type: "percent", value: 50 } });
  const sc = scoreOutcomes(["correct", "wrong", "skipped", "correct"], 4, s);
  assert.equal(sc.marks, 1.75); assert.equal(sc.wrong, 1); assert.equal(sc.skipped, 1); assert.equal(sc.passed, false);
  const s2 = normSettings({ pass: { on: true, type: "marks", value: 2 } });
  assert.equal(scoreOutcomes(["correct", "correct"], 2, s2).passed, true);
});

test("settings: defaults, review default flips when answers are hidden", () => {
  const d = normSettings({});
  assert.equal(d.tr.mode, "unlocked"); assert.equal(reviewOn(d), true);
  const hidden = normSettings({ tr: { mode: "locked", hideAnswer: true } });
  assert.equal(answersHidden(hidden), true); assert.equal(reviewOn(hidden), false);
  assert.equal(reviewOn(normSettings({ tr: { mode: "locked" }, review: { on: true } })), true);
});

test("render: long question and long options fall back", () => {
  const q = { text: "x".repeat(400), description: "d" };
  const r = renderQuestion(1, 5, q, ["a", "b"], false);
  assert.match(r.pollQuestion, /Choose the correct answer/); assert.match(r.body, /^\[1\/5\] x+/);
  const r2 = renderQuestion(2, 5, { text: "short", description: "" }, ["a".repeat(150), "b"], true);
  assert.deepEqual(r2.pollOptions, ["A", "B"]);
});

test("backup round-trip, import list", () => {
  const qs = parseQuestions("+Q\n//d\n*a\n#1 priority\n=e\n:20").questions;
  const text = buildBackup(["Bio"], [{ quiz: { id: "abcd2345", name: "Heart", description: "multi\nline", settings: normSettings({ neg: 0.5 }), questions: qs }, folder: "Bio" }], "now", normSettings({ time: 15 }));
  const data = parseBackup(text);
  assert.equal(data.folders[0], "Bio"); assert.equal(data.quizzes[0].id, "abcd2345"); assert.equal(data.quizzes[0].description, "multi\nline");
  assert.equal(data.quizzes[0].settings.neg, 0.5); assert.deepEqual(data.quizzes[0].questions[0].options, ["a", "#1 priority"]);
  assert.equal(data.quizzes[0].questions[0].time, 20); assert.equal(data.preset.time, 15);
  const { entries, problems } = parseImportList("Heart: https://t.me/Bot?start=q_abcd2345\nLungs – wxyz9876\nnonsense");
  assert.deepEqual(entries, [["Heart", "abcd2345"], ["Lungs", "wxyz9876"]]); assert.equal(problems.length, 1);
  assert.equal(extractQuizId("q_abcd2345"), "abcd2345");
});

test("chunkBlocks stays under the limit", () => {
  const out = chunkBlocks(Array.from({ length: 50 }, (_, i) => "x".repeat(300) + i));
  assert.ok(out.every((c) => c.length <= 3900));
});
