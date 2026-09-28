# AI-secretary

Open-source personal Telegram secretary: anyone deploys their own copy (Vercel or AWS); each copy serves one owner
(`OWNER_TELEGRAM_ID`). Creates Google Calendar meetings from text, voice, forwarded chats and screenshots, reports
calendar changes, reschedules/cancels by reply, and works with Gmail. Node.js + TypeScript, Postgres (**Neon**),
OpenRouter (LLM, model selectable per owner), ElevenLabs (speech-to-text), optional Zoom.

## Deploying

The same code runs on both platforms; pick the skill by what the user asked for:

- **Vercel** → `.claude/skills/deploy-vercel/SKILL.md` (`/deploy-vercel`).
- **AWS** (Amazon, Lambda) → `.claude/skills/deploy-aws/SKILL.md` (`/deploy-aws`); background: `docs/deploy-aws.md`.
- Platform not named → ask once: Vercel (fastest, one button) or AWS (their own AWS account).

Each skill collects exactly four things from the owner — Telegram bot token, their Telegram ID, OpenRouter key,
Google OAuth client ID + secret (plus a Neon URL on AWS) — validates them, and never asks about optional extras.
The human version of that list with step-by-step instructions is `docs/what-you-need.md`. After any deploy, the `/api/setup` page registers the Telegram
webhook and shows what is left to configure (Google, Gmail push, Zoom, voice).

## Layout

- `api/` — Vercel Functions (thin wrappers). `src/aws.ts` — AWS Lambda adapter (Function URL + cron handler).
  `src/router.ts` — the same endpoints routed in code (AWS, any Node host). `aws/template.yaml` — AWS SAM stack.
- `src/app.ts` — HTTP handlers, setup page, job runner wiring; `src/vercel.ts` — Vercel bootstrap.
- `src/jobs.ts` — background jobs (run after the response, 3 attempts).
- `src/bot/` — `meetings.ts` (meeting cards + the text router), `actions.ts` (reschedule/cancel/note by reply),
  `mail.ts` (Gmail agent), `onboarding.ts` (profile, /settings, model choice), `card.ts`.
- `src/google/` — OAuth, Calendar API + push sync (instant notices), Gmail API + Pub/Sub push.
- `src/db/` — Postgres access and schema migrations; `src/zoom/` — Zoom API.

## Rules

- The bot answers only `OWNER_TELEGRAM_ID`; keep every entry point behind that check.
- Keep the deployment generic (no company-specific names or data). The app boots with only `OWNER_TELEGRAM_ID`,
  `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY` (+ a Postgres URL); Google keys are collected at deploy but the app
  must still start without them; new features must be optional or derived.
- Anything that writes to the calendar or sends/removes mail goes through a confirmation card; read-only and
  easily reversible actions may run at once. Mark the bot's own Calendar writes with `markSelfWrite` first.
- Keep the Vercel `api/*` files, `src/router.ts` and the docs' URLs in sync when adding an endpoint.
- SQL uses `$1…` placeholders via `src/db/client.ts`. Schema changes: append a new entry to `MIGRATIONS` in
  `src/db/schema.ts`; never edit an applied migration.
- Compiles to CommonJS (`tsconfig.json`), which Vercel's Node runtime needs for extensionless imports.
- Check before pushing: `npm run typecheck && npm test && npm run build:aws` (tests use in-memory Postgres via
  PGlite and mock all outbound HTTP).
