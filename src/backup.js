// Backups: one person's quizzes and folders as a single text file, and reading it back (/import).
// Lines that start with # are instructions for the bot; everything else is a quiz in the normal input format:
//
//   #QUIZBOT-BACKUP 2
//   #PRESET {...}                   <- the "Default" bulk settings (optional)
//   #FOLDER Biology                 <- every folder, so empty ones come back too
//   #QUIZ abcd2345                  <- starts a quiz; its identifier (the link keeps working)
//   #NAME Heart and blood
//   #DESC first line\nsecond line   <- optional quiz description (\n = line break)
//   #SET {...}                      <- the quiz settings (timer, marking, shuffle, ...)
//   #FOLDER Biology                 <- the folder this quiz is in (optional)
//   +Which blood vessel carries oxygenated blood?
//   ...
// A question line that itself starts with # is written with a backslash in front (\#1 priority).

import { formatQuestions, parseQuestions } from "./qparser.js";
import { normSettings, TIME_CHOICES } from "./engine.js";

export const MAGIC = "#QUIZBOT-BACKUP";
export const ID_RE = /^[a-z0-9]{4,32}$/;
const LIST_RE = /^(?<name>.+?)\s*(?:[:：]|\s[–—-]\s)\s*(?<ref>\S+)$/u;
const NUMBER_RE = /^\d+[.)]\s+/;
const BULLET_RE = /^[-•*]\s+/;
const INVISIBLE = /[\u200b\u200c\u200d\u2060\ufeff]/g;

const clean = (t) => t.replace(INVISIBLE, "").split(/\s+/).filter(Boolean).join(" ");
const preview = (t, n = 40) => (t.length <= n ? t : t.slice(0, n - 1) + "…");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ------------------------------------------------------------------ writing
/** folders = folder names; items = [{quiz, folder}] (quiz has id,name,description,settings,questions); preset = object|null. */
export function buildBackup(folders, items, when, preset = null) {
  const lines = [
    `${MAGIC} 2`,
    `# Quiz Bot backup, made ${when}`,
    `# ${plural(items.length, "quiz")}, ${plural(folders.length, "folder")}`,
    "# Restore it with /import: send the bot this file. Lines that start with # are instructions for the bot.",
    "",
  ];
  if (preset) lines.push(`#PRESET ${JSON.stringify(preset)}`);
  for (const name of folders) lines.push(`#FOLDER ${name}`);
  for (const { quiz, folder } of items) {
    lines.push("", `#QUIZ ${quiz.id}`, `#NAME ${quiz.name}`);
    if (quiz.description) lines.push(`#DESC ${quiz.description.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`);
    lines.push(`#SET ${JSON.stringify(quiz.settings)}`);
    if (folder) lines.push(`#FOLDER ${folder}`);
    for (const line of formatQuestions(quiz.questions, { withMedia: true }).split("\n")) lines.push(line.startsWith("#") ? "\\" + line : line);
  }
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------ reading
export function looksLikeBackup(text) {
  for (const raw of text.replace(INVISIBLE, "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith(MAGIC) || line.startsWith("#QUIZ ")) return true;
  }
  return false;
}

/** The encrypted vault format made in the browser (see miniapp/vault.html). */
export function looksLikeVault(text) {
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  try { const j = JSON.parse(t); return j && j.qbk === 1 && !!j.ct; } catch { return false; }
}

export function parseBackup(text) {
  const data = { folders: [], quizzes: [], preset: null };
  const bodies = [];
  let current = null, inHeader = false;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(INVISIBLE, "");
    const s = line.trim();
    if (s.startsWith("#QUIZ ")) {
      const id = s.slice(6).trim().toLowerCase();
      current = { id: ID_RE.test(id) ? id : null, name: "", description: "", settings: null, folder: null, questions: [], skippedBlocks: 0, notes: [] };
      data.quizzes.push(current); bodies.push([]); inHeader = true;
      continue;
    }
    if (current === null) {
      if (s.startsWith("#FOLDER ")) {
        const name = clean(s.slice(8));
        if (name && !data.folders.some((f) => f.toLowerCase() === name.toLowerCase())) data.folders.push(name);
      } else if (s.startsWith("#PRESET ")) {
        try { data.preset = normSettings(JSON.parse(s.slice(8))); } catch { /* ignore */ }
      }
      continue;
    }
    if (inHeader) {
      if (s.startsWith("#NAME ")) { current.name = clean(s.slice(6)); continue; }
      if (s.startsWith("#DESC ")) { current.description = s.slice(6).replace(/\\(\\|n)/g, (_, c) => (c === "n" ? "\n" : "\\")); continue; }
      if (s.startsWith("#SET ")) { try { current.settings = normSettings(JSON.parse(s.slice(5))); } catch { /* ignore */ } continue; }
      if (s.startsWith("#TIME ")) { const t = parseInt(s.slice(6), 10); if (Number.isFinite(t)) current.legacyTime = t; continue; }   // version 1 backups
      if (s.startsWith("#FOLDER ")) { current.folder = clean(s.slice(8)) || null; continue; }
      if (!s) continue;
      inHeader = false;
    }
    if (s.startsWith("#")) continue;                       // a comment
    bodies[bodies.length - 1].push(line.startsWith("\\#") ? line.slice(1) : line);
  }
  data.quizzes.forEach((quiz, i) => {
    const result = parseQuestions(bodies[i].join("\n"));
    quiz.questions = result.questions;
    quiz.skippedBlocks = result.errors.length;
    if (!quiz.name) { quiz.name = "Imported quiz"; quiz.notes.push("had no name"); }
    if (!quiz.settings) {
      quiz.settings = normSettings({});
      if (quiz.legacyTime) quiz.settings.time = quiz.legacyTime;
    }
  });
  return data;
}

// ---------------------------------------------------------------- restoring
export async function restoreBackup(db, ownerId, data, { maxQuizzes, maxFolders }) {
  const report = { created: 0, foldersCreated: 0, existing: [], newLink: [], partial: [], failed: [], leftOut: 0, notFiled: 0, nothingFound: false, presetRestored: false };
  if (!data.quizzes.length && !data.folders.length) { report.nothingFound = true; return report; }
  const folderIds = new Map();
  const folderId = async (name) => {
    const key = name.toLowerCase();
    if (!folderIds.has(key)) {
      const found = await db.findFolderByName(ownerId, name);
      if (found) folderIds.set(key, found.id);
      else if ((await db.listFolders(ownerId)).length < maxFolders) { folderIds.set(key, await db.createFolder(ownerId, name)); report.foldersCreated++; }
      else folderIds.set(key, null);
    }
    return folderIds.get(key);
  };
  for (const name of data.folders) await folderId(name);
  let count = await db.countQuizzes(ownerId);
  for (const quiz of data.quizzes) {
    if (!quiz.questions.length) { report.failed.push([quiz.name, "no valid questions"]); continue; }
    if (count >= maxQuizzes) { report.leftOut++; continue; }
    let quizId = quiz.id;
    const owner = quizId ? await db.quizOwner(quizId) : null;
    if (owner === ownerId) { report.existing.push(quiz.name); continue; }
    if (owner !== null) { quizId = null; report.newLink.push(quiz.name); }
    const base = { owner: ownerId, name: quiz.name, description: quiz.description, settings: quiz.settings, questions: quiz.questions };
    let newId;
    try { newId = await db.createQuiz({ ...base, id: quizId }); }
    catch { newId = await db.createQuiz({ ...base, id: null }); report.newLink.push(quiz.name); }
    count++; report.created++;
    if (quiz.skippedBlocks) report.partial.push([quiz.name, quiz.skippedBlocks]);
    if (quiz.folder) {
      const fid = await folderId(quiz.folder);
      if (fid === null) report.notFiled++; else await db.setQuizFolder(newId, fid);
    }
  }
  if (data.preset && !(await db.getPreset(ownerId))) { await db.setPreset(ownerId, data.preset); report.presetRestored = true; }
  return report;
}

export function formatRestoreReport(rep, maxListed = 8) {
  if (rep.nothingFound) return "I couldn't find any quizzes or folders in that file. Send a backup made with /backup or an export.";
  const names = (items) => items.slice(0, maxListed).map((n) => `“${preview(n)}”`).join(", ") + (items.length > maxListed ? ` and ${items.length - maxListed} more` : "");
  const parts = [`✅ Restored ${plural(rep.created, "quiz")}` + (rep.foldersCreated ? ` and ${plural(rep.foldersCreated, "new folder")}` : "") + (rep.presetRestored ? " and your default settings" : "") + "."];
  if (rep.existing.length) parts.push(`ℹ️ ${plural(rep.existing.length, "quiz")} already existed and was left as it is: ${names(rep.existing)}.`);
  if (rep.newLink.length) parts.push(`⚠️ These got a new link, because their old one belongs to someone else: ${names(rep.newLink)}. See My quizzes.`);
  if (rep.partial.length) parts.push("⚠️ Some questions could not be read and were left out: " + rep.partial.slice(0, maxListed).map(([n, k]) => `“${preview(n)}” (${k})`).join(", ") + ".");
  if (rep.failed.length) parts.push("⚠️ Not restored: " + rep.failed.slice(0, maxListed).map(([n, why]) => `“${preview(n)}” (${why})`).join(", ") + ".");
  if (rep.leftOut) parts.push(`⚠️ ${plural(rep.leftOut, "quiz")} not restored: you have reached the limit of quizzes per person.`);
  if (rep.notFiled) parts.push(`⚠️ ${plural(rep.notFiled, "quiz")} could not be put in a folder: you have reached the limit of folders.`);
  return parts.join("\n\n");
}

// ----------------------------------------------------- "name: link" lists
export function extractQuizId(ref) {
  ref = ref.trim().replace(/^[<>()[\]"'.,;]+|[<>()[\]"'.,;]+$/g, "");
  const found = ref.match(/start=q_([A-Za-z0-9]+)/);
  const candidate = (found ? found[1] : ref.slice(0, 2).toLowerCase() === "q_" ? ref.slice(2) : ref).toLowerCase();
  return ID_RE.test(candidate) ? candidate : null;
}

/** Lines like "Quiz name: https://t.me/MyBot?start=q_abcd2345" or "Quiz name – abcd2345". Returns {entries, problems}. */
export function parseImportList(text, maxName = 100) {
  let lines = text.replace(/\r\n?/g, "\n").split("\n").map(clean).filter(Boolean);
  if (lines.length && lines.every((l) => NUMBER_RE.test(l))) lines = lines.map((l) => l.replace(NUMBER_RE, ""));
  const entries = [], problems = [], seen = new Set();
  for (let line of lines) {
    line = line.replace(BULLET_RE, "");
    if (line.startsWith("[") && line.endsWith("]")) line = line.slice(1, -1).trim();
    const m = line.match(LIST_RE);
    if (!m || /^https?$/i.test(m.groups.name)) { problems.push(`• “${preview(line)}”: I expected “quiz name: link” on one line.`); continue; }
    const name = m.groups.name.trim(), id = extractQuizId(m.groups.ref);
    if (id === null) problems.push(`• “${preview(line)}”: I couldn't find a quiz link or identifier at the end of it.`);
    else if (name.length > maxName) problems.push(`• “${preview(name)}”: the name is longer than ${maxName} characters.`);
    else if (seen.has(id)) problems.push(`• “${preview(name)}”: the same link appears twice, so I used it once.`);
    else { seen.add(id); entries.push([name, id]); }
  }
  return { entries, problems };
}
