// The small HTTP API behind the GitHub Pages mini app (question search / edit / delete) and the encryption page.
// Every call proves who it is from: the mini app sends Telegram's signed "initData", which is verified here.
import { makeCtx, ensureBotName } from "./ui.js";
import { Question, formatQuestions, parseQuestions } from "./qparser.js";
import { beginSingleReplace } from "./flows.js";
import { parseBackup, restoreBackup, formatRestoreReport, buildBackup } from "./backup.js";
import { esc, slug } from "./engine.js";

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** Verifies Telegram WebApp initData. Returns the user object or null. */
export async function verifyInitData(initData, botToken, maxAgeSec = 86400) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const secret = await hmac(enc.encode("WebAppData"), botToken);
    const calc = hex(await hmac(new Uint8Array(secret), check));
    if (calc !== hash) return null;
    const age = Date.now() / 1000 - Number(params.get("auth_date") || 0);
    if (!(age >= -60 && age <= maxAgeSec)) return null;
    return JSON.parse(params.get("user"));
  } catch { return null; }
}

function cors(env) {
  let origin = "*";
  try { if (env.PAGES_URL && !env.PAGES_URL.includes("YOURNAME")) origin = new URL(env.PAGES_URL).origin; } catch { /* keep * */ }
  return { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-max-age": "86400", vary: "origin" };
}
const json = (env, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...cors(env) } });
const fail = (env, status, error) => json(env, { ok: false, error }, status);

const qView = (q) => ({ id: q.id, text: q.text, format: formatQuestions([q]), hasMedia: !!q.media, options: q.options.length });

export async function handleApi(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "");
  const c = makeCtx(env, ctx);
  c.origin = url.origin;
  await ensureBotName(c);

  // ---- encryption page (one-time token, no Telegram login needed)
  if (path.startsWith("/api/vault/")) return vault(c, request, url, path);

  // ---- mini app
  const auth = request.headers.get("authorization") || "";
  const user = auth.startsWith("tma ") ? await verifyInitData(auth.slice(4), env.BOT_TOKEN) : null;
  if (!user) return fail(env, 401, "Open this page from the bot (Telegram login is missing or expired).");
  const uid = user.id;
  const body = ["POST", "PUT"].includes(request.method) ? await request.json().catch(() => ({})) : {};

  if (path === "/api/quizzes" && request.method === "GET") {
    const list = await c.db.listQuizzes(uid);
    return json(env, { ok: true, quizzes: list.map((q) => ({ id: q.id, name: q.name, n: q.n })) });
  }
  const m = path.match(/^\/api\/quiz\/([a-z0-9]+)(?:\/questions?(?:\/(\d+))?(?:\/(poll))?)?$/);
  if (!m) return fail(env, 404, "Not found");
  const [, quizId, rowIdS, sub] = m, head = await c.db.quizHead(quizId);
  if (!head || head.owner_id !== uid) return fail(env, 404, "That quiz isn't yours or doesn't exist.");
  const rowId = rowIdS ? Number(rowIdS) : null;

  if (rowId === null && request.method === "GET") {                       // search / list
    const term = (url.searchParams.get("q") || "").slice(0, 100), offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const { items, more } = await c.db.searchQuestions(head.qid, term, 30, offset);
    return json(env, { ok: true, quiz: { id: head.id, name: head.name, n: head.n_questions }, items: items.map((i) => ({ pos: i.pos + 1, ...qView(i.question) })), more });
  }
  if (rowId !== null && !sub && request.method === "GET") {
    const q = await c.db.getQuestion(head.qid, rowId);
    return q ? json(env, { ok: true, question: { pos: q.pos + 1, ...qView(q) } }) : fail(env, 404, "That question no longer exists.");
  }
  if (rowId !== null && !sub && request.method === "PUT") {                // replace / edit one question
    const old = await c.db.getQuestion(head.qid, rowId);
    if (!old) return fail(env, 404, "That question no longer exists.");
    const res = parseQuestions(String(body.text || ""));
    if (res.questions.length !== 1) return fail(env, 400, res.errors.length ? res.errors.map((e) => e.reason).join(" · ") : "I need exactly one question (starting with +).");
    const q = res.questions[0];
    if (q.needsMedia) q.media = old.media || null;       // ++ keeps the existing picture/video; without ++ the stem is removed
    if (!q.media && old.media && !q.needsMedia) q.media = null;
    q.needsMedia = false;
    await c.db.replaceQuestion(head.qid, rowId, q);
    ctx.waitUntil(c.tg.sendMessage(uid, `✏️ Question replaced in “${head.name}”. The previous version:\n\n<pre>${esc(formatQuestions([old]))}</pre>`, { parse_mode: "HTML" }).catch(() => {}));
    return json(env, { ok: true, question: qView({ ...q, id: rowId }) });
  }
  if (rowId !== null && !sub && request.method === "DELETE") {            // delete one question
    const old = await c.db.deleteQuestion(head.qid, rowId);
    if (!old) return fail(env, 404, "That question no longer exists.");
    ctx.waitUntil(c.tg.sendMessage(uid, `🗑 Deleted from “${head.name}”. In case you need it back, paste this into Add questions:\n\n<pre>${esc(formatQuestions([old]))}</pre>`, { parse_mode: "HTML" }).catch(() => {}));
    return json(env, { ok: true });
  }
  if (rowId !== null && sub === "poll" && request.method === "POST") {   // replace through a quiz poll sent in the chat
    const ok = await beginSingleReplace(c, uid, quizId, rowId, "📊 <b>Replace one question with a poll</b>");
    return ok ? json(env, { ok: true }) : fail(env, 409, "Finish or cancel what you are doing in the bot first.");
  }
  return fail(env, 405, "Not supported");
}

// ------------------------------------------------------- vault (browser-side encryption)
async function vault(c, request, url, path) {
  const env = c.env, token = url.searchParams.get("t") || "";
  const kind = path.endsWith("/backup") || path.endsWith("/send") ? "vault-encrypt" : "vault-decrypt";
  const t = await c.db.getToken(token, kind);
  if (!t) return fail(env, 403, "This link has expired. Ask the bot for a new one.");
  const uid = t.userId;
  if (path === "/api/vault/backup" && request.method === "GET") {           // plain text for the browser to encrypt
    const { folders, items } = await c.db.exportUser(uid);
    const text = buildBackup(folders, items, new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", await c.db.getPreset(uid));
    return json(env, { ok: true, text, quizzes: items.length });
  }
  if (path === "/api/vault/send" && request.method === "POST") {            // ciphertext back to the person's chat
    const body = await request.json().catch(() => ({}));
    if (!body.file || String(body.file).length > 4_000_000) return fail(env, 400, "Nothing to send.");
    await c.db.delToken(token);
    await c.tg.sendDocument(uid, `quizbot-encrypted-${new Date().toISOString().slice(0, 10)}.json`, String(body.file), "🔐 Your encrypted backup. Keep the password safe – without it the file can't be opened, not even by me. Restore it with Import.");
    return json(env, { ok: true });
  }
  if (path === "/api/vault/cipher" && request.method === "GET") return json(env, { ok: true, file: t.data.ciphertext });
  if (path === "/api/vault/restore" && request.method === "POST") {         // decrypted text from the browser
    const body = await request.json().catch(() => ({}));
    const lim = await c.limits(uid);
    const rep = await restoreBackup(c.db, uid, parseBackup(String(body.text || "")), { maxQuizzes: lim.quizzes, maxFolders: lim.folders });
    await c.db.delToken(token);
    await c.tg.sendMessage(uid, formatRestoreReport(rep)).catch(() => {});
    return json(env, { ok: true });
  }
  return fail(env, 405, "Not supported");
}
