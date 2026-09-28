---
name: deploy-vercel
description: Deploy the AI-secretary Telegram bot to Vercel for its single owner — collect the owner's inputs, provision Neon Postgres, set environment variables, deploy, register the Telegram webhook and verify with /api/health. Use when the user asks to deploy, redeploy, set up or configure the bot on Vercel.
---

# Deploy AI-secretary to Vercel

The bot serves exactly **one** Telegram user (`OWNER_TELEGRAM_ID`); everyone else is ignored. Work through the
steps in order. Prefer the Vercel MCP tools when they are connected; fall back to the Vercel CLI (`npx vercel`)
or to exact dashboard instructions for the user when a tool cannot do a step. Never print secret values back to
the user or commit them.

## Step 1 — ask the owner (one message, all questions at once)

Ask for these, with the "how to get it" hints. Do not continue until every **required** item is answered.

| # | What | Required | How the owner gets it |
|---|------|----------|-----------------------|
| 1 | **Telegram bot token** | yes | @BotFather → `/newbot` → copy the token `123456:ABC…` |
| 2 | **Owner's Telegram ID** — the only person the bot will answer | yes | Write to @userinfobot in Telegram, it replies with a number like `123456789`. A username is not enough — the ID must be numeric. |
| 3 | **Google OAuth Client ID and Client Secret** | yes | See "Google Cloud setup" below; you can walk the owner through it after the first deploy, because the redirect URI needs the Vercel domain |
| 4 | **OpenRouter API key** | yes | https://openrouter.ai/keys (needs credit on the account) |
| 5 | **ElevenLabs API key** (voice messages) | yes | https://elevenlabs.io → Profile → API keys |
| 6 | Google account type: corporate Google Workspace or personal Gmail? | yes | Determines the OAuth consent screen type (see below) |
| 7 | Vercel team/account and project name | no, default `ai-secretary` | — |
| 8 | Models: `LLM_MODEL` (must accept images), `LLM_MODEL_SUMMARY` | no | Defaults: `google/gemini-2.5-flash`, `anthropic/claude-sonnet-4.5` |

Also confirm access: the Vercel MCP server (or a `VERCEL_TOKEN` for the CLI) and the GitHub repository
`Mem341/AI-secretary`.

Generate these yourself (do not ask): `TELEGRAM_WEBHOOK_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET` —
each `openssl rand -hex 32`. **`ENCRYPTION_KEY` must never change after the first deploy** (it encrypts the stored
Google tokens); keep it in the Vercel env only.

## Step 2 — Vercel project

1. Create the project from the GitHub repository `Mem341/AI-secretary`, branch `main`, framework preset
   **Other**, no build command, root directory `/`. Git integration is preferred: every push to `main` redeploys.
   CLI alternative: `npx vercel link --yes --project ai-secretary` then `npx vercel deploy --prod`.
2. Node.js version comes from `package.json` (`22.x`).

## Step 3 — database (Neon Postgres, free)

Add **Neon** from the Vercel Marketplace to the project (Dashboard → project → Storage → Create Database →
Neon → Free plan, region close to Kyiv, e.g. `eu-central-1`). It sets `DATABASE_URL` for the project
automatically. The schema is created automatically on the first request — no manual migration.

## Step 4 — environment variables (Production)

| Variable | Value |
|----------|-------|
| `OWNER_TELEGRAM_ID` | answer #2 |
| `TELEGRAM_BOT_TOKEN` | answer #1 |
| `TELEGRAM_WEBHOOK_SECRET` | generated |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | answer #3 |
| `OPENROUTER_API_KEY` | answer #4 |
| `ELEVENLABS_API_KEY` | answer #5 |
| `ENCRYPTION_KEY` | generated, never rotate |
| `CRON_SECRET` | generated (Vercel Cron sends it as a Bearer token) |
| `LLM_MODEL`, `LLM_MODEL_SUMMARY`, `STT_MODEL` | optional |
| `PUBLIC_URL` | optional; defaults to `https://$VERCEL_PROJECT_PRODUCTION_URL`. Set it only for a custom domain. |
| `DATABASE_URL` | set by the Neon integration |

CLI: `printf '%s' "$VALUE" | npx vercel env add NAME production`. Redeploy after changing variables.

## Step 5 — deploy and find the production URL

Deploy to production. The production domain is `https://<project>.vercel.app` (or the custom domain).
**Deployment Protection:** production must be publicly reachable (Telegram and Google call it). If
`/api/health` answers with a Vercel login page / 401, turn protection off for production
(Settings → Deployment Protection).

## Step 6 — Google Cloud setup (the owner does this in the browser; guide them)

1. https://console.cloud.google.com → create a project → APIs & Services → Library → enable **Google Calendar API**.
2. OAuth consent screen:
   - corporate Workspace → type **Internal**;
   - personal Gmail → type **External**, then **Publish app** (status *In production*). Explain the "unverified
     app" warning is expected for a private app. **Do not leave it in "Testing"**: Google expires refresh tokens
     of apps in testing after 7 days and the calendar would silently disconnect every week.
   - scopes: `openid`, `email`, `.../auth/calendar.events`.
3. Credentials → Create credentials → OAuth client ID → **Web application** → Authorized redirect URI exactly:
   `https://<production-domain>/api/oauth/callback`
4. Copy the Client ID / Secret into the Vercel env (Step 4) and redeploy.

## Step 7 — Telegram webhook

```bash
TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… PUBLIC_URL=https://<production-domain> npm run telegram:setup
```

It registers `https://<production-domain>/api/telegram` with the secret header and sets the command menu.

## Step 8 — verify

1. `GET https://<production-domain>/api/health` must return `"ok": true` with `"database": true` and
   `"telegram_webhook": true`. A 500 lists the missing variables by name — fix and redeploy.
2. Ask the owner to open the bot in Telegram and send `/start`, fill in the profile, press
   **«Підключити Google Calendar»** and grant access. The bot confirms with the number of events it sees.
3. `/api/health` should now show `"owner_started": true, "calendar_connected": true`.
4. Smoke test: the owner writes «зустріч з тестом завтра о 10:00», presses **«Створити»**, and the event appears
   in Google Calendar.
5. Check that a stranger is ignored: a message from another Telegram account gets no reply.

## Troubleshooting

- Function logs: Vercel MCP runtime logs, or Dashboard → project → Logs. The owner also receives errors in
  Telegram and can list the latest with `/errors`.
- "Доступ до Google Calendar втрачено" — the refresh token was revoked or expired (consent screen left in
  Testing); fix the consent screen and reconnect via `/settings`.
- Changing `OWNER_TELEGRAM_ID` hands the bot to another person; the old owner's data stays in the database.
