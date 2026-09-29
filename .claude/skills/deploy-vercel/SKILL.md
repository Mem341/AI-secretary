---
name: deploy-vercel
description: Deploy a personal copy of the open-source AI-secretary Telegram bot to the user's own Vercel account. Ask only for four things (Telegram bot token, their Telegram ID, OpenRouter key, the JSON file of a Google "Desktop app" OAuth client), validate them, set env vars, deploy, finish on /api/setup, report «Реализовано / Не реализовано». No database, no redirect URI. Use when the user asks to deploy, redeploy, set up or configure the bot on Vercel.
---

# Deploy AI-secretary to Vercel

Each copy answers exactly **one** Telegram user, the person deploying it (`OWNER_TELEGRAM_ID`).
Your job: take the user from nothing to a working bot. Ask only for what they alone can provide; do everything
else yourself.

## Rules of conduct

- **`AGENTS.md` in the repo root is binding.** The project is finished and runs on Vercel as it is. Never port it
  or propose services, databases or frameworks. Never ask technical questions or for plan approval.
- **A copy with `wrangler.jsonc`, D1 or SQL migrations is outdated.** Use `main` of github.com/Mem341/AI-secretary.
- **Talk in the user's language.**
- **Ask only for the four items of Step 1, in one message.** Do not ask about:
  - Zoom, Gmail push, the model, a domain, `CRON_SECRET` / `ENCRYPTION_KEY`, profile or default variables;
  - a database (there is none);
  - a redirect URI (a Desktop app client has none).

  Set optional variables only if the user gives them on their own.
- **If the user lacks an item,** send the steps for that item only, from `docs/what-you-need.md` §1–§4. Keep the
  links.
- **Secrets:**
  - never repeat them back;
  - never write them into repository files or commit them;
  - keep them in shell variables only.
- **Tools:** prefer the Vercel MCP tools; otherwise use the Vercel CLI (`npx vercel`).

## Step 1 — collect the inputs

Send this, adapted to the user's language, and wait for the answers:

> Для запуску бота потрібні 4 речі:
>
> 1. **Токен Telegram-бота** — @BotFather → `/newbot` → токен вигляду `7412345678:AAH…`
> 2. **Ваш Telegram ID** — число від @userinfobot (бот відповідатиме лише вам)
> 3. **Ключ OpenRouter** — https://openrouter.ai/keys, вигляду `sk-or-v1-…` (на рахунку мають бути кошти)
> 4. **JSON-файл Google-клієнта типу «Desktop app»** — `client_secret_….json`. Якщо його ще немає, скажіть: дам
>    покрокову інструкцію на 5 хвилин.

## Step 2 — validate (never print the values)

| Item | Check |
|------|-------|
| a. Bot token | Must match `^\d{6,}:[A-Za-z0-9_-]{30,}$`. Then `curl -s https://api.telegram.org/bot$TOKEN/getMe` must return `"ok":true`; remember the bot's @username. |
| b. Telegram ID | Digits only. It must not be the bot's own ID (the part of the token before `:`). |
| c. OpenRouter key | Starts with `sk-or-`. `curl -s -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key` must return HTTP 200. |
| d. Google JSON | Must parse as JSON and contain `installed.client_id` and `installed.client_secret`. |

About the Google JSON:
- A `web` key instead of `installed` means a "Web application" client. It also works, but then the owner must add
  `https://<domain>/api/oauth/callback` to that client. Prefer asking for a Desktop app JSON (§4).
- A JSON with a `type` field is a service account, not an OAuth client. Ask for the right file.

If a check fails: say which item is wrong and why, and ask for that item only.

## Step 3 — project, variables, deploy

1. **Project.** Framework preset **Other**, no build command, root `/`, name `ai-secretary`.
   - Vercel cannot reach the GitHub repo (`repo_no_access`)? Do not ask. Clone `main` and deploy from files:
     `npx vercel link --yes --project ai-secretary`, then the variables, then `npx vercel deploy --prod --yes`.
   - Ask for a Vercel token only if the CLI is not logged in.
2. **Production variables:**
   - `TELEGRAM_BOT_TOKEN`
   - `OWNER_TELEGRAM_ID`
   - `OPENROUTER_API_KEY`
   - `GOOGLE_CLIENT_JSON` — the whole JSON file, as one line:
     `node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])))' client_secret.json | npx vercel env add GOOGLE_CLIENT_JSON production`

   Use `printf '%s' "$VALUE" | npx vercel env add NAME production` for the others. Nothing else is needed.
   Remove old `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` variables if the project has them.
3. **Deploy to production.**
4. **Open `https://<domain>/api/setup`.** It registers the Telegram webhook and redirects to `t.me/<bot>`
   (a "Бот не відповідає" page means the bot token is wrong).
   - If the page is a Vercel login screen, turn off Deployment Protection for production (Settings →
     Deployment Protection).
5. **`curl https://<domain>/api/health`** → `"ok": true` and `"telegram_webhook": true`.

## Step 4 — the owner connects Google (their action, tell them exactly this)

1. Write `/start` to @<bot> and press «Підключити Google».
2. On the page that opens, press «Увійти через Google», choose the account and tick all permissions.
3. Google says "app isn't verified" → «Додатково» → «Перейти»: it is their own bot.
4. The browser opens `http://127.0.0.1…` with an error page. That is expected.
5. Copy that address from the address bar and send it to the bot.
6. The bot answers «✅ Google підключено» and pins a «🔐 Google підключено» message. That message must stay pinned.

## Step 5 — final report

Report only in the `AGENTS.md` §4 format:
- «Реализовано»: ✅ lines;
- «Не реализовано»: ❌ what — the one action the user must take.

Include the bot's @username and the site URL. No explanations of internals, no alternatives, no questions.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Any URL: "GOOGLE_CLIENT_JSON must be the content…" | The variable holds something other than the downloaded JSON. Set the whole file again. |
| Google: «Доступ заблокирован… приложение тестируется», 403 `access_denied` | The consent screen of that Google Cloud project is in **Testing** and the account is not a test user. The client type (Desktop/Web) does not matter. Fix: Google Auth Platform → Audience → **Publish app** (or add the account under Test users). The app name shown there comes from Branding. |
| Bot: «Google не прийняв цей код» | The code is single-use and lives a few minutes. Press «Підключити Google» again. |
| «Доступ до Google втрачено» | Access was revoked, the consent screen is in Testing (7-day expiry), or the bot token / `ENCRYPTION_KEY` changed. Reconnect via `/settings`. |
| Bot silent | /api/setup must redirect to the bot and /api/health show `"telegram_webhook": true`. Check that `OWNER_TELEGRAM_ID` is the user's number, not the bot's. |
| LLM errors in the bot | OpenRouter balance is empty, or `LLM_MODEL` / `AGENT_MODEL` / `VISION_MODEL` holds a wrong model id (the agents need a model with tool calling). |
| Anything else | Vercel runtime logs. The bot also reports errors to its owner in the chat. |
