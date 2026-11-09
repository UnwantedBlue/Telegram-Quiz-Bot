// Minimal Telegram Bot API client for Workers. Retries network trouble a little, waits out short rate limits,
// and tells "Telegram can't be reached" (transient) apart from "Telegram refused this request" (permanent).

export class TgError extends Error {
  constructor(message, { code = 0, retryAfter = 0, transient = false } = {}) {
    super(message);
    this.code = code; this.retryAfter = retryAfter; this.transient = transient;
  }
}

export class Tg {
  constructor(token, fetchImpl = (...a) => fetch(...a)) {
    this.token = token; this.fetch = fetchImpl;
  }

  /** patient=false: one quick retry only (used for clean-up calls where nobody waits for the result). */
  async call(method, params = {}, { patient = true, multipart = null } = {}) {
    const delays = patient ? [600, 1500] : [400];
    let net = 0, limited = 0;
    for (;;) {
      let res;
      try {
        const init = multipart
          ? { method: "POST", body: multipart() }
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) };
        res = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, init);
      } catch (e) {
        if (net >= delays.length) throw new TgError(`network: ${e.message}`, { transient: true });
        await sleep(delays[net++]);
        continue;
      }
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      if (body && body.ok) return body.result;
      const code = res.status, desc = (body && body.description) || `HTTP ${code}`;
      if (code === 429) {
        const wait = (body && body.parameters && body.parameters.retry_after) || 1;
        if (wait <= 3 && limited++ < 2) { await sleep(wait * 1000 + 300); continue; }
        throw new TgError("rate limited", { code, retryAfter: wait, transient: true });
      }
      if (code >= 500) {
        if (net >= delays.length) throw new TgError(desc, { code, transient: true });
        await sleep(delays[net++]);
        continue;
      }
      throw new TgError(desc, { code });
    }
  }

  // ---- convenience wrappers
  sendMessage(chat_id, text, extra = {}) {
    return this.call("sendMessage", { chat_id, text, link_preview_options: { is_disabled: true }, ...extra });
  }
  editMessageText(chat_id, message_id, text, extra = {}) {
    return this.call("editMessageText", { chat_id, message_id, text, link_preview_options: { is_disabled: true }, ...extra });
  }
  editMarkup(chat_id, message_id, reply_markup) {
    return this.call("editMessageReplyMarkup", { chat_id, message_id, reply_markup: reply_markup || { inline_keyboard: [] } }).catch((e) => {
      if (!/not modified/i.test(e.message)) throw e;
    });
  }
  answerCallback(id, text, alert = false) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text, show_alert: alert } : {}) }, { patient: false }).catch(() => {});
  }
  deleteMessage(chat_id, message_id) {
    if (!message_id) return Promise.resolve();
    return this.call("deleteMessage", { chat_id, message_id }, { patient: false }).catch(() => {});
  }
  async deleteMessages(chat_id, ids) {
    const list = [...new Set((ids || []).filter(Boolean))];
    for (let i = 0; i < list.length; i += 100)
      await this.call("deleteMessages", { chat_id, message_ids: list.slice(i, i + 100) }, { patient: false }).catch(() => {});
  }
  stopPoll(chat_id, message_id) {
    return this.call("stopPoll", { chat_id, message_id }, { patient: false }).catch(() => {});
  }
  /** Send a text file. */
  sendDocument(chat_id, filename, content, caption, extra = {}) {
    return this.call("sendDocument", {}, {
      multipart: () => {
        const f = new FormData();
        f.set("chat_id", String(chat_id));
        f.set("document", new Blob([content], { type: "text/plain" }), filename);
        if (caption) f.set("caption", caption);
        for (const [k, v] of Object.entries(extra)) f.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        return f;
      },
    });
  }
  /** Download a file the person sent (by file_id) as text. */
  async downloadText(file_id, maxBytes) {
    const info = await this.call("getFile", { file_id });
    if (info.file_size && info.file_size > maxBytes) throw new TgError("file too big");
    const res = await this.fetch(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`);
    if (!res.ok) throw new TgError(`download failed (${res.status})`, { transient: true });
    const buf = new Uint8Array(await res.arrayBuffer());
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\ufeff/, ""); }
    catch { return new TextDecoder("windows-1252").decode(buf); }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- keyboards
export const btn = (text, data) => ({ text, callback_data: data });
export const urlBtn = (text, url) => ({ text, url });
export const webBtn = (text, url) => ({ text, web_app: { url } });
export const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
export const noKb = { inline_keyboard: [] };

/** Media types a question stem can have, and the Bot API method that sends each. */
export const MEDIA_METHODS = {
  photo: ["sendPhoto", "photo"], video: ["sendVideo", "video"], audio: ["sendAudio", "audio"], voice: ["sendVoice", "voice"],
  animation: ["sendAnimation", "animation"], document: ["sendDocument", "document"], video_note: ["sendVideoNote", "video_note"],
};

/** Pull the file out of a message the person sent as a question stem. */
export function mediaFromMessage(msg) {
  if (msg.photo && msg.photo.length) return { type: "photo", id: msg.photo[msg.photo.length - 1].file_id };
  for (const t of ["video", "audio", "voice", "animation", "video_note", "document"]) if (msg[t]) return { type: t, id: msg[t].file_id };
  return null;
}

export const userLabel = (u) => (u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id) : "someone");
