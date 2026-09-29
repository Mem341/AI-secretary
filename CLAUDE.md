# AI-secretary

Open-source personal Telegram secretary: anyone deploys their own copy on **Vercel** (the only platform); each copy serves one owner
(`OWNER_TELEGRAM_ID`). Creates Google Calendar meetings from text, voice, forwarded chats and screenshots, reports
calendar changes, reschedules/cancels by reply, and works with Gmail. Node.js + TypeScript, **no database**,
OpenRouter (LLM, and speech-to-text for voice), optional Zoom.

## Deploying

**Read `AGENTS.md` first.** The project is finished: never port or redesign it, ask the user only for env values,
report as "Реализовано / Не реализовано".

Vercel only (no AWS, no Cloudflare): `.claude/skills/deploy-vercel/SKILL.md` (`/deploy-vercel`).

The skill collects exactly four things from the owner — Telegram bot token, their Telegram ID, OpenRouter key,
the JSON of a Google "Desktop app" OAuth client (`GOOGLE_CLIENT_JSON`, no redirect URI) — validates them, and never asks about optional extras.
The human version of that list with step-by-step instructions is `docs/what-you-need.md`. After any deploy, opening `/api/setup` registers the Telegram
webhook and redirects to the bot; `/api/health` shows the state.

## Layout

- `api/` — Vercel Functions (thin wrappers); `vercel.json` — function limits, `/` redirect, daily cron.
- `src/app.ts` — HTTP handlers, setup page, job runner wiring; `src/vercel.ts` — Vercel bootstrap. `/api/setup` only
  registers the Telegram webhook and redirects to the bot (no status page, no how-tos); machine checks are
  `/api/health`.
- `src/jobs.ts` — background jobs (run after the response, 3 attempts).
- `src/agent/` — a strict port of the owner's n8n flows: `index.ts` (Normalize Input / Build Agent Context →
  Supervisor with `calendar_agent` and `gmail_agent` as tools → Parse Agent Output), `runner.ts` (tool-calling
  loop over OpenRouter), `prompts.ts` (the n8n prompts), `calendarTools.ts` (the n8n Calendar MCP tools),
  `gmailTools.ts` (the n8n Gmail sub-workflow tools), `memory.ts` (one-session window memory), `html.ts`,
  `route.ts` (the Supervisor's keyword routing table in code: an obvious calendar/mail request, or a reply to the
  bot's notice, goes straight to its agent; anything unclear goes to the Supervisor). No Think tool. ✅ / ❌ under an
  invitation (`accept:` / `decline:`) is answered in code with the same RSVP tool, no model call.
  Models per request (`modelFor`): text → `AGENT_MODEL` (gpt-oss-120b), pictures → `VISION_MODEL` (qwen3.7-flash),
  voice → `LLM_MODEL` (gpt-6-luna-pro); a `ModelError` before any write tool ran retries the request on `LLM_MODEL`,
  never after a write. `npm run eval:models` (`eval/`, real OpenRouter, fake tools) compares models on typical
  requests. Keep prompts and tool names in line with the n8n originals.
- `src/bitrix/` — optional Bitrix24 tasks via an incoming webhook (`BITRIX_WEBHOOK_URL`, rights: tasks, user, im): `client.ts` (REST; a task's discussion is its «Чат завдання» (im chat, `im.chat.get` by entity) plus old comments; tasks
  are only read, commented and created — never closed, changed or deleted; keep it that way), `names.ts` (people by
  name in any case form / alphabet), `report.ts` (Excel: tasks, stage, status, state from comments by AI, analytics),
  `menu.ts` (/bitrix buttons `bx:…`, no AI; «📊 Excel-звіт» first asks what to export, `REPORT_SCOPES`). The `bitrix_agent` (`agent/bitrixTools.ts`, `bitrixPrompt`) joins the
  Supervisor and `route.ts` when it is configured. `lib/xlsx.ts` writes .xlsx without dependencies.
- `src/bot/` — `onboarding.ts` (/start, /help), `settings.ts` (/settings: what is connected, reminder times and the
  morning list chosen with `set:…` buttons, no AI), `owner.ts` (profile from Telegram/Google/env),
  `contacts.ts` (names → emails from calendar attendees). Commands: /start /settings /bitrix /reset /help; everything else
  goes to the agents.
- `src/google/` — OAuth (grant in a pinned message), Calendar API + push notices (`sync.ts`: n8n invitation
  format with `accept:{id}` / `decline:{id}` buttons), `reminders.ts` (meeting reminders), `digest.ts` (the morning report: meetings with guests/links/overlaps/free
  windows plus the blocks ticked in /settings → ☀️ — invitations with ✅/❌, mail, AI mail summary, Bitrix24, tomorrow; at
  the owner's time via a `digest:` signal in the signal calendar, the daily cron only as a fallback),
  Gmail API + Pub/Sub push (`gmailPush.ts`: n8n WF3 "📧 Нова пошта!" format).
- Meeting reminders use Google as the clock — no cron, no outside service (the owner forbade both). Each chosen time
  gives BOTH a Telegram message and a Google Calendar notification (channels chosen in /settings, `OwnerSettings.n`):
  the meeting carries popups; its Telegram email signals sit on a shadow event in the bot's own calendar
  «AI-secretary · сигнали» (`google/signals.ts`, scope calendar.app.created) — Google allows only 5 reminders per event.
  `applyEmailReminders` keeps both in step (connect, daily, calendar push, settings);
  Google sends the email at that minute, Gmail push wakes the bot, `handleReminderEmail` sends the Telegram reminder
  and trashes the email. The Gmail push itself is set up by the bot in the OAuth client's project (`pubsub.ts`
  `setupGoogleWake`, scope pubsub; the owner only enables the Cloud Pub/Sub API); /settings → ⏰ → «Перевірити» (`wake.ts`
  `reportWake`) checks each link in plain words and sends a test signal (`TEST_PREFIX`) that comes back as «✅ Тест пройдено».
- `vercel.json`: the one daily cron (digest, renewing the calendar channel and the Gmail watch) — do not add more;
  /api/cron/reminders stays as a manual check of reminders.
- `src/telegram/hidden.ts` — data hidden inside the bot's own messages; `src/session.ts` — short-lived
  in-instance memory; `src/zoom/` — Zoom API.

## Where state lives (there is no database)

- Google grant: encrypted in ONE pinned message of the owner's chat (`loadGrant` reads it via getChat). The owner's
  /settings choices (`OwnerSettings`: reminder minutes, morning list) sit unencrypted, and Bitrix24 / Zoom keys the
  owner gave in /settings (`Integrations`, `bot/connect.ts`) sit encrypted, in the same message's hidden data; saving
  edits that message in place (or sends and pins it when Google is not connected yet). `integrations.ts` fills
  `env` from them at the start of every update and job, unless a deployment variable is set.
- "Which meeting/email is this reply about": hidden in the bot's own notices (`hiddenData` / `readHidden`) and
  passed to the agents as `[eventId: …]` / `[messageId: …]` in the reply context. Other hidden data likewise lives
  in the bot's own messages; Telegram returns it with button presses and replies. Keep it under
  `MAX_HIDDEN`.
- Calendar: read live; what the bot already reported is a private extended property on each event
  (`aisStart`, `aiSecretaryDraft`, `aisBotCancel`, `aisRsvp` — guests' answers already reported), written with
  If-Match on the event's etag before a notice or reminder is sent (`claimPrivate`): parallel copies of the bot
  handling the same push race there and only one sends. Gmail: a hidden label marks reported emails.
- The agents' chat memory (`agent/memory.ts`, the owner asked for it) — n8n's Window Buffer Memory (LangChain's
  buffer window memory) without a database: ONE session, ONE file, memory.json, in the bot's hidden Drive folder
  (`google/drive.ts`, scope `drive.appdata`), shared by all agents: the last 20/50/100 question–answer pairs (owner's
  choice, `OwnerSettings.m`), a new pair pushes out the oldest; plus facts the agents save with `remember_fact`. The
  latest `SEND` pairs (12 h) go to the model as real chat turns (`conversationHistory`) with the rule not to redo what
  was done (`conversationBlock`); each answer keeps the agent that gave it, so a reply to the bot's question goes back
  to that agent (`pendingAgent`, 30 min). `delete_event` refuses unless the CURRENT message asks (`deletionAllowed`);
  several / «all» only after «так». In JS regexes `\b` does not work next to Cyrillic letters. Loaded at the start of
  an agent request, written after the answer. Without the Drive scope it stays in the instance.
- Bursts of forwarded messages (`session.ts`): in memory, self-expiring; losing it may cost a duplicate, never data.
  Do not add a database or any other store.

## Rules

- The bot answers only `OWNER_TELEGRAM_ID`; keep every entry point behind that check.
- Keep the deployment generic (no company-specific names or data). The app boots with only `OWNER_TELEGRAM_ID`,
  `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`; Google keys are collected at deploy but the app
  must still start without them; new features must be optional or derived.
- The agents act as the n8n prompts say: calendar requests are carried out directly; sending or trashing mail
  needs a preview and the owner's "yes" in the conversation. Keep the bot's own Calendar writes silent: set
  `aisStart` in the same write (or `aisBotCancel` before a delete).
- Keep the Vercel `api/*` files and the docs' URLs in sync when adding an endpoint. Do not add other platforms.
- Compiles to CommonJS (`tsconfig.json`), which Vercel's Node runtime needs for extensionless imports.
- Every change the owner would notice gets a release in `src/changelog.ts` (next number, newest first, plain words):
  after the deploy the bot tells the owner once what was added/changed (`bot/news.ts`, the last seen number is
  `OwnerSettings.v`) and checks live whether the owner must do something (reconnect Google, the reminders check).
- Check before pushing: `npm run typecheck && npm test` (tests mock all outbound HTTP; `test/helpers.ts` has a fake Telegram that keeps messages, entities and the pin).
