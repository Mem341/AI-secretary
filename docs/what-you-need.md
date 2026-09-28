# Що потрібно для запуску бота

Для роботи потрібні **чотири речі**. Більше нічого не потрібно.

| # | Що | Приклад | Де взяти |
|---|----|---------|----------|
| 1 | **Токен Telegram-бота** | `7412345678:AAH3k…` | [§1](#1-токен-telegram-бота) |
| 2 | **Ваш Telegram ID** (число) | `123456789` | [§2](#2-ваш-telegram-id) |
| 3 | **Ключ OpenRouter** (ШІ і голосові) | `sk-or-v1-…` | [§3](#3-ключ-openrouter) |
| 4 | **Google Client ID і Client Secret** | `…apps.googleusercontent.com` і `GOCSPX-…` | [§4](#4-google-client-id-і-client-secret) |

Залежно від місця розгортання:

- **Vercel**: більше нічого, якщо агент зможе сам створити базу Neon (через Vercel CLI або Neon MCP). Якщо не
  зможе — він одразу, разом із цими чотирма пунктами, попросить рядок підключення з [neon.tech](https://neon.tech)
  (хвилина, безкоштовно). Без бази бот не запуститься: між повідомленнями він памʼятає доступ до Google, картку
  зустрічі до «Створити», звʼязки відповідей і стан календаря.
- **AWS**: окрім чотирьох пунктів, потрібні ще:
  - рядок підключення до бази з [neon.tech](https://neon.tech) (безкоштовно; `postgresql://…?sslmode=require`);
  - доступ до вашого акаунта AWS.

Голосові повідомлення розпізнає той самий OpenRouter — окремий ключ не потрібен.

**Необовʼязково, якщо захочете (без цього бот повністю працює):**

- **Zoom** — зустрічі в Zoom замість Google Meet: Account ID, Client ID і Client Secret застосунку
  Server-to-Server OAuth ([Zoom Marketplace](https://marketplace.zoom.us/develop/create), scope `meeting:write:admin`);
- миттєві сповіщення про нові листи (Cloud Pub/Sub) — кроки на сторінці `/api/setup`.

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

## 4. Google Client ID і Client Secret

Це дає доступ до вашого Google Calendar і Gmail. Усе робиться в [Google Cloud Console](https://console.cloud.google.com)
під тим Google-акаунтом, календар якого підключатимете. Займає близько 5 хвилин.

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
   **Publish app** → Confirm.
   - Без цього Google відкликає доступ кожні 7 днів.
   - Під час підключення Google покаже «Google hasn't verified this app». Це нормально для особистого бота:
     натисніть **Advanced → Go to AI-secretary (unsafe)**.
5. **Клієнт.** Відкрийте [Clients](https://console.cloud.google.com/auth/clients) → **Create client**:
   - Application type: **Web application**;
   - Name: `AI-secretary`;
   - **Authorized redirect URIs** поки залиште порожнім (адреса зʼявиться після розгортання);
   - **Create**.
6. Скопіюйте **Client ID** (`…apps.googleusercontent.com`) і **Client secret** (`GOCSPX-…`).

**Після розгортання — один крок.** Сторінка `/api/setup` покаже ваш Redirect URI, наприклад
`https://ai-secretary.vercel.app/api/oauth/callback`. Додайте його в той самий клієнт:

1. Clients → AI-secretary → **Authorized redirect URIs** → **Add URI**.
2. Вставте адресу → **Save**.
3. Зміни діють протягом кількох хвилин.
