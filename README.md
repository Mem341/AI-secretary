# AI-secretary

Telegram-бот «AI-секретар» для керівників Ribas Hotels Group: створює зустрічі з тексту, голосового, пересланої
переписки чи скріншота, розсилає інвайти через Google Calendar, бачить зміни в календарі через push від Google,
нагадує за 30 хв і веде протоколи.

Специфікація: «ТЗ: AI-секретар для керівників Ribas Hotels Group» (Claude Docs).

## Статус етапів

| Етап | Зміст | Статус |
| --- | --- | --- |
| 1. Ядро | онбординг, whitelist, OAuth, push-синхронізація, картка зустрічі, створення події, інвайти | ✅ реалізовано |
| 2. Нагадування | щохвилинний cron, нагадування за 30 хв із брифом, перенесення/скасування, `/today`, `/week` | ⏳ далі |
| 3. Протокол | запис, транскрибація, підсумки, розсилка, `/history` | ⏳ |

Схема БД (`migrations/0001_init.sql`) одразу містить усі 9 таблиць з розділу 5 ТЗ, щоб наступні етапи не
перебудовували дані.

## Архітектура

Один Cloudflare Worker (TypeScript), без сервера:

```
Telegram ──webhook──▶ /telegram/webhook ─┐
Google   ──push────▶ /gcal/push ─────────┤        ┌──▶ Google Calendar API
Браузер  ──OAuth───▶ /oauth/google/*  ───┼─ Worker ┼──▶ OpenRouter (LLM)
Cron (щодня / 6 год) ────────────────────┤        └──▶ ElevenLabs Scribe (голос)
Queue ai-secretary-jobs ◀──▶ consumer ───┘   D1 (дані) · R2 (файли, етап 3)
```

- **Webhook Telegram** відповідає одразу; все важке (LLM, транскрибація, синхронізація) іде в Cloudflare Queue
  з повторними спробами (3 рази), остаточний збій пишеться в `errors` і приходить адміністратору.
- **Push від Google**: після OAuth бот підписується `events.watch` на `https://<worker>/gcal/push` із секретним
  токеном каналу. На кожен сигнал — `events.list` із `syncToken` (лише змінені події) → дзеркало `meetings` у D1.
  Токен каналу перевіряється, невідомі канали ігноруються.
- **Cron**: `17 3 * * *` — продовження каналів, яким лишилось < доби; `5 */6 * * *` — повний sync вікна
  [−1 день, +30 днів] як страховка від втрачених push (заодно підтягує нові екземпляри повторюваних подій).
- **Картка зустрічі**: LLM повертає JSON за схемою з ТЗ; код валідує його, нічого не вигадує, підставляє
  дефолти з профілю, email співробітників із довідника (таблиця `users`), прибирає власника з учасників.
  `confidence < 0.7` → уточнювальне питання замість картки.
- **Переслана переписка**: повідомлення збираються в одну чернетку атомарно (унікальний індекс на
  `drafts(user_id) WHERE state='collecting'`), обробляє лише задача з останнім `batch_seq` — через 15 с після
  останнього повідомлення.
- **Створення події**: `events.insert` з `sendUpdates=all` (Google сам розсилає інвайти), `guestsCanModify`,
  `guestsCanInviteOthers`, Google Meet через `conferenceData`. Id події детермінований від чернетки, тож повтор
  запиту не створить дубль; подвійне натискання «Створити» відсікається compare-and-set станом чернетки.
- **Безпека**: whitelist Telegram ID, перевірка `X-Telegram-Bot-Api-Secret-Token`, підписаний і обмежений у часі
  `state` в OAuth, refresh/access-токени Google шифруються AES-256-GCM ключем з `ENCRYPTION_KEY`.

Структура:

```
src/
  index.ts            маршрути, cron, consumer черги
  jobs.ts             типи задач черги
  bot/                онбординг і налаштування, картка зустрічі, сценарій створення
  google/             OAuth, клієнт Calendar API, push-синхронізація
  telegram/           клієнт Bot API, маршрутизація апдейтів, адмін-команди
  llm/                OpenRouter, промпти
  stt/                ElevenLabs Scribe
  db/                 доступ до D1
  lib/                час (Europe/Kyiv), криптографія, HTTP з повторами, лог помилок
migrations/           схема D1
test/                 тести у рантаймі Workers (vitest + miniflare)
```

## Розгортання

### 1. Telegram

Створіть бота в [@BotFather](https://t.me/BotFather), збережіть токен. Згенеруйте секрет вебхука
(наприклад, `openssl rand -hex 32`).

### 2. Google Cloud

1. Створіть проєкт, увімкніть **Google Calendar API**.
2. OAuth consent screen: для Google Workspace — тип *Internal*; якщо в пілоті є особисті Gmail — *External*
   і додайте їх у *Test users*.
3. Credentials → OAuth client ID → *Web application*, Authorized redirect URI:
   `https://<worker>/oauth/google/callback`.

### 3. Cloudflare

```bash
npm ci
npx wrangler d1 create ai-secretary          # підставте database_id у wrangler.jsonc
npx wrangler r2 bucket create ai-secretary-files
npx wrangler queues create ai-secretary-jobs
npm run db:migrate:remote
```

У `wrangler.jsonc` задайте `PUBLIC_URL` (адреса воркера без `/` в кінці) і `ADMIN_TG_IDS` (Telegram ID
адміністраторів через кому). Моделі змінюються змінними `LLM_MODEL` (картка; має підтримувати зображення для
скріншотів) і `LLM_MODEL_SUMMARY` (підсумки, етап 3) без зміни коду.

Секрети:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put ENCRYPTION_KEY       # openssl rand -base64 32; не змінювати після запуску
```

Деплой: `npm run deploy` або GitHub → Workers Builds (build command `npm ci`, deploy command
`npx wrangler deploy`).

### 4. Вебхук і меню бота

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... PUBLIC_URL=https://<worker> npm run telegram:setup
```

## Користування

- Адміністратор (з `ADMIN_TG_IDS`) потрапляє у whitelist автоматично як керівник.
- Додати людей: `/allow <telegram_id> owner` (керівник) або `/allow <telegram_id> member` (внутрішній учасник).
  Сторонній, що написав боту, бачить свій Telegram ID — його можна одразу передати адміністратору.
- `/deny <telegram_id>` — вимкнути доступ, `/users` — список і стан календарів, `/errors` — останні помилки.
- Керівник: `/start` → профіль (ПІБ, посада, телефон, тривалість, формат, адреса) → «Підключити Google Calendar».
  Далі достатньо написати, надиктувати, переслати переписку або скинути скріншот.
- Внутрішній учасник: `/start` → імʼя та робоча пошта (так бот зв'язує email з Telegram для нагадувань).

## Розробка

```bash
npm ci
npm run typecheck
npm test                 # vitest у рантаймі Workers, з D1 і міграціями
cp .dev.vars.example .dev.vars && npm run dev
```

Примітки:

- Зайнятість для попередження про перетин і для підбору 3 вільних слотів береться з дзеркала календаря в D1
  (його тримає актуальним push), а не з окремого `freebusy`-запиту — так не потрібен додатковий OAuth-scope,
  а в попередженні видно назву події, з якою перетин.
- `compatibility_date` обмежена версією workerd, з якою працює `@cloudflare/vitest-pool-workers`.
