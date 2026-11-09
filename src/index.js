// Entry point of the Worker: Telegram webhook, mini-app API, one-time setup, daily clean-up.
import { QuizRun } from "./run.js";
import { handleApi } from "./api.js";
import { handleUpdate } from "./bot.js";
import { DB } from "./db.js";
import { Tg } from "./tg.js";
import { COMMANDS } from "./ui.js";

export { QuizRun };

const ALLOWED = ["message", "callback_query", "poll_answer", "inline_query", "pre_checkout_query", "my_chat_member"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, ctx);
      if (url.pathname === "/tg" && request.method === "POST") {
        if (!env.WEBHOOK_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
        const update = await request.json();
        await handleUpdate(env, update, ctx, url.origin);
        return new Response("ok");
      }
      if (env.WEBHOOK_SECRET && url.pathname === `/setup/${env.WEBHOOK_SECRET}`) return await setup(env, url);
    } catch (e) {
      console.error("fetch failed", e && e.stack || e);
      return new Response("ok");                    // never make Telegram retry a broken update forever
    }
    return new Response("Quiz bot is running.", { headers: { "content-type": "text/plain" } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(new DB(env.DB).purge());
  },
};

async function setup(env, url) {
  const tg = new Tg(env.BOT_TOKEN);
  const me = await tg.call("getMe");
  await new DB(env.DB).kvSet("bot_username", me.username);
  await tg.call("setWebhook", { url: `${url.origin}/tg`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ALLOWED, max_connections: 40, drop_pending_updates: false });
  await tg.call("setMyCommands", { commands: COMMANDS.slice(0, 22).map(([command, description]) => ({ command, description })) });
  return new Response(JSON.stringify({
    ok: true, bot: "@" + me.username, webhook: `${url.origin}/tg`,
    todo: [
      "In @BotFather: /setinline (turn inline mode on) so the Share button works.",
      "In @BotFather: /newapp -> pick this bot -> set the Web App URL to your GitHub Pages address (PAGES_URL); use its short name as MINIAPP_SHORTNAME.",
      "Optional: /setprivacy -> Disable, if you want the bot to read plain messages in groups (commands and mentions work without it).",
    ],
  }, null, 2), { headers: { "content-type": "application/json" } });
}
