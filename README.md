# 🗓 AI-secretary

Особистий Telegram-секретар із відкритим кодом. Пишете, надиктовуєте, пересилаєте переписку або кидаєте
скріншот — бот готує картку зустрічі, а після «Створити» подія зʼявляється у вашому Google Calendar і учасники
отримують запрошення на пошту.

Кожен розгортає **власну копію** на своєму Vercel за кілька хвилин — безкоштовно, без серверів і без коду.

**Node.js + TypeScript · Vercel Functions · Neon Postgres · OpenRouter · ElevenLabs**

> 🔒 **Кожна копія служить рівно одній людині** — тій, чий Telegram ID вказано в `OWNER_TELEGRAM_ID`.
> Повідомлення від усіх інших бот мовчки ігнорує: сторонній навіть не дізнається, що бот працює.

---

<a id="deploy"></a>

## 🚀 Розгортання за 5 хвилин

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMem341%2FAI-secretary&env=OWNER_TELEGRAM_ID%2CTELEGRAM_BOT_TOKEN%2COPENROUTER_API_KEY&envDescription=Your+numeric+Telegram+ID+%28%40userinfobot%29%2C+bot+token+%28%40BotFather%29%2C+OpenRouter+API+key&envLink=https%3A%2F%2Fgithub.com%2FMem341%2FAI-secretary%23deploy&project-name=ai-secretary&repository-name=ai-secretary&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%5D)

1. **Підготуйте три значення:**

   | Змінна | Що це | Де взяти |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | токен вашого бота | [@BotFather](https://t.me/BotFather) → `/newbot` |
   | `OWNER_TELEGRAM_ID` | ваш **числовий** Telegram ID | напишіть [@userinfobot](https://t.me/userinfobot) |
   | `OPENROUTER_API_KEY` | ключ до LLM | [openrouter.ai/keys](https://openrouter.ai/keys) |

2. **Натисніть «Deploy with Vercel»**, вставте ці значення й погодьтеся підключити безкоштовну базу **Neon**.
   Якщо Vercel не запропонував Neon — після деплою: проєкт → **Storage** → **Create Database** → **Neon**.
3. **Відкрийте свій сайт** `https://<ваш-проєкт>.vercel.app` — відкриється сторінка налаштування. Вона сама
   підключить Telegram-бота і покаже, що лишилось: Google Calendar (покрокова інструкція з готовим Redirect URI)
   і, за бажанням, голосові.
4. **Напишіть своєму боту `/start`**, заповніть профіль і натисніть «Підключити Google Calendar». Готово.

> 💡 Можна доручити все агенту **Claude Code** з підключеним Vercel MCP: «розгорни бота на Vercel». Він візьме
> інструкцію з `.claude/skills/deploy-vercel/SKILL.md` і спитає лише те, чого не зможе зробити сам.

### Необовʼязкові змінні

| Змінна | Навіщо |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Calendar — сторінка налаштування покаже, як створити |
| `ELEVENLABS_API_KEY` | розпізнавання голосових ([ключ](https://elevenlabs.io/app/settings/api-keys)) |
| `LLM_MODEL`, `LLM_MODEL_SUMMARY` | інші моделі OpenRouter (за замовчуванням `google/gemini-2.5-flash` і `anthropic/claude-sonnet-4.5`) |
| `ENCRYPTION_KEY` | власний ключ шифрування токенів Google (інакше виводиться з токена бота) |
| `CRON_SECRET` | закрити щоденний cron від сторонніх викликів |
| `PUBLIC_URL` | власний домен замість `*.vercel.app` |

---

## ✨ Можливості

| | |
|---|---|
| 📝 **Будь-який вхід** | текст, голосове, переслана переписка (серія збирається 15 с), скріншот |
| 🃏 **Картка з підтвердженням** | правки звичайним текстом, уточнювальне питання, 3 вільні слоти, попередження про перетини |
| 📧 **Інвайти** | подія в Google Calendar з розсилкою на пошту, Google Meet, гості можуть редагувати |
| 🔄 **Push від Google** | бот бачить і події, створені вручну в календарі |
| 📇 **Адресна книга** | імена й email учасників запамʼятовуються — наступного разу достатньо імені |
| 🛟 **Надійність** | 3 спроби на кожну фонову задачу, про помилки бот пише вам сам |

### Команди

| Команда | Дія |
|---|---|
| `/start` | профіль і підключення календаря |
| `/new` | нова зустріч (або просто напишіть / перешліть) |
| `/contacts` | адресна книга |
| `/contact Імʼя Прізвище email` | додати контакт (`/contact_del email` — видалити) |
| `/settings` | профіль, значення за замовчуванням, календар |
| `/cancel` | скасувати поточну дію |
| `/errors` | останні помилки |

Інтерфейс бота — українською.

---

## 🏗 Як це працює

```
Telegram ─ webhook ─▶ /api/telegram ─────┐
Google   ─ push ────▶ /api/gcal-push ────┤            ┌─▶ Google Calendar API
Браузер  ─ OAuth ───▶ /api/oauth/* ──────┼─ Vercel  ──┼─▶ OpenRouter (LLM)
Vercel Cron (щодня) ▶ /api/cron/daily ───┤  Functions └─▶ ElevenLabs (голос)
Ви ─────────────────▶ /api/setup ────────┘     │
                                          Neon Postgres
```

- **Миттєва відповідь.** Функція одразу відповідає Telegram, а LLM, транскрибація й синхронізація виконуються
  після відповіді (`waitUntil`).
- **Push замість опитування.** `events.watch` → Google повідомляє про зміни → `events.list` із `syncToken` бере
  лише змінене. Щоденний cron продовжує підписку й робить страхувальну синхронізацію на 30 днів.
- **Нуль ручної роботи.** Таблиці створюються автоматично, вебхук Telegram реєструє сторінка налаштування.
- **Безпека.** Перевірка власника на кожному вході, секрет вебхука Telegram, токен каналу Google, підписаний
  `state` в OAuth, токени Google зашифровані AES-256-GCM. Ваші дані — лише у вашій базі.

<details>
<summary><b>Навіщо база даних</b></summary>

Функції Vercel нічого не памʼятають між запитами, тому без сховища бот не працюватиме правильно:

| Що зберігається | Навіщо |
|---|---|
| Токени Google (зашифровані) | створювати події від вашого імені без повторного входу |
| Картка до «Створити» | кнопки «Змінити / Створити» натискаються в окремому запиті |
| Серія пересланих повідомлень | зібрати переписку в одну картку |
| Стан push-каналу, `syncToken` | отримувати від Google лише зміни й продовжувати підписку |
| Дзеркало календаря | вільні слоти й перетини |
| Адресна книга, помилки | email за іменем, діагностика |

Безкоштовного Neon (0.5 GB) для однієї людини вистачить із великим запасом.
</details>

<details>
<summary><b>Структура проєкту</b></summary>

```
api/                 Vercel Functions (тонкі обгортки)
src/app.ts           HTTP-обробники, сторінка налаштування, фонові задачі
src/jobs.ts          фонові задачі з повторами
src/bot/             онбординг, картка зустрічі, створення події
src/telegram/        Bot API, маршрутизація, перевірка власника
src/google/          OAuth, Calendar API, push-синхронізація
src/db/              Postgres і міграції схеми
src/llm/, src/stt/   OpenRouter, ElevenLabs
test/                тести (Postgres у памʼяті через PGlite)
```
</details>

**Далі за планом:** нагадування за 30 хв, перенесення/скасування, `/today`, `/week`; записи зустрічей,
транскрибація й підсумки.

---

## 🧑‍💻 Розробка

Потрібен лише **Node.js 22**.

```bash
npm ci
npm run typecheck
npm test          # Postgres у памʼяті (PGlite), усі зовнішні HTTP замокані
npm run dev       # локальний запуск через Vercel CLI
```

Змінні середовища — у `.env.example`.

## 📄 Ліцензія

[MIT](LICENSE) — використовуйте, змінюйте й розгортайте вільно.
