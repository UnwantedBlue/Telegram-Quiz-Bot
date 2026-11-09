# Quiz Bot – free cloud edition

The same Telegram quiz bot, rebuilt so it **runs 24/7 without your phone and without paying for hosting**, with the
update list from your notes implemented. The old Python files are no longer needed (your old `/backup` file imports
into the new bot with `/import`).

## Where each part lives (all free, no card)

| Piece | Where | Why |
|---|---|---|
| Menus, folders, create, backup, taking a quiz | **Cloudflare Worker** (V8 isolate, webhook) | Free, never sleeps. Telegram calls it only when something happens. |
| Question timers | **Durable Object alarm** (one per running quiz) | Fires at the exact second; a free cron can't be trusted for a 15 s question. |
| Quizzes, folders, presets, history, saved mistakes | **Cloudflare D1** (free SQLite) | The GitHub page has nowhere to store a question. |
| Search / edit / delete one question | **GitHub Pages** mini app (`miniapp/`) | Static page; it only talks to the Worker. |
| Pictures, videos, audio in questions | **Telegram itself** (stored as `file_id`) | Free and unlimited; nothing to host. Workers *can* send media by `file_id`. |
| Password-encrypted backup | **Your browser** (`miniapp/vault.html`) | Heavy crypto would exceed the free 10 ms CPU limit; doing it in the browser is also safer – the password never reaches the bot. |

Free limits I checked (Nov 2026): Workers 100,000 requests/day, 10 ms CPU and 50 outgoing calls per request;
D1 5 M reads + 100 k writes per day; Durable Objects (SQLite-backed, alarms included) 100,000 requests/day.
That is plenty for a personal / classroom bot; a very busy public bot would need the $5 plan.

## Deploy (works from a phone browser)

1. **GitHub:** make a *public* repository and upload this whole folder (public is needed for free GitHub Pages).
2. **Cloudflare** (free account) → *Storage & databases → D1 → Create* a database named `quizbot`. Copy its ID into
   `wrangler.toml` (`database_id`). Also copy your **Account ID** and make an **API token** (template “Edit Cloudflare
   Workers”, and add *D1: Edit*).
3. **GitHub → Settings → Secrets and variables → Actions**, add: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `BOT_TOKEN` (from @BotFather), `WEBHOOK_SECRET` (any long random text: letters, digits, `_` `-`).
4. Edit `wrangler.toml`: `OWNER_ID` (your Telegram id), `PAGES_URL` (`https://<you>.github.io/<repo>`).
   Commit → the **Deploy bot** action runs. Your Worker address is shown in Cloudflare (`https://quizbot.<name>.workers.dev`).
5. Edit `miniapp/config.js` with that Worker address. **Settings → Pages → Source: GitHub Actions**; commit again.
6. Open **`https://<worker address>/setup/<WEBHOOK_SECRET>`** once. It connects Telegram to the Worker and sets the command list.
7. In **@BotFather**: `/setinline` (turns on the Share button); `/newapp` → this bot → Web App URL = `PAGES_URL`; give it a short
   name and put that name in `MINIAPP_SHORTNAME` in `wrangler.toml` (this makes the ○-dash links work). Commit.
8. Optional “Sort in topics”: get a free key at aistudio.google.com and add it as a Worker secret named `GEMINI_API_KEY`
   (Cloudflare → Worker → Settings). Free-tier Gemini data may be used by Google for training; the bot tells users that.

Local tests: `npm test` (32 tests on the parser, scoring, flows, timers, group quizzes, API, payments…).

## Your notes → where they are

* **Home** with the exact button grid, Cancel as the first message of every sequence, cleanup when a sequence ends (final message + files stay).
* **Create:** Quiz (`/createquiz`: text, `.txt`, **polls** through a poll button in the text field, quiz description, optional
  question descriptions `//`, media stems `++`, per-question time `:14` / `:1-72-85`, “ask time for every question” toggle,
  then the **bulk settings** whose first button is *Apply my default*), Quick quiz, Bulk paste (`/bulkcreate` = the old simple flow). Forms: placeholder button.
* **Bulk settings:** timer (5/10/15/30, custom, untimed, per question), negative marking, pass mark, shuffle (none/questions/options/both),
  retake (enabled/disabled/**clone = two links**), transparency (locked / unlocked / open with their switches), review (+ Gemini “Sort in topics”;
  off → ask name & ID, send result to creator), single-answer lock. Defaults are marked ★.
* **View:** My quizzes (folders as inline buttons, with remove/delete quiz, rename, share, export, delete folder with the `/unfolder` choice), History, Review
  (💾 Save mistakes → Pending / Resolved, 🧪 Sandbox practice). Forms: placeholder.
* **Edit:** per quiz: add questions, **mini app** (search, replace/edit one, delete one – deleted/old versions are sent back to the chat), replace entire quiz, description, rename, settings, delete.
* **Default:** runs the settings panel and saves it as your preset. **Channels / Groups:** register, start a quiz as admin, channel “as is” or a customised copy;
  members can start with `/quiz <id>`; untimed quizzes ask for a bulk time first; leaderboard in groups. Rank among everyone, attempt tracking, Share + Start-in-group buttons.
* **Store / Premium / Backup / Import / Export:** Telegram Stars payments, plain and encrypted backup, import of backups and `name: link` lists, export of a quiz / folder / everything.

## Things I had to interpret – please check

* **The “○----” strip:** when a quiz is created, the Cancel-button message turns into a row of links (○ = question 1, each `-` = next question) that open the mini app on that question.
* **“Quick quiz”:** paste questions, `/quesdone`, quiz made at once with your default settings.
* **Transparency:** *unlocked* = how the bot always worked (default). *Locked + hide answer* uses plain polls (so the right answer isn’t shown) and the answers appear in the review at the end.
  *Open + retract* uses plain polls and a ✅ Next button, because only plain polls let people take a vote back. Telegram can’t re-open a closed poll, so “re-open after finishing” **re-sends the polls**.
* **Review off** by default only when answers are hidden; *exam mode* (name/ID asked, result to creator) is a switch inside it and is a premium item.
* **“Edit with a poll” can’t be pre-filled:** Telegram has no way to open a poll with text already in it. The mini app’s “Replace with a poll” asks you to send a quiz poll in the chat instead.
* **Timers:** Telegram’s own countdown supports 5–600 s. Shorter/longer times (up to 7 days) are closed by the bot’s alarm instead (no countdown bar).
* **Premium, ads, paid quizzes, GIF/sticker hooks** are the “#” foundations: limits/flags, Stars invoices, an ads table (`/adadd`), `/setasset`. Forms and a real ad network are not built.
* The group “wake-up by mention” note is satisfied by the webhook: commands and mentions reach the bot, and nothing needs polling.

## Honest limits

* Everything was tested with simulated Telegram/Cloudflare (32 automated tests), **not against the live services**. Expect to fix small things on first deploy.
* Free Workers allow 10 ms of CPU per request, so backups/imports are capped at 1.5 MB.
* Channel polls are anonymous (Telegram rule): no leaderboard there.

## Question format

See `sample_quiz.txt`. `+question`, `//description`, options (`*` = correct), `=explanation`, `:time`, `++` before a `+` line = needs a picture/video/audio.
