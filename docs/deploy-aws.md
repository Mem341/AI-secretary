# Розгортання на AWS

AI-secretary працює однаково на **Vercel** і на **AWS**: той самий код, ті самі адреси (`/api/telegram`,
`/api/setup`…). Бази даних немає ні там, ні там. Цей документ — для людини; покрокова інструкція для агента Claude Code —
`.claude/skills/deploy-aws/SKILL.md` (достатньо сказати агенту «розгорни бота на AWS»).

## Як це влаштовано

```
Telegram ─ webhook ─┐
Google   ─ push ────┤                          ┌─▶ Google Calendar / Gmail API
Браузер  ─ OAuth ───┼─▶ Lambda Function URL ───┼─▶ OpenRouter (LLM)
Pub/Sub  ─ Gmail ───┤   (ApiFunction)          └─▶ Zoom (необовʼязково)
Ви ─ /api/setup ────┘         │
EventBridge (щодня) ─▶ CronFunction
```

| Компонент AWS | Навіщо | Скільки коштує для однієї людини |
|---|---|---|
| **Lambda + Function URL** (`ApiFunction`) | усі HTTP-запити. Режим *response streaming*: відповідь іде одразу, а LLM і синхронізація доробляються після неї | Free Tier: 1 млн запитів і 400 000 GB-с на місяць — з великим запасом |
| **Lambda + EventBridge Scheduler** (`CronFunction`) | раз на добу продовжує push-підписки Google і звіряє календар | безкоштовно в межах Free Tier |

**Бази даних немає.** Доступ до Google зберігається зашифрованим в одному закріпленому повідомленні вашого чату з
ботом, картки зустрічей несуть свої дані всередині повідомлень Telegram, календар бот щоразу читає прямо з Google.
Тож ні RDS, ні VPC, ні Neon не потрібні.

## Що потрібно

- Акаунт AWS і налаштований AWS CLI (`aws sts get-caller-identity` відповідає без помилки).
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
  (Homebrew, MSI для Windows або zip-інсталятор для Linux) і Node.js 22.
- Чотири речі з [docs/what-you-need.md](what-you-need.md): токен бота, ваш числовий Telegram ID, ключ OpenRouter,
  Google Client ID і Client Secret.

## Розгортання

```bash
npm ci
npm run build:aws                 # збирає dist/aws/aws.js
cd aws
cp samconfig.toml.example samconfig.toml   # впишіть свої значення (файл не потрапляє в git)
sam deploy
```

Після деплою:

1. Візьміть `FunctionUrl` з виводу (`aws cloudformation describe-stacks --stack-name ai-secretary`).
2. Відкрийте цю адресу — відкриється сторінка налаштування: вона сама підключить Telegram-бота й покаже,
   що лишилось (Google, Zoom, сповіщення про пошту).
3. Візьміть `GoogleRedirectUri` з виводу й додайте його в Google-клієнт: Clients → Authorized redirect URIs → Save.
4. Напишіть боту `/start`.

Оновлення: `git pull && npm ci && npm run build:aws && cd aws && sam deploy`.

## Параметри

Обовʼязкові: `OwnerTelegramId`, `TelegramBotToken`, `OpenRouterApiKey`, `GoogleClientId`, `GoogleClientSecret`.
Необовʼязкові: `ZoomAccountId`, `ZoomClientId`, `ZoomClientSecret`, `GmailPubsubTopic`, `LlmModel`,
`OwnerName`, `OwnerPosition`, `OwnerPhone`, `DefaultDurationMin`, `DefaultFormat`, `DefaultAddress`,
`PublicUrl` (свій домен), `EncryptionKey`, `CronSecret`.
Значення за замовчуванням і пояснення — у `aws/template.yaml`.

`PUBLIC_URL` на AWS задавати не треба: бот бере адресу Function URL із запиту, а щоденному cron (у якого запиту
немає) стек передає її сам.

## Безпека

- Секретні параметри позначені `NoEcho` — CloudFormation їх не показує, але в Lambda вони лежать як змінні
  середовища (їх бачать адміністратори вашого акаунта AWS). Для особистого бота цього достатньо; для суворіших
  вимог перенесіть їх у SSM Parameter Store / Secrets Manager.
- Function URL публічна (`AuthType: NONE`), бо її викликають Telegram і Google. Захист на рівні застосунку:
  секрет вебхука Telegram, токен каналу Google, токен у адресі Pub/Sub, підписаний `state` в OAuth, і бот
  відповідає лише власнику.

## Якщо щось не так

- **403 від Function URL** — бракує публічного дозволу на виклик. Для `AuthType: NONE` потрібні
  `lambda:InvokeFunctionUrl` (SAM додає сам) і, в нових акаунтах, `lambda:InvokeFunction` для `*` з умовою виклику
  через Function URL — див. актуальну документацію AWS щодо Function URL.
- **Streaming недоступний** — поставте для `ApiFunction` `InvokeMode: BUFFERED` і `Handler: aws.bufferedHandler`.
  Працює так само, лише відповідає після завершення фонової роботи.
- **Логи**: `sam logs --stack-name ai-secretary --name ApiFunction --tail`. Помилки бот також надсилає вам
  у Telegram; останні — командою `/errors`.
