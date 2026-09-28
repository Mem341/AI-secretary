# AI-secretary

Telegram bot (single owner) that creates Google Calendar meetings from text, voice, forwarded chats and
screenshots. Node.js + TypeScript on **Vercel Functions**, Postgres (**Neon**), OpenRouter (LLM),
ElevenLabs Scribe (speech-to-text).

## Deploying

When asked to deploy or set up the bot, follow `.claude/skills/deploy-vercel/SKILL.md` (also available as
the `/deploy-vercel` skill). It lists exactly what to ask the owner before deploying.

## Layout

- `api/` — Vercel Functions (thin wrappers): `telegram`, `gcal-push`, `oauth/start`, `oauth/callback`,
  `cron/daily`, `health`.
- `src/app.ts` — HTTP handlers and the background job runner; `src/vercel.ts` — Vercel bootstrap.
- `src/jobs.ts` — background jobs (run after the response via `waitUntil`, 3 attempts).
- `src/bot/` — onboarding/settings, meeting card, creation flow. `src/telegram/` — Bot API, update routing.
- `src/google/` — OAuth, Calendar API, push sync. `src/db/` — Postgres access and schema migrations.

## Rules

- The bot answers only `OWNER_TELEGRAM_ID`; keep every entry point behind that check.
- SQL uses `$1…` placeholders via `src/db/client.ts`. Schema changes: append a new entry to `MIGRATIONS` in
  `src/db/schema.ts`; never edit an applied migration.
- Compiles to CommonJS (`tsconfig.json`), which Vercel's Node runtime needs for extensionless imports.
- Check before pushing: `npm run typecheck && npm test` (tests use in-memory Postgres via PGlite and mock all
  outbound HTTP).
