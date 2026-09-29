# 📘 AI-secretary — інструкція

> Чернетка: сюди перенесено всі покрокові інструкції, які раніше були на сторінці `/api/setup`.
> Сторінка тепер показує лише, чи все працює, і посилається сюди.

Що вже працює одразу після розгортання: бот, голосові повідомлення, ранковий список зустрічей.
Далі — що можна підключити.

---

## 1. Google Calendar і Gmail

Потрібен файл Google-клієнта типу **Desktop app** (5 хвилин):

1. У проєкті [Google Cloud](https://console.cloud.google.com/) увімкніть
   [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) і
   [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
2. [Google Auth Platform](https://console.cloud.google.com/auth/overview) → **Get started**:
   для Google Workspace — **Internal**; для звичайного Gmail — **External**, потім **Audience → Publish app**.
3. [Clients](https://console.cloud.google.com/auth/clients) → **Create client** → **Desktop app** → Create →
   **Download JSON**.
4. Вміст файлу цілком вставте у змінну `GOOGLE_CLIENT_JSON` (Vercel → Settings → Environment Variables) і
   перерозгорніть проєкт.
5. У боті: `/start` → **Підключити Google** → увійдіть і дозвольте все → скопіюйте адресу з браузера
   (`http://127.0.0.1…`) і надішліть боту.

Бот закріпить повідомлення «🔐 Google підключено» — не відкріплюйте його.

<details><summary>Клієнт типу «Web application» замість Desktop app</summary>

Теж працює, але в клієнті треба додати Authorized redirect URI:
`https://<ваш-проєкт>.vercel.app/api/oauth/callback`.
</details>

---

## 2. Нагадування перед зустріччю

Коли нагадувати, ви обираєте в боті: **/settings → ⏰ Нагадування** (1 год, 30, 15, 10, 5 хв).

Щоб нагадування приходили, адресу `https://<ваш-проєкт>.vercel.app/api/cron/reminders` треба викликати кожні
5 хвилин (безкоштовний Vercel сам так не вміє):

1. [cron-job.org](https://cron-job.org) → **Sign up** → **Create cronjob**.
2. URL — адреса вище, Schedule — **Every 5 minutes** → **Create**.
3. Якщо ви задали змінну `CRON_SECRET`: у вкладці **Advanced** додайте заголовок
   `Authorization: Bearer <CRON_SECRET>`.

---

## 3. Сповіщення про нові листи

Без цього пошта працює на запит («перевір пошту»). Щоб бот одразу писав «📧 Нова пошта!»:

1. Увімкніть [Cloud Pub/Sub API](https://console.cloud.google.com/apis/library/pubsub.googleapis.com) і
   створіть топік, напр. `gmail-notify`.
2. У топіку → **Permissions** дайте `gmail-api-push@system.gserviceaccount.com` роль **Pub/Sub Publisher**.
3. Додайте змінну `GMAIL_PUBSUB_TOPIC` = `projects/<project-id>/topics/gmail-notify` і перерозгорніть.
4. У боті: **/settings → 📧 Адреса для сповіщень про листи**. Створіть у топіку підписку типу **Push** на цю
   адресу.
5. **/settings → Перепідключити Google** — бот підпишеться на скриньку.

---

## 4. Zoom

Google Meet працює без налаштувань. Для зустрічей у Zoom:

1. [Zoom Marketplace](https://marketplace.zoom.us/develop/create) → застосунок **Server-to-Server OAuth**,
   scope `meeting:write:admin`.
2. Додайте змінні `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` і перерозгорніть.

Далі просто пишіть «…у Zoom».

---

## Як користуватись

Пишіть боту як людині — текстом, голосом, скріншотом чи пересланою перепискою:

- «Зустріч з Іваном завтра о 14» · «Що в мене сьогодні?» · «Перенеси стендап на 15:00»
- «Перевір пошту» · «Листи від Марії за тиждень»
- Відповідайте (reply) на повідомлення бота про зустріч чи лист: «скасуй», «хто буде?», «додай нотатку: …»

Команди: `/settings` — підключення й нагадування · `/reset` — почати розмову заново · `/help` — довідка.
