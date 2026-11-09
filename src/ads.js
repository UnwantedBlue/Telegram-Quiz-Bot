// Ads FOUNDATION (the "#Ad" item of the spec): sponsored lines for free users, kept in the `ads` table.
// The owner manages them with /adadd, /adlist, /addel. This is where an ad network (e.g. Adsgram) or affiliate
// links would plug in: replace pickAd() with a call to that network. Nothing is shown while the table is empty.
import { esc } from "./engine.js";
import { isPremium } from "./premium.js";
import { kb, urlBtn } from "./tg.js";

export async function pickAd(env, db) { return db.randomAd(); }

/** Send one sponsored message after a result, to people without premium. Never throws. */
export async function maybeSponsor(env, db, tg, chatId, userId) {
  try {
    if (await isPremium(env, db, userId)) return;
    const ad = await pickAd(env, db);
    if (!ad) return;
    await tg.sendMessage(chatId, `📣 <i>Sponsored</i>\n${esc(ad.text)}`, {
      parse_mode: "HTML", reply_markup: ad.url && /^https?:\/\//.test(ad.url) ? kb([urlBtn("Open", ad.url)]) : undefined,
    });
  } catch { /* ads must never break a quiz */ }
}
