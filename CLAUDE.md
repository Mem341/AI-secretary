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
Google OAuth client ID + secret — validates them, and never asks about optional extras.
The human version of that list with step-by-step instructions is `docs/what-you-need.md`. After any deploy, the `/api/setup` page registers the Telegram
webhook and shows what is left to configure (Google, Gmail push, Zoom).

## Layout

- `api/` — Vercel Functions (thin wrappers); `vercel.json` — function limits, `/` redirect, daily cron.
- `src/app.ts` — HTTP handlers, setup page, job runner wiring; `src/vercel.ts` — Vercel bootstrap.
- `src/jobs.ts` — background jobs (run after the response, 3 attempts).
- `src/bot/` — `meetings.ts` (meeting cards + the text router), `actions.ts` (reschedule/cancel/note by reply),
  `mail.ts` (Gmail agent), `onboarding.ts` (/start, /settings), `owner.ts` (profile from Telegram/Google/env),
  `contacts.ts` (names → emails from calendar attendees), `card.ts`.
- `src/google/` — OAuth (grant in a pinned message), Calendar API + push notices, Gmail API + Pub/Sub push.
- `src/telegram/hidden.ts` — data hidden inside the bot's own messages; `src/session.ts` — short-lived
  in-instance memory; `src/zoom/` — Zoom API.

## Where state lives (there is no database)

- Google grant: encrypted in ONE pinned message of the owner's chat (`loadGrant` reads it via getChat).
- Cards, pending actions, "which meeting/email is this reply about": hidden in the bot's own messages
  (`hiddenData` / `readHidden`); Telegram returns them with button presses and replies. Keep them under
  `MAX_HIDDEN`.
- Calendar: read live; what the bot already reported is a private extended property on each event
  (`aisStart`, `aiSecretaryDraft`, `aisBotCancel`). Gmail: a hidden label marks reported emails.
- Bursts of forwarded messages and "the bot just asked X": `session.ts`, in memory, self-expiring; losing it may
  cost a duplicate, never data. Do not add a database or any other store.

## Rules

- The bot answers only `OWNER_TELEGRAM_ID`; keep every entry point behind that check.
- Keep the deployment generic (no company-specific names or data). The app boots with only `OWNER_TELEGRAM_ID`,
  `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`; Google keys are collected at deploy but the app
  must still start without them; new features must be optional or derived.
- Anything that writes to the calendar or sends/removes mail goes through a confirmation card; read-only and
  easily reversible actions may run at once. Keep the bot's own Calendar writes silent: set `aisStart` in the same write (or `aisBotCancel` before a delete).
- Keep the Vercel `api/*` files and the docs' URLs in sync when adding an endpoint. Do not add other platforms.
- Compiles to CommonJS (`tsconfig.json`), which Vercel's Node runtime needs for extensionless imports.
- Check before pushing: `npm run typecheck && npm test` (tests mock all outbound HTTP; `test/helpers.ts` has a fake Telegram that keeps messages, entities and the pin).
