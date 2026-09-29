# Що потрібно для запуску бота

Для роботи потрібні **чотири речі**. Більше нічого не потрібно.

| # | Що | Приклад | Де взяти |
|---|----|---------|----------|
| 1 | **Токен Telegram-бота** | `7412345678:AAH3k…` | [§1](#1-токен-telegram-бота) |
| 2 | **Ваш Telegram ID** (число) | `123456789` | [§2](#2-ваш-telegram-id) |
| 3 | **Ключ OpenRouter** (ШІ і голосові) | `sk-or-v1-…` | [§3](#3-ключ-openrouter) |
| 4 | **JSON Google-клієнта (Desktop app)** | файл `client_secret_….json` | [§4](#4-google-json-клієнта-desktop-app) |

**Бази даних не потрібно** — ні Neon, ні Postgres. Бот нічого не зберігає на сервері:

- доступ до Google лежить зашифрованим в **одному закріпленому повідомленні** в чаті з ботом («🔐 Google
  підключено»). Не відкріплюйте його; щоб відключити Google — просто видаліть це повідомлення;
- картка зустрічі несе свої дані всередині самого повідомлення в Telegram;
- календар бот щоразу читає прямо з Google.

Голосові повідомлення розпізнає той самий OpenRouter — окремий ключ не потрібен.

**Необовʼязково, якщо захочете (без цього бот повністю працює):**

- **Zoom** — зустрічі в Zoom замість Google Meet: Account ID, Client ID і Client Secret застосунку
  Server-to-Server OAuth ([Zoom Marketplace](https://marketplace.zoom.us/develop/create), scope `meeting:write:admin`);
- миттєві сповіщення про нові листи (Cloud Pub/Sub) — кроки на сторінці `/api/setup`;
- профіль для опису подій: `OWNER_NAME` (інакше — імʼя з Telegram), `OWNER_POSITION`, `OWNER_PHONE`, а також
  `DEFAULT_DURATION_MIN`, `DEFAULT_FORMAT` (offline / google_meet / zoom), `DEFAULT_ADDRESS`, `LLM_MODEL`.

---

## 1. Токен Telegram-бота

1. Відкрийте [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Введіть імʼя бота, потім username (має закінчуватися на `bot`).
3. BotFather надішле токен вигляду `7412345678:AAH3k…`. Це і є токен.

## 2. Ваш Telegram ID

Бот відповідатиме **лише** цьому акаунту. Усіх інших він мовчки ігнорує.

1. Напишіть будь-що [@userinfobot](https://t.me/userinfobot).
2. Він відповість числом `Id: 123456789`. Потрібне саме це число, @username не підходить.

## 3. Ключ OpenRouter

Через OpenRouter бот звертається до моделі ШІ. Модель можна змінити пізніше в `/settings`.

1. Зареєструйтеся на [openrouter.ai](https://openrouter.ai).
2. Поповніть баланс: [Credits](https://openrouter.ai/settings/credits). Кількох доларів вистачить надовго.
3. [Keys](https://openrouter.ai/keys) → **Create Key** → скопіюйте ключ `sk-or-v1-…`. Він показується один раз.

## 4. Google: JSON клієнта (Desktop app)

Це дає доступ до вашого Google Calendar і Gmail. Усе робиться в [Google Cloud Console](https://console.cloud.google.com)
під тим Google-акаунтом, календар якого підключатимете. Займає близько 5 хвилин. **Redirect URI не потрібен.**

1. **Проєкт.** [Створіть проєкт](https://console.cloud.google.com/projectcreate) з будь-якою назвою, напр. `ai-secretary`.
   Далі переконайтеся, що вгорі вибрано саме його.
2. **API.** Увімкніть (**Enable**) дві бібліотеки:
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com);
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
3. **Екран згоди.** Відкрийте [Google Auth Platform](https://console.cloud.google.com/auth/overview) → **Get started**:
   - App name: `AI-secretary`; User support email: ваша пошта → Next;
   - **Audience**:
     - акаунт компанії (Google Workspace) → **Internal**;
     - звичайний Gmail → **External**;
   - Contact information: ваша пошта → Next;
   - погодьтеся з умовами → **Create**.
4. **Тільки для External (звичайний Gmail).** Відкрийте [Audience](https://console.cloud.google.com/auth/audience) →
   **Publish app** → Confirm. Без цього Google відкликає доступ кожні 7 днів.
5. **Клієнт.** Відкрийте [Clients](https://console.cloud.google.com/auth/clients) → **Create client**:
   - Application type: **Desktop app**;
   - Name: `AI-secretary`;
   - **Create**.
6. У вікні, що зʼявиться, натисніть **Download JSON**. Цей файл (`client_secret_….json`) і потрібен — віддайте його
   агенту, який розгортає бота (або вставте вміст цілком у змінну `GOOGLE_CLIENT_JSON`).

**Як потім підключити Google у боті** (після розгортання):

1. Напишіть боту `/start` → **«Підключити Google»**. Відкриється сторінка з кнопкою **«Увійти через Google»**.
2. Оберіть акаунт і дозвольте доступ (усі галочки). Якщо Google напише «застосунок не перевірено» —
   **Додатково → Перейти**: це ваш власний бот.
3. Браузер відкриє адресу `http://127.0.0.1…` і покаже помилку «не вдається отримати доступ» — **так і має бути**.
4. Скопіюйте цю адресу з адресного рядка й надішліть боту. Він відповість «✅ Google підключено».

**«Доступ заблоковано… застосунок тестується» (помилка 403 access_denied)** — екран згоди проєкту в режимі Testing,
а ваш акаунт не в списку тестувальників. Тип клієнта (Desktop app) тут ні до чого. Виправлення:
[Audience](https://console.cloud.google.com/auth/audience) → **Publish app** (або додайте свою пошту в **Test users**).
Назва, яку показує Google (напр. «n8n»), — це назва проєкту в **Branding**; її можна змінити на `AI-secretary`.
