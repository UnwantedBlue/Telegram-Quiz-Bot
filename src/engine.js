// Pure helpers (no Telegram, no database): settings, shuffling, rendering, grading, result texts.
export { parseDuration, timeParam } from "./qparser.js";

// ---------------------------------------------------------------- settings
export const MAX_QUESTIONS = 500;
export const MAX_NAME_LEN = 100;
export const MAX_DESC_LEN = 500;
export const MAX_FOLDER_NAME_LEN = 40;
export const TIME_CHOICES = [5, 10, 15, 30];
export const PIN_LAST_OPTIONS = true;
export const MAX_BACKUP_BYTES = 1_500_000;   // free Workers get 10 ms CPU per request: keep imports modest
export const AUTO_RETRY_SECONDS = 120;
export const SESSION_KEEP_HOURS = 48;
export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;
export const NEXT_DELAY_MS = 700;           // pause so the person sees the right answer (0 when answers are hidden)
export const TIMEOUT_GRACE_MS = 1500;
export const CORRECT = "correct", WRONG = "wrong", SKIPPED = "skipped";
export const RETRY_SUFFIX = " – wrong & skipped";

/** Every quiz carries a copy of these. ★ marks in the menus = the value that is in DEFAULT_SETTINGS. */
export const DEFAULT_SETTINGS = {
  time: 30,                  // seconds per question; 0 = untimed
  singleLock: true,          // ★ questions with one correct answer are single-choice (off: multi-select everywhere)
  neg: 0,                    // ★ marks lost for each WRONG answer (skipped ones cost nothing)
  pass: { on: false, type: "percent", value: 50 },   // ★ off
  shuffle: "both",           // none | questions | options | both
  retake: "on",              // on | off | (clone is a one-off action that makes a second link)
  tr: {                      // transparency
    mode: "unlocked",        // locked | unlocked | open   (unlocked = how the bot always worked)
    removeAfterAnswer: true, // locked: delete the question right after it was answered   ★ on
    hideAnswer: true,        // locked: use a plain poll so the right answer isn't shown    ★ on
    reopen: true,            // open: after the quiz, send the polls again so anyone can vote   ★ on
    retract: false,          // open: the person may take back a vote   ★ off
  },
  review: {
    on: "auto",              // true | false | "auto" (auto = on, but off when answers are hidden until the end)
    sort: true,              // ★ add the "Sort in topics" button (Gemini)
    askName: true,           // ★ review off: ask the taker for name and ID first
    toCreator: false,        // review off: results go to the quiz creator, not the taker (exam mode, premium)
  },
};

export function normSettings(input) {
  const d = DEFAULT_SETTINGS, s = input && typeof input === "object" ? input : {};
  const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
  const num = (v, def, lo, hi) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, Number(v))) : def);
  const tr = s.tr || {}, rv = s.review || {}, pass = s.pass || {};
  const bool = (v, def) => (typeof v === "boolean" ? v : def);
  return {
    time: Math.round(num(s.time, d.time, 0, 7 * 86400)),
    singleLock: bool(s.singleLock, d.singleLock),
    neg: num(s.neg, d.neg, 0, 10),
    pass: { on: bool(pass.on, false), type: pick(pass.type, ["percent", "marks"], "percent"), value: num(pass.value, 50, 0, 100000) },
    shuffle: pick(s.shuffle, ["none", "questions", "options", "both"], d.shuffle),
    retake: pick(s.retake, ["on", "off"], d.retake),
    tr: {
      mode: pick(tr.mode, ["locked", "unlocked", "open"], d.tr.mode),
      removeAfterAnswer: bool(tr.removeAfterAnswer, d.tr.removeAfterAnswer),
      hideAnswer: bool(tr.hideAnswer, d.tr.hideAnswer),
      reopen: bool(tr.reopen, d.tr.reopen),
      retract: bool(tr.retract, d.tr.retract),
    },
    review: {
      on: rv.on === true || rv.on === false ? rv.on : "auto",
      sort: bool(rv.sort, d.review.sort), askName: bool(rv.askName, d.review.askName), toCreator: bool(rv.toCreator, d.review.toCreator),
    },
  };
}

/** Answers hidden until the quiz is over ("locked" mode + hide answer). */
export const answersHidden = (s) => s.tr.mode === "locked" && s.tr.hideAnswer;
export const reviewDefault = (s) => !answersHidden(s);
export const reviewOn = (s) => (s.review.on === "auto" ? reviewDefault(s) : s.review.on);
/** Exam style: no review for the taker, result goes to the creator. */
export const isExam = (s) => !reviewOn(s) && s.review.toCreator;
export const usesRegularPoll = (s) => (s.tr.mode === "locked" && s.tr.hideAnswer) || (s.tr.mode === "open" && s.tr.retract);

// ----------------------------------------------------------------- helpers
export const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const slug = (name) => name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "quiz";
export const nowSec = () => Math.floor(Date.now() / 1000);

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const p = (n) => String(n).padStart(2, "0");
  if (h) return `${h}h ${p(m)}m ${p(s)}s`;
  if (m) return `${m}m ${p(s)}s`;
  return `${s}s`;
}
/** A time limit for display: 0 -> "untimed". */
export const formatLimit = (sec) => (sec === 0 ? "untimed" : sec < 60 ? `${sec} sec` : formatDuration(sec));
export const fmtMarks = (n) => String(Number(Number(n).toFixed(2)));

/** "30 sec" or "5 sec – 2m 00s (custom per question)" etc. */
export function timeSummary(questions, defaultSec) {
  const times = questions.map((q) => (q.time === null || q.time === undefined ? defaultSec : q.time));
  if (!times.length) return formatLimit(defaultSec);
  const lo = Math.min(...times), hi = Math.max(...times);
  return lo === hi ? formatLimit(lo) : `${formatLimit(lo)} – ${formatLimit(hi)} (varies by question)`;
}

// --------------------------------------------------------------- shuffling
const PIN_RE = /^(all|none|any|both|neither)\s+(of\s+)?(the\s+)?(above|these)\b/i;

export function shuffleArray(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Returns {options, correctIds}: the options in shown order and the positions of the correct ones. */
export function shuffleOptions(options, correct, rng = Math.random, doShuffle = true) {
  let order = options.map((_, i) => i);
  if (doShuffle) {
    const pinned = order.filter((i) => PIN_LAST_OPTIONS && PIN_RE.test(options[i]));
    const free = shuffleArray(order.filter((i) => !pinned.includes(i)), rng);
    order = [...free, ...pinned];
  }
  const set = new Set(correct);
  return { options: order.map((i) => options[i]), correctIds: order.map((i, pos) => (set.has(i) ? pos : -1)).filter((p) => p >= 0) };
}

export const grade = (correctIds, chosen) => correctIds.length === new Set(chosen).size && correctIds.every((c) => chosen.includes(c));

export function questionOrder(n, mode, rng = Math.random) {
  const idx = Array.from({ length: n }, (_, i) => i);
  return mode === "questions" || mode === "both" ? shuffleArray(idx, rng) : idx;
}

// --------------------------------------------------------------- rendering
/** Fit a question into Telegram's poll limits. body = a normal message sent before the poll (long text, description). */
export function renderQuestion(number, total, q, options, multi) {
  const prefix = `[${number}/${total}] `;
  const desc = q.description || "";
  const qFits = prefix.length + q.text.length <= POLL_QUESTION_MAX;
  const oFits = options.every((o) => o.length <= POLL_OPTION_MAX);
  const stub = prefix + (multi ? "Choose the correct answers" : "Choose the correct answer");
  const tail = desc ? "\n\n" + desc : "";
  if (qFits && oFits) return { body: desc || null, pollQuestion: prefix + q.text, pollOptions: [...options] };
  if (oFits) return { body: prefix + q.text + tail, pollQuestion: stub, pollOptions: [...options] };
  const labels = options.map((_, i) => String.fromCharCode(65 + i));
  const list = options.map((o, i) => `${labels[i]}. ${o}`).join("\n");
  return { body: prefix + q.text + tail + "\n\n" + list, pollQuestion: stub, pollOptions: labels };
}

// ----------------------------------------------------------------- scoring
/** counts, marks (with negative marking) and the pass verdict. */
export function scoreOutcomes(outcomes, total, settings) {
  const correct = outcomes.filter((o) => o === CORRECT).length;
  const wrong = outcomes.filter((o) => o === WRONG).length;
  const skipped = total - correct - wrong;
  const marks = correct - wrong * settings.neg;
  let passed = null;
  if (settings.pass.on) passed = settings.pass.type === "percent" ? (total ? (marks / total) * 100 >= settings.pass.value : false) : marks >= settings.pass.value;
  return { correct, wrong, skipped, marks, passed };
}

export function passText(settings) {
  const p = settings.pass;
  return p.type === "percent" ? `${fmtMarks(p.value)}%` : `${fmtMarks(p.value)} marks`;
}

export function summaryHtml({ name, score, total, settings, link, elapsed, rank, rankOf, attemptNo, showLink = true, takerInfo = null }) {
  const lines = [`<b>${esc(name)}</b>`];
  if (takerInfo) lines.push(`👤 ${esc(takerInfo)}`);
  lines.push(`Score: ${fmtMarks(score.marks)}/${total}` + (settings.neg > 0 ? ` (−${fmtMarks(settings.neg)} per wrong answer)` : ""));
  lines.push(`✘ Wrong: ${score.wrong}`, `✪ Skipped: ${score.skipped}`, `Time: ${formatDuration(elapsed)}`);
  if (rank) lines.push(`🏆 Rank: ${rank} of ${rankOf}`);
  if (score.passed !== null) lines.push(score.passed ? `✅ Passed (pass mark ${passText(settings)})` : `❌ Not passed (pass mark ${passText(settings)})`);
  if (attemptNo > 1) lines.push(`Attempt #${attemptNo}`);
  if (showLink && link) lines.push(`Retake: ${esc(link)}`);
  return lines.join("\n");
}

export const REVIEW_TITLE = "📝 <b>Review</b> – the questions you got wrong or skipped";

export function reviewBlock(questionText, correctAnswers, wrongAnswers = []) {
  return [`Q. ${questionText}`, ...correctAnswers.map((a) => `✓ ${a}`), ...wrongAnswers.map((a) => `✘ ${a}`)].join("\n");
}
export const quoteHtml = (text) => `<blockquote expandable>${esc(text)}</blockquote>`;

export function chunkBlocks(blocks, limit = 3900, sep = "\n\n") {
  const chunks = [];
  let current = "";
  for (let block of blocks) {
    while (block.length > limit) {
      if (current) { chunks.push(current); current = ""; }
      chunks.push(block.slice(0, limit)); block = block.slice(limit);
    }
    if (!current) current = block;
    else if (current.length + sep.length + block.length <= limit) current += sep + block;
    else { chunks.push(current); current = block; }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function leaderboardHtml(title, rows, limit = 10) {
  const medals = ["🥇", "🥈", "🥉"];
  const lines = [`🏆 <b>${esc(title)}</b>`, ""];
  rows.slice(0, limit).forEach((r, i) => {
    lines.push(`${medals[i] || `${i + 1}.`} ${esc(r.name)} – ${fmtMarks(r.marks)} (${formatDuration(r.elapsed)})`);
  });
  if (!rows.length) lines.push("Nobody answered.");
  return lines.join("\n");
}
