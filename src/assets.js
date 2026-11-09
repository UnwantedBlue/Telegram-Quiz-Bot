// GIF / sticker FOUNDATION (the "#(GIF aided?) later" item): the owner stores a sticker or GIF under a name by replying
// to it with  /setasset <name>  (names used so far: loading). sendAsset() sends it if one is stored, and does nothing otherwise.
export async function sendAsset(c, chat, key) {
  try {
    const raw = await c.db.kvGet(`asset:${key}`);
    if (!raw) return null;
    const { type, id } = JSON.parse(raw);
    const method = { sticker: "sendSticker", animation: "sendAnimation" }[type];
    return await c.tg.call(method, { chat_id: chat, [type]: id });
  } catch { return null; }
}

export async function setAsset(c, msg, key) {
  const src = msg.reply_to_message || {};
  const found = src.sticker ? { type: "sticker", id: src.sticker.file_id } : src.animation ? { type: "animation", id: src.animation.file_id } : null;
  if (!key || !found) return c.send(msg.from.id, "Reply to a sticker or a GIF with /setasset <name> (for example: /setasset loading).");
  await c.db.kvSet(`asset:${key}`, JSON.stringify(found));
  return c.send(msg.from.id, `✅ Saved as “${key}”.`);
}
