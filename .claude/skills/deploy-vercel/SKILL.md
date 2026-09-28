---
name: deploy-vercel
description: Deploy a personal copy of the open-source AI-secretary Telegram bot to the user's own Vercel account — ask the few inputs only the user can provide, create the project with Neon Postgres, set environment variables, deploy, and finish on the /api/setup page. Use when the user asks to deploy, redeploy, set up or configure the bot on Vercel.
---

# Deploy AI-secretary to Vercel

AI-secretary is open source: anyone can run their own copy on their own Vercel account. Each copy serves exactly
**one** Telegram user — the person deploying it (`OWNER_TELEGRAM_ID`); everyone else is ignored.

Prefer the Vercel MCP tools when they are connected; fall back to the Vercel CLI (`npx vercel`) or to exact
dashboard instructions when a tool cannot do a step. Never echo secret values back or commit them.

## Step 1 — ask the user (one message, all at once)

| # | What | Required | How the user gets it |
|---|------|----------|----------------------|
| 1 | Telegram **bot token** | yes | @BotFather → `/newbot` → token like `123456:ABC…` |
| 2 | Their **numeric Telegram ID** — the only person the bot will answer | yes | Message @userinfobot; it replies with a number. A @username does not work. |
| 3 | **OpenRouter API key** | yes | https://openrouter.ai/keys (the account needs credit) |
| 4 | Google Calendar & Gmail now or later? | no | Needs a Google OAuth client; the /api/setup page walks through it with the exact redirect URI after the first deploy |
| 5 | ElevenLabs API key for voice messages | no | https://elevenlabs.io/app/settings/api-keys |
| 5a | Zoom (Server-to-Server OAuth app), Gmail new-mail push (Pub/Sub topic) | no | Optional; the /api/setup page lists the steps |
| 6 | Which repository to deploy | no | Their fork, or the public `github.com/Mem341/AI-secretary` |

Nothing else is needed: the webhook secret and encryption key are derived from the bot token, the database URL
comes from the Neon integration, and the public URL from Vercel.

## Step 2 — project and database

1. Create a Vercel project from the repository (framework preset **Other**, no build command, root `/`).
   Easiest for the user: the **Deploy with Vercel** button in README.md (it asks for the three variables and offers
   Neon). CLI alternative: clone, `npx vercel link --yes`, then deploy.
2. Add **Neon** Postgres (Marketplace, free plan) to the project: Dashboard → project → Storage → Create Database →
   Neon. It sets `DATABASE_URL`. The schema is created automatically on the first request.

## Step 3 — environment variables (Production)

Required: `OWNER_TELEGRAM_ID`, `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY` (+ `DATABASE_URL` from Neon).
Optional: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ELEVENLABS_API_KEY`, `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`,
`ZOOM_CLIENT_SECRET`, `GMAIL_PUBSUB_TOPIC`, `LLM_MODEL`, `LLM_MODEL_SUMMARY`, `CRON_SECRET`, `ENCRYPTION_KEY`,
`PUBLIC_URL` (custom domain only). See `.env.example`. The owner can also switch the OpenRouter model in /settings.

CLI: `printf '%s' "$VALUE" | npx vercel env add NAME production`. Redeploy after changing variables.

## Step 4 — deploy and open the setup page

Deploy to production and open `https://<project>.vercel.app/` — it redirects to `/api/setup`, which:

- registers the Telegram webhook automatically;
- shows a checklist: variables, database, Telegram bot, Google Calendar, voice, owner connected;
- for Google, gives the exact **Authorized redirect URI** and the steps.

If the page is a Vercel login screen, production is behind Deployment Protection: turn it off for production
(Settings → Deployment Protection) — Telegram and Google must reach the app.

## Step 5 — Google Calendar (the user does this in the browser)

Follow the steps on /api/setup: enable Google Calendar API and Gmail API, OAuth consent screen, create a
**Web application** OAuth client with the redirect URI from the page, add `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`, redeploy. Consent screen type:

- Google Workspace account → **Internal** (no limits).
- Personal Gmail → **External + Publish app**. Gmail is a Google "restricted" scope, so on sign-in Google shows
  "this app isn't verified" — *Advanced → Continue* is fine for a personal bot (unverified apps are capped at
  100 users). Left in *Testing*, Google expires the grant every 7 days (the bot asks to reconnect). Google's app
  verification removes the warning if the user wants that.

## Step 6 — verify

1. `/api/setup` shows everything green except the optional items the user skipped.
2. The user sends `/start` to their bot, fills in the profile, presses «Підключити Google Calendar»; the bot confirms
   with the number of events it sees.
3. Smoke test: «зустріч з тестом завтра о 10:00» → «Створити» → the event appears in Google Calendar.
4. A message from another Telegram account gets no reply.
5. `/api/health` returns JSON with `"ok": true` for automated checks.

## Troubleshooting

- Function logs: Vercel MCP runtime logs or Dashboard → Logs. The bot also reports errors to its owner; `/errors`
  lists the latest.
- «Доступ до Google Calendar втрачено» — consent screen left in Testing, access revoked, or the bot token /
  `ENCRYPTION_KEY` changed. Fix the cause and reconnect via `/settings`.
- To hand the bot to someone else, change `OWNER_TELEGRAM_ID`.
