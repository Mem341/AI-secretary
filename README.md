# 🗓 AI-secretary

Особистий Telegram-секретар із відкритим кодом. Пишете, надиктовуєте, пересилаєте переписку або кидаєте
скріншот — бот готує картку зустрічі, а після «Створити» подія зʼявляється у вашому Google Calendar і учасники
отримують запрошення на пошту. Бот одразу повідомляє про зміни в календарі, переносить і скасовує зустрічі у
відповідь на повідомлення, читає й відповідає на листи Gmail.

Кожен розгортає **власну копію** — на **Vercel** (одна кнопка) або в **AWS** (свій акаунт) — безкоштовно для
однієї людини, без серверів.

**Node.js + TypeScript · Vercel Functions або AWS Lambda · OpenRouter · Zoom (необовʼязково) · без бази даних**

> 🔒 **Кожна копія служить рівно одній людині** — тій, чий Telegram ID вказано в `OWNER_TELEGRAM_ID`.
> Повідомлення від усіх інших бот мовчки ігнорує: сторонній навіть не дізнається, що бот працює.

---

<a id="deploy"></a>

## 🚀 Розгортання за 5 хвилин

### Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMem341%2FAI-secretary&env=OWNER_TELEGRAM_ID%2CTELEGRAM_BOT_TOKEN%2COPENROUTER_API_KEY%2CGOOGLE_CLIENT_ID%2CGOOGLE_CLIENT_SECRET&envDescription=Your+numeric+Telegram+ID+%28%40userinfobot%29%2C+bot+token+%28%40BotFather%29%2C+OpenRouter+API+key%2C+Google+OAuth+client+ID+and+secret&envLink=https%3A%2F%2Fgithub.com%2FMem341%2FAI-secretary%23deploy&project-name=ai-secretary&repository-name=ai-secretary)

1. **Підготуйте чотири речі** (покроково — [docs/what-you-need.md](docs/what-you-need.md)):

   | Змінна | Що це | Де взяти |
   |---|---|---|
   | `TELEGRAM_BOT_TOKEN` | токен вашого бота | [@BotFather](https://t.me/BotFather) → `/newbot` |
   | `OWNER_TELEGRAM_ID` | ваш **числовий** Telegram ID | напишіть [@userinfobot](https://t.me/userinfobot) |
   | `OPENROUTER_API_KEY` | ключ до ШІ | [openrouter.ai/keys](https://openrouter.ai/keys) |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | доступ до Google Calendar і Gmail | Google Cloud Console, 5 хвилин — [інструкція](docs/what-you-need.md#4-google-client-id-і-client-secret) |

   Більше нічого не треба — **навіть бази даних**: голосові розпізнає той самий OpenRouter. Zoom і миттєві сповіщення про пошту —
   необовʼязкові, додаються, коли захочете.

2. **Натисніть «Deploy with Vercel»** і вставте ці значення.
3. **Відкрийте свій сайт** `https://<ваш-проєкт>.vercel.app` — відкриється сторінка налаштування. Вона сама
   підключить Telegram-бота і покаже ваш **Redirect URI** — додайте його в Google-клієнт (Clients → Authorized
   redirect URIs).
4. **Напишіть своєму боту `/start`**, заповніть профіль і натисніть «Підключити Google Calendar». Готово.

> 💡 Можна доручити все агенту **Claude Code** з підключеним Vercel MCP: «розгорни бота на Vercel». Він візьме
> інструкцію з `.claude/skills/deploy-vercel/SKILL.md`, спитає рівно ці 4 речі, перевірить їх і зробить решту сам.

### AWS

Той самий код працює як AWS Lambda (Function URL + щоденний cron через EventBridge), розгортається через AWS SAM:

```bash
npm ci && npm run build:aws
cd aws && cp samconfig.toml.example samconfig.toml   # впишіть ті самі 4 речі
sam deploy
```

Далі — так само: відкрийте `FunctionUrl` з виводу, сторінка налаштування доведе до кінця. Детально:
[docs/deploy-aws.md](docs/deploy-aws.md). Агенту Claude Code достатньо сказати «розгорни бота на AWS» — інструкція
для нього в `.claude/skills/deploy-aws/SKILL.md`.

### Необовʼязкові змінні

| Змінна | Навіщо |
|---|---|
| `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | зустрічі в Zoom (застосунок Server-to-Server OAuth) |
| `GMAIL_PUBSUB_TOPIC` | миттєві сповіщення про нові листи (топік Cloud Pub/Sub) |
| `LLM_MODEL` | модель OpenRouter, будь-яка (напр. `openai/gpt-5`); типова — `google/gemini-2.5-flash` |
| `OWNER_NAME`, `OWNER_POSITION`, `OWNER_PHONE` | підпис організатора в описі подій (імʼя — інакше з Telegram) |
| `DEFAULT_DURATION_MIN`, `DEFAULT_FORMAT`, `DEFAULT_ADDRESS` | тривалість (60), формат (`offline` / `google_meet` / `zoom`), адреса офлайн-зустрічей |
| `ENCRYPTION_KEY` | власний ключ шифрування доступу до Google (інакше виводиться з токена бота) |
| `CRON_SECRET` | закрити щоденний cron від сторонніх викликів |
| `PUBLIC_URL` | власний домен замість `*.vercel.app` / Function URL |

---

## ✨ Можливості

| | |
|---|---|
| 📝 **Будь-який вхід** | текст, голосове, переслана переписка (серія збирається 10 с), скріншот |
| 🃏 **Картка з підтвердженням** | правки звичайним текстом, уточнювальне питання, 3 вільні слоти, попередження про перетини |
| 📧 **Інвайти** | подія в Google Calendar з розсилкою на пошту, Google Meet або Zoom, гості можуть редагувати |
| 🔔 **Миттєві сповіщення** | нова, перенесена чи скасована в календарі подія (не ботом) — одразу повідомлення в Telegram |
| 💬 **Відповідь = команда** | відповідайте на повідомлення про зустріч: «перенеси на завтра 15:00», «скасуй», «хто буде?», «додай нотатку: …» |
| ✉️ **Gmail** | «перевір пошту», «напиши Івану лист…», відповідь на лист реплаєм, чернетки, мітки, архів, кошик; про нові листи — одразу |
| 🧠 **Своя модель ШІ** | будь-яка модель OpenRouter (напр. `openai/gpt-5`) — змінна `LLM_MODEL` |
| 🔒 **Безпечні дії** | усе, що змінює календар чи надсилає/видаляє пошту, — лише після кнопки «✅ Так» |
| 📇 **Знайомі люди** | email людей, з якими ви вже зустрічались, бот бере з календаря — достатньо імені |
| 🛟 **Надійність** | 3 спроби на кожну фонову задачу, про помилки бот пише вам сам |

### Команди

| Команда | Дія |
|---|---|
| `/start` | привітання й підключення Google |
| `/new` | нова зустріч (або просто напишіть / перешліть) |
| `/mail …` | дія з поштою (або просто напишіть «перевір пошту») |
| `/contacts` | кого бот знає з вашого календаря |
| `/settings` | профіль, значення за замовчуванням, підключення Google |
| `/cancel` | скасувати поточну дію |

Інтерфейс бота — українською.

---

## 🏗 Як це працює

```
Telegram ─ webhook ─▶ /api/telegram ─────┐
Google   ─ push ────▶ /api/gcal-push ────┤  Vercel Functions   ┌─▶ Google Calendar / Gmail API
Pub/Sub  ─ Gmail ───▶ /api/gmail-push ───┤        або          ├─▶ OpenRouter (LLM)
Браузер  ─ OAuth ───▶ /api/oauth/* ──────┼─ AWS Lambda ────────┼─▶ OpenRouter (голос → текст)
Cron (щодня) ───────▶ /api/cron/daily ───┤                     └─▶ Zoom
Ви ─────────────────▶ /api/setup ────────┘
```

- **Миттєва відповідь.** Функція одразу відповідає Telegram, а LLM, транскрибація й синхронізація виконуються
  після відповіді (`waitUntil` на Vercel, response streaming на AWS).
- **Push замість опитування.** `events.watch` → Google повідомляє про зміни → бот бере події, змінені за останні
  хвилини, і одразу пише вам про нові, перенесені чи скасовані (зроблені не ботом). Gmail — так само через Cloud
  Pub/Sub. Щоденний cron продовжує підписки.
- **Нуль ручної роботи.** Вебхук Telegram реєструє сторінка налаштування; створювати нічого не треба.
- **Безпека.** Перевірка власника на кожному вході, секрет вебхука Telegram, токен каналу Google, підписаний
  `state` в OAuth, доступ до Google зашифрований AES-256-GCM.

<details>
<summary><b>Без бази даних: де що живе</b></summary>

Функції Vercel і AWS Lambda нічого не памʼятають між запитами, тож бот тримає потрібне там, де воно й так є:

| Що | Де |
|---|---|
| Доступ до Google (зашифрований) | одне закріплене повідомлення «🔐 Google підключено» у вашому чаті з ботом |
| Картка до «Створити» | прихована всередині самого повідомлення з карткою; кнопка чи відповідь повертає її боту |
| На яку зустріч / який лист ваша відповідь | прихований ідентифікатор у повідомленні, на яке ви відповідаєте |
| Вільні слоти, перетини, учасники | щоразу напряму з Google Calendar |
| Що вже повідомлено про подію | приватна (невидима гостям) позначка на самій події в Google Calendar |
| Які листи вже показано | прихована мітка в Gmail |
| Серія пересланих повідомлень | памʼять запущеної функції на кілька секунд — сама очищується |

Видалили закріплене повідомлення — бот попросить підключити Google знову. Більше нічого не губиться.
</details>

<details>
<summary><b>Структура проєкту</b></summary>

```
api/                 Vercel Functions (тонкі обгортки)
src/aws.ts           AWS Lambda (Function URL + cron); aws/template.yaml — стек AWS SAM
src/router.ts        ті самі адреси для AWS та будь-якого Node-хостингу
src/app.ts           HTTP-обробники, сторінка налаштування, фонові задачі
src/jobs.ts          фонові задачі з повторами
src/session.ts       коротка памʼять запущеної функції (серії повідомлень), сама очищується
src/bot/             зустрічі, дії по reply, Gmail-агент, /start і /settings
src/telegram/        Bot API, маршрутизація, перевірка власника, приховані дані в повідомленнях
src/google/          OAuth (доступ у закріпленому повідомленні), Calendar + Gmail API, push
src/zoom/            Zoom API
src/llm/, src/stt/   OpenRouter: ШІ і розпізнавання голосових
test/                тести (Telegram і Google замокані)
```
</details>

**Далі за планом:** нагадування за 30 хв, `/today`, `/week`; записи зустрічей, транскрибація й підсумки.

---

## 🧑‍💻 Розробка

Потрібен лише **Node.js 22**.

```bash
npm ci
npm run typecheck
npm test          # усі зовнішні HTTP (Telegram, Google, OpenRouter) замокані
npm run build:aws # збірка Lambda-бандла для AWS
npm run dev       # локальний запуск через Vercel CLI
```

Змінні середовища — у `.env.example`.

## 📄 Ліцензія

[MIT](LICENSE) — використовуйте, змінюйте й розгортайте вільно.
