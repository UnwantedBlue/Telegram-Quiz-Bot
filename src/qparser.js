// Parser for the bulk question format. Pure JS, no Telegram code.
//
//   ++                      (optional: the NEXT question needs a picture / video / audio as its stem)
//   +What is the capital of France?
//   //optional description, shown above the poll (several // lines are allowed, right under the + line)
//   London
//   *Paris                  (* marks a correct option)
//   =optional explanation   (up to 3 lines, 200 characters)
//   :14                     (optional time for THIS question: seconds, or d-h-m-s from the right: :1-72-85 = 1h 72m 85s; :0 = untimed)
//
// A line that must START with + * = \ // or look like :14 is written with a backslash in front: \+5 mV

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 12;          // Telegram's poll limit
export const EXPLANATION_MAX = 200;     // Telegram's limit for a quiz explanation
export const EXPLANATION_MAX_BREAKS = 2;
export const DESC_MAX = 900;
export const MAX_TOTAL_CHARS = 3500;
export const WARN_OPTIONS = 8;
export const MAX_TIME = 7 * 86400;

const INVISIBLE = /[\u200b\u200c\u200d\u2060\ufeff]/g;
const SPECIAL = "+*=\\:/";
const TIME_RE = /^:(\d+(?:-\d+){0,3})$/;
const MEDIA_REF = /^\+\+<<(\w+):([\w-]+)>>$/;

// ------------------------------------------------------------------ time
/** "14" -> 14, "1-30" -> 90, "1-72-85" -> 8005 (d-h-m-s, aligned to the right), "2m", "1h30m", "90s". Throws on nonsense. */
export function parseDuration(input) {
  const s = String(input ?? "").trim().toLowerCase();
  let total;
  if (/^\d+(?:-\d+){0,3}$/.test(s)) {
    const mult = [1, 60, 3600, 86400];
    total = s.split("-").map(Number).reverse().reduce((sum, n, i) => sum + n * mult[i], 0);
  } else {
    const m = s.match(/^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s(?:ec)?)?$/);
    if (!s || !m || m.slice(1).every((x) => x === undefined)) throw new Error("not a time");
    const [d, h, mi, se] = m.slice(1).map((x) => Number(x || 0));
    total = d * 86400 + h * 3600 + mi * 60 + se;
  }
  if (!Number.isFinite(total) || total > MAX_TIME) throw new Error("too long");
  return total;
}

/** seconds -> the d-h-m-s parameter used after a colon in the input format (0 -> "0"). */
export function timeParam(seconds) {
  let t = Math.max(0, Math.round(seconds));
  if (t < 60) return String(t);
  const parts = [Math.floor(t / 86400), Math.floor((t % 86400) / 3600), Math.floor((t % 3600) / 60), t % 60];
  while (parts.length > 2 && parts[0] === 0) parts.shift();
  return parts.join("-");
}

// -------------------------------------------------------------- questions
export class Question {
  constructor({ text, options, correct, explanation = "", description = "", time = null, media = null, needsMedia = false, id = null }) {
    this.text = text; this.options = options; this.correct = correct;
    this.explanation = explanation; this.description = description;
    this.time = time;               // null = use the quiz timer, 0 = untimed, n = seconds
    this.media = media;             // {type, id} (a Telegram file_id) or null
    this.needsMedia = needsMedia;   // parse result only: this question was marked with ++ and still needs its stem
    this.id = id;                   // database row id (set when loaded)
  }
  toData() {
    const d = { q: this.text, o: this.options, c: this.correct };
    if (this.explanation) d.e = this.explanation;
    if (this.description) d.d = this.description;
    if (this.time !== null && this.time !== undefined) d.t = this.time;
    if (this.media) d.m = this.media;
    return d;
  }
  static fromData(d, id = null) {
    return new Question({
      text: d.q, options: [...d.o], correct: [...d.c], explanation: d.e || "", description: d.d || "",
      time: d.t === undefined ? null : d.t, media: d.m || null, id,
    });
  }
  searchText() {
    return [this.text, ...this.options, this.explanation, this.description].join(" \n ").toLowerCase();
  }
}

const clean = (line) => line.replace(INVISIBLE, "").replace(/\u00a0/g, " ").trim();
const preview = (text, limit = 40) => (text.length <= limit ? text : text.slice(0, limit - 1) + "…");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function unescape(text) {
  if (text.length >= 2 && text[0] === "\\" && SPECIAL.includes(text[1])) return text.slice(1);
  return text;
}
export function escapeLine(text) {
  if (!text) return text;
  if ("+*=\\".includes(text[0]) || text.startsWith("//") || TIME_RE.test(text)) return "\\" + text;
  return text;
}

function scan(text) {
  const orphans = [], blocks = [];
  let current = null, pendingMedia = false, pendingRef = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = clean(raw);
    if (line.startsWith("+")) {
      let q = line.slice(1), media = pendingMedia, ref = pendingRef;
      if (MEDIA_REF.test(line)) {                        // backup marker: ++<<type:file_id>>
        const m = line.match(MEDIA_REF);
        pendingMedia = true; pendingRef = { type: m[1], id: m[2] };
        continue;
      }
      if (q.startsWith("+")) {                           // ++ marker, or ++question
        q = q.slice(1).trim();
        if (!q) { pendingMedia = true; continue; }
        media = true;
      }
      current = { no: blocks.length + 1, question: q.trim(), lines: [], media, ref };
      blocks.push(current);
      pendingMedia = false; pendingRef = null;
    } else if (current === null) {
      if (line) orphans.push(line);
    } else current.lines.push(line);
  }
  return { orphans, blocks };
}

function parseBlock(block) {
  const question = block.question;
  if (!question) throw new Error("the question text after + is empty");
  const options = [], correct = [], explanation = [], desc = [], stray = [];
  let time = null, state = "head";
  const setTime = (line) => {
    try { time = parseDuration(line.slice(1)); } catch { throw new Error(`the time “${line}” is not valid (use seconds, or d-h-m-s such as :1-30; max 7 days)`); }
  };
  for (const line of block.lines) {
    if (state === "head") {
      if (!line) continue;
      if (line.startsWith("//")) { desc.push(line.slice(2).trim()); continue; }
      state = "options";
    }
    if (state === "options") {
      if (!line) continue;
      if (TIME_RE.test(line)) { setTime(line); state = "after"; continue; }
      if (line.startsWith("=")) {
        state = "explanation";
        const first = line.slice(1).trim();
        if (first) explanation.push(unescape(first));
        continue;
      }
      const marked = line.startsWith("*");
      const option = unescape(line.replace(/^\*+/, "").trim());
      if (!option) throw new Error("an option is empty (a line with only *)");
      if (marked) correct.push(options.length);
      options.push(option);
    } else if (state === "explanation") {
      if (!line) state = "after";
      else if (TIME_RE.test(line)) { setTime(line); state = "after"; }
      else explanation.push(unescape(line));
    } else if (line) {
      if (time === null && TIME_RE.test(line)) setTime(line);
      else stray.push(line);
    }
  }
  const n = options.length;
  if (n < MIN_OPTIONS) throw new Error(`it has ${plural(n, "option")}; at least ${MIN_OPTIONS} are needed`);
  if (n > MAX_OPTIONS) throw new Error(`it has ${n} options; the maximum is ${MAX_OPTIONS}`);
  if (!correct.length) throw new Error("no correct answer is marked (put * in front of it)");
  if (correct.length === n) throw new Error("every option is marked as correct");
  if (new Set(options).size !== n) throw new Error("two options have exactly the same text");
  const expl = explanation.join("\n"), description = desc.join("\n").trim();
  if (expl.length > EXPLANATION_MAX) throw new Error(`the explanation is ${expl.length} characters; Telegram allows at most ${EXPLANATION_MAX}`);
  if ((expl.match(/\n/g) || []).length > EXPLANATION_MAX_BREAKS) throw new Error("the explanation has more than 3 lines (Telegram allows at most 2 line breaks)");
  if (description.length > DESC_MAX) throw new Error(`the description is ${description.length} characters; the maximum is ${DESC_MAX}`);
  if (question.length + options.reduce((a, o) => a + o.length, 0) + expl.length + description.length > MAX_TOTAL_CHARS)
    throw new Error(`it is too long (limit is about ${MAX_TOTAL_CHARS} characters)`);

  const notes = [];
  if (stray.length)
    notes.push(`has ${plural(stray.length, "line")} after the explanation that ${stray.length === 1 ? "was" : "were"} ignored (“${preview(stray[0])}”). A new question must start with +.`);
  const q = new Question({ text: question, options, correct, explanation: expl, description, time, media: block.ref, needsMedia: block.media && !block.ref });
  return { q, notes };
}

/** Parse a chunk of text. Valid blocks become questions; problems are reported, never thrown. */
export function parseQuestions(text) {
  const result = { questions: [], errors: [], warnings: [] };
  const { orphans, blocks } = scan(text);
  if (orphans.length) {
    const n = orphans.length;
    result.errors.push({ blockNo: 0, preview: preview(orphans[0]), reason: `${plural(n, "line")} before the first + ${n === 1 ? "was" : "were"} ignored. Every question must start with +.` });
  }
  for (const block of blocks) {
    const pv = block.question ? preview(block.question) : "(empty)";
    let parsed;
    try { parsed = parseBlock(block); } catch (e) { result.errors.push({ blockNo: block.no, preview: pv, reason: e.message }); continue; }
    for (const note of parsed.notes) result.warnings.push({ blockNo: block.no, preview: pv, reason: note });
    if (parsed.q.options.length >= WARN_OPTIONS)
      result.warnings.push({ blockNo: block.no, preview: pv, reason: `has ${parsed.q.options.length} options. If a question is missing its +, its lines were merged into this one.` });
    result.questions.push(parsed.q);
  }
  return result;
}

/** Turn questions back into the input format (used by editing, the mini app and backups). */
export function formatQuestions(questions, { withMedia = false } = {}) {
  const lines = [];
  for (const q of questions) {
    if (q.media) lines.push(withMedia ? `++<<${q.media.type}:${q.media.id}>>` : "++");
    else if (q.needsMedia) lines.push("++");
    lines.push("+" + q.text);
    for (const d of (q.description || "").split("\n").filter((x) => x !== "")) lines.push("//" + d);
    const marked = new Set(q.correct);
    q.options.forEach((o, i) => lines.push((marked.has(i) ? "*" : "") + escapeLine(o)));
    if (q.explanation) {
      const [first, ...rest] = q.explanation.split("\n");
      lines.push("=" + escapeLine(first)); rest.forEach((r) => lines.push(escapeLine(r)));
    }
    if (q.time !== null && q.time !== undefined) lines.push(":" + timeParam(q.time));
  }
  return lines.join("\n");
}

/** Build a Question from a Telegram quiz poll the person sent. Returns {q} or {error}. */
export function questionFromPoll(poll) {
  if (!poll || poll.type !== "quiz") return { error: "That poll is not a quiz poll. Create a poll with “Quiz Mode” switched on." };
  const options = poll.options.map((o) => o.text);
  const ids = poll.correct_option_ids || (poll.correct_option_id !== undefined ? [poll.correct_option_id] : []);
  if (!ids.length) return { error: "I couldn't see which answer is correct in that poll. Make sure it is a quiz poll sent directly to me." };
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS || new Set(options).size !== options.length)
    return { error: "That poll's options are not usable (duplicates or wrong count)." };
  const explanation = (poll.explanation || "").slice(0, EXPLANATION_MAX);
  return { q: new Question({ text: poll.question.replace(/\s+/g, " ").trim(), options, correct: [...ids], explanation }) };
}

export const _internal = { preview, plural };
