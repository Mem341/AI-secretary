---
name: deploy-vercel
description: Deploy a personal copy of the open-source AI-secretary Telegram bot to the user's own Vercel account. Collect exactly four inputs from the user (Telegram bot token, their Telegram ID, OpenRouter key, Google OAuth client ID + secret), validate them, create the project with Neon Postgres, set env vars, deploy, add the Google redirect URI, finish on /api/setup. Use when the user asks to deploy, redeploy, set up or configure the bot on Vercel.
---

# Deploy AI-secretary to Vercel

AI-secretary is open source. Anyone can run their own copy on their own Vercel account. Each copy answers exactly
**one** Telegram user, the person deploying it (`OWNER_TELEGRAM_ID`); everyone else is ignored.

Your job is to take the user from nothing to a working bot. They must be able to create a meeting in their
Google Calendar from Telegram. Ask only for what they alone can provide; do everything else yourself.

## Rules of conduct

- **Talk in the user's language.** Russian or Ukrainian if they write that way.
- **Ask for exactly the four items in Step 1, in one message.** Do not ask about anything else:
  - not ElevenLabs/voice, Zoom, Gmail push, Pub/Sub, the model, a domain, `CRON_SECRET` or `ENCRYPTION_KEY`;
  - not the database (you create it on Vercel);
  - not the repository (use the public `github.com/Mem341/AI-secretary` unless they mention a fork).

  Optional extras are mentioned once, in the final report.
- **If the user lacks an item,** send the steps for that item from `docs/what-you-need.md` (§1–§4). Translate
  them if needed and keep the links. Do not send the steps for items they already have.
- **Validate every value (Step 2) before using it.** A wrong value found now saves a broken deploy.
- **Secrets:**
  - never repeat them back, never write them into repository files, never commit them;
  - refer to them as "токен бота", "ключ OpenRouter" and so on;
  - keep them in shell variables only for the commands that need them.
- Prefer the Vercel MCP tools when connected. Otherwise use the Vercel CLI (`npx vercel`). When neither can do a
  step, give the user exact dashboard clicks.

## Step 1 — collect the four inputs

Send this (adapted to the user's language) and wait for the answers:

> Для запуску бота потрібні 4 речі:
>
> 1. **Токен Telegram-бота** — @BotFather → `/newbot` → токен вигляду `7412345678:AAH…`
> 2. **Ваш Telegram ID** — число від @userinfobot (бот відповідатиме лише вам)
> 3. **Ключ OpenRouter** — https://openrouter.ai/keys, вигляду `sk-or-v1-…` (на рахунку мають бути кошти)
> 4. **Google Client ID і Client Secret** — для календаря й пошти. Якщо ще немає, скажіть — дам покрокову
>    інструкцію на 5 хвилин.
>
> Також: у вас **Google Workspace** (пошта компанії) чи **звичайний Gmail**?

The Workspace/Gmail answer decides the consent-screen type (§4 step 3–4 of `docs/what-you-need.md`).

If the user explicitly wants to deploy **without Google for now**, proceed with items 1–3. In that case:
- skip Steps 2d and 4;
- say plainly that meetings will not reach the calendar until the Google keys are added (then redeploy).

## Step 2 — validate (never print the values)

| Item | Format check | Live check |
|------|--------------|------------|
| a. Bot token | `^\d{6,}:[A-Za-z0-9_-]{30,}$` | `curl -s https://api.telegram.org/bot$TOKEN/getMe` → `"ok":true`; tell the user the bot's @username |
| b. Telegram ID | digits only, not a @username, not the bot's own ID (the part of the token before `:`) | — |
| c. OpenRouter key | starts with `sk-or-` | `curl -s -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key` → HTTP 200; if `limit_remaining` is 0 or the balance is empty, ask them to top up |
| d. Google client | ID ends with `.apps.googleusercontent.com`; secret usually starts with `GOCSPX-` | Checked for real in Step 5 when the owner connects |

On a failed check:
1. Say which item is wrong and why (e.g. "Telegram відповів 401 — токен недійсний").
2. Ask for that item only.

## Step 3 — project, database, variables

1. **Create the Vercel project** from the repository:
   - framework preset **Other**, no build command, root `/`;
   - project name `ai-secretary` unless the user chose one.

   If the tools can't create it, hand the user the **Deploy with Vercel** button from README.md. It asks for the
   variables and offers Neon.
2. **Add Neon Postgres**: Marketplace → Neon, free plan. It sets `DATABASE_URL`.
   - Dashboard path: project → Storage → Create Database → Neon.
   - The schema is created automatically on the first request.
3. **Set Production variables:**
   - `TELEGRAM_BOT_TOKEN`
   - `OWNER_TELEGRAM_ID`
   - `OPENROUTER_API_KEY`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`

   CLI: `printf '%s' "$VALUE" | npx vercel env add NAME production`.

   Nothing else is needed: the webhook secret and the encryption key are derived from the bot token, and the
   public URL comes from Vercel.
4. **Deploy to production.**

## Step 4 — Google redirect URI

1. Open `https://<production-domain>/api/setup`. The root URL redirects there.
   - The page registers the Telegram webhook itself.
   - Under "Google Calendar і Gmail" it shows the **Redirect URI**, `https://<production-domain>/api/oauth/callback`.
2. Tell the user to add this exact URI to their OAuth client (it must match exactly, `https`, no trailing slash):
   Google Cloud Console → [Clients](https://console.cloud.google.com/auth/clients) → their client →
   **Authorized redirect URIs** → Add URI → Save.
3. For a **personal Gmail** (External) account, remind them: [Audience](https://console.cloud.google.com/auth/audience)
   → **Publish app**. Otherwise Google revokes access every 7 days.

If the page is a Vercel login screen, production is behind Deployment Protection:
- turn it off for production (Settings → Deployment Protection);
- Telegram and Google must be able to reach the app.

## Step 5 — owner connects, verify

1. The user opens their bot (the @username from Step 2a) and sends `/start`.
2. They fill in the profile and press «Підключити Google Calendar».
3. For a personal Gmail, Google shows "hasn't verified this app": they click **Advanced → Go to AI-secretary**.
4. They tick all permissions (calendar and mail).
5. The bot confirms the connection.
6. Smoke test: «зустріч з тестом завтра о 10:00» → «Створити» → the event appears in Google Calendar.
7. `curl https://<domain>/api/health` should return `"ok": true`, `"database": true`, `"telegram_webhook": true`.

## Step 6 — final report to the user

Keep it short:
- the bot's @username and the site URL;
- what was verified;
- anything left for the user to do (for example, adding the redirect URI).

Then one line on optional extras:
- voice messages (ElevenLabs key);
- Zoom;
- instant new-mail notices (Pub/Sub).

They can be added any time; `/api/setup` shows the steps.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Google: `redirect_uri_mismatch` | The URI in the Google client differs from the one on /api/setup. Copy it exactly. |
| Google: `access_denied` / "app not available" | External app still in Testing and the user is not a test user. Publish the app (Audience → Publish app). |
| «Доступ до Google Calendar втрачено» | Consent screen left in Testing (7-day expiry), access revoked, or the bot token / `ENCRYPTION_KEY` changed. Fix the cause, then reconnect in `/settings`. |
| Bot silent | /api/setup → Telegram row. Check that `OWNER_TELEGRAM_ID` is the user's number, not the bot's. |
| LLM errors in the bot | OpenRouter balance is empty, or the model id in /settings is wrong. |
| Anything else | Vercel runtime logs (MCP or Dashboard → Logs). The bot also reports errors to its owner; `/errors` lists them. |

To hand the bot to someone else, change `OWNER_TELEGRAM_ID` and redeploy.
