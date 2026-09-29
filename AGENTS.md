# AGENTS.md — rules for ANY AI agent that deploys or sets up this bot

Read this first. These rules override your own judgement about what to ask or propose.

## 1. The project is finished — do not port, redesign or choose anything

- The code in `main` of <https://github.com/Mem341/AI-secretary> is ready for **Vercel** as it is. Vercel is the only platform: no AWS, no Cloudflare.
- Do not move it to another platform.
- It has **no database, no queue, no file storage**. Do not propose or add Supabase, Neon, Postgres, Upstash,
  QStash, Redis, Vercel KV/Blob, Cloudflare, D1, R2, wrangler, Hono or any other service or framework.
- If your copy contains `wrangler.jsonc`, D1, Queues, R2 or SQL migrations, **it is an outdated copy**. Do not
  port it. Take the current code: `git clone https://github.com/Mem341/AI-secretary` (branch `main`). The current
  code has `vercel.json`, `api/`, `src/` and this file.

## 2. Ask the user ONLY for these values — in one message

| Variable | What it is | How the user gets it |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | bot token | @BotFather → `/newbot` |
| `OWNER_TELEGRAM_ID` | their numeric Telegram ID (the only person the bot answers) | @userinfobot |
| `OPENROUTER_API_KEY` | AI key | <https://openrouter.ai/keys> |
| `GOOGLE_CLIENT_JSON` | the JSON file of a Google OAuth client of type **Desktop app** (`client_secret_….json`) | `docs/what-you-need.md` §4 |

Put the Google JSON into `GOOGLE_CLIENT_JSON` **as is** (whole content, one line is fine: `node -e
'process.stdout.write(JSON.stringify(require(process.argv[1])))' client_secret.json`). Check it has
`installed.client_id`. Do not split it into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. A Desktop app client needs
**no redirect URI** — never ask the user to configure one.

Step-by-step instructions for each value, to send when the user does not have it: `docs/what-you-need.md`.

**Never ask:**
- technical questions: architecture, platforms, services, "do we use X or Y?", "shall I port?";
- for approval of a plan;
- about a database, queues, storage, cron, frameworks;
- about optional extras: Zoom, Gmail Pub/Sub, `OWNER_*` / `DEFAULT_*` / `LLM_MODEL` / `AGENT_MODEL` / `REMINDER_MINUTES`, a reminders cron. Set them only if the user
  gives them on their own.

## 3. Do everything else yourself

- Follow `.claude/skills/deploy-vercel/SKILL.md`.
- **Vercel cannot see the GitHub repo** (`repo_no_access`, a different GitHub account, no Git integration)? Do not
  ask and do not port. Deploy from files; a Git connection is not needed:
  ```bash
  git clone https://github.com/Mem341/AI-secretary && cd AI-secretary
  npx vercel link --yes --project ai-secretary
  printf '%s' "$VALUE" | npx vercel env add NAME production   # for each variable from section 2
  npx vercel deploy --prod --yes
  ```
  The CLI needs a Vercel login or `VERCEL_TOKEN`. If you have neither, that is the one thing to ask for:
  "нужен Vercel-токен: vercel.com/account/tokens".
- After the deploy, open `https://<domain>/api/setup`: it registers the Telegram webhook by itself.

## 4. Report to the user — only in this format

Talk in the user's language. No explanations of internals, no tables of alternatives, no questions except
"send me the missing values".

```
Реализовано:
✅ Проект на Vercel создан
✅ Переменные заданы: TELEGRAM_BOT_TOKEN, OWNER_TELEGRAM_ID, OPENROUTER_API_KEY, GOOGLE_CLIENT_JSON
✅ Задеплоено: https://<domain>
✅ Вебхук Telegram зарегистрирован

Не реализовано:
❌ Google не подключён — напишите боту /start → «Подключить Google» → войдите в Google → скопируйте адрес
   из браузера (http://127.0.0.1…, страница с ошибкой — так и надо) и отправьте боту
```

A line goes into "Не реализовано" only as `❌ <what> — <one action the user must take>`.
