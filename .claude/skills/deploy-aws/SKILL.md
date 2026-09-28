---
name: deploy-aws
description: Deploy a personal copy of the open-source AI-secretary Telegram bot to the user's own AWS account (Lambda Function URL + EventBridge cron via AWS SAM, Postgres on Neon). Collect exactly four inputs from the user (Telegram bot token, their Telegram ID, OpenRouter key, Google OAuth client ID + secret) plus a Neon connection string and AWS access, validate them, build, deploy, add the Google redirect URI, finish on /api/setup. Use when the user asks to deploy, redeploy, update or set up the bot on AWS / Amazon / Lambda.
---

# Deploy AI-secretary to AWS

AI-secretary is open source. Anyone can run their own copy. Each copy answers exactly **one** Telegram user
(`OWNER_TELEGRAM_ID`); everyone else is ignored.

On AWS it runs as:
- **ApiFunction**: one Lambda behind a **Function URL** (response streaming) that serves every `/api/*` endpoint.
- **CronFunction**: the daily job, run by EventBridge.
- **Postgres on Neon**: outside AWS, reached over HTTPS, so no VPC or NAT is needed.

The infrastructure is defined in `aws/template.yaml` (SAM). `npm run build:aws` bundles the code into
`dist/aws/aws.js`. Background reading for humans: `docs/deploy-aws.md`.

Your job is to take the user from nothing to a working bot: they can create a meeting in their Google Calendar from
Telegram. Ask only for what they alone can provide, and do everything else yourself.

## Rules of conduct

- **Talk in the user's language** (Russian or Ukrainian if they write that way).
- **Ask for exactly the items in Step 1, in one message.**
  - Do not ask about ElevenLabs/voice, Zoom, Gmail push, Pub/Sub, the model, a domain, `CRON_SECRET` or
    `ENCRYPTION_KEY`.
  - Do not ask for the region; default to `eu-central-1`, or use one the user named.
  - Mention optional extras once, in the final report.
- **If the user lacks an item,** send the steps for that item only from `docs/what-you-need.md` (§1–§4; the Neon
  steps are in Step 1 below). Translate them if needed and keep the links.
- **Validate every value (Step 2) before deploying.**
- **Secrets:**
  - Never repeat them back and never commit them. `aws/samconfig.toml` is git-ignored for that reason.
  - Never ask for AWS secret keys in chat when a profile, SSO or an AWS MCP server can be used instead.

## Step 0 — tools and AWS access (check yourself, don't ask)

- **AWS MCP connected** (`run_script` tool): use it for all AWS calls. Check access with `sts.GetCallerIdentity`.
- **Otherwise:**
  - `aws sts get-caller-identity` must succeed. If it doesn't, ask the user to run `aws configure sso` or
    `aws configure`, or to connect an AWS MCP server.
  - `sam --version` must work; install AWS SAM CLI if needed.
- `node -v` must be 22.x.

## Step 1 — collect the inputs

Send this (adapted to the user's language) and wait for the answers:

> Для запуску бота потрібні:
>
> 1. **Токен Telegram-бота**: @BotFather → `/newbot` → токен вигляду `7412345678:AAH…`
> 2. **Ваш Telegram ID**: число від @userinfobot (бот відповідатиме лише вам)
> 3. **Ключ OpenRouter**: https://openrouter.ai/keys, вигляду `sk-or-v1-…` (на рахунку мають бути кошти)
> 4. **Google Client ID і Client Secret** для календаря й пошти. Якщо їх ще немає, скажіть, і я дам покрокову
>    інструкцію на 5 хвилин.
> 5. **Рядок підключення до бази**: безкоштовно на https://neon.tech → Create project → Connect → скопіюйте
>    `postgresql://…?sslmode=require`
>
> Також: у вас **Google Workspace** (пошта компанії) чи **звичайний Gmail**?

If AWS access failed in Step 0, add a sixth point asking the user to connect AWS (a profile, SSO or AWS MCP).

If the user explicitly wants to deploy **without Google for now**:
- Proceed with the other items and skip Steps 2d and 4.
- Say plainly that meetings will not reach the calendar until the Google keys are added (then redeploy).

## Step 2 — validate (never print the values)

| Item | Format check | Live check |
|------|--------------|------------|
| a. Bot token | `^\d{6,}:[A-Za-z0-9_-]{30,}$` | `curl -s https://api.telegram.org/bot$TOKEN/getMe` → `"ok":true`. Tell the user the bot's @username. |
| b. Telegram ID | Digits only. Not a @username, and not the bot's own ID (the part of the token before `:`). | — |
| c. OpenRouter key | Starts with `sk-or-`. | `curl -s -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key` → HTTP 200. If there is no balance, ask the user to top up. |
| d. Google client | ID ends with `.apps.googleusercontent.com`. Secret usually starts with `GOCSPX-`. | Checked for real in Step 5. |
| e. Postgres URL | Starts with `postgresql://` or `postgres://` and contains `sslmode=require`. | The deployed `/api/health` reports `"database": true`. |

If a check fails, say which item is wrong and why, and ask for that item only.

## Step 3 — build and deploy

```bash
npm ci
npm run build:aws                      # → dist/aws/aws.js
cd aws
sam deploy \
  --stack-name ai-secretary --region <region> \
  --capabilities CAPABILITY_IAM --resolve-s3 --no-confirm-changeset \
  --parameter-overrides \
    OwnerTelegramId=<id> TelegramBotToken=<token> OpenRouterApiKey=<key> DatabaseUrl='<postgres-url>' \
    GoogleClientId=<client-id> GoogleClientSecret=<client-secret>
```

**Without SAM CLI, through the AWS MCP server.** Its `run_script` calls boto3, so no local AWS CLI is needed.
1. Run `npm run build:aws`, then zip `dist/aws/aws.js` so that `aws.js` is at the archive root.
2. Create or pick an S3 bucket in the region. Upload the zip with a presigned PUT URL from `get_presigned_url`.
3. In a copy of `aws/template.yaml`, replace `CodeUri: ../dist/aws/` with `CodeUri: s3://<bucket>/<key>.zip`.
4. Call CloudFormation `CreateStack` (later `UpdateStack`) with:
   - that template body and the parameters above;
   - `Capabilities: [CAPABILITY_IAM, CAPABILITY_AUTO_EXPAND]` (the SAM transform needs AUTO_EXPAND).
5. Poll `DescribeStacks` until `CREATE_COMPLETE`, then read the outputs.

To make later updates one command, offer to save the parameters in `aws/samconfig.toml`: copy it from
`samconfig.toml.example` (the file is git-ignored). After that, `sam deploy` alone redeploys.

## Step 4 — Google redirect URI

1. Read the stack outputs: `FunctionUrl` and `GoogleRedirectUri` (`<FunctionUrl>api/oauth/callback`).
2. Open `<FunctionUrl>api/setup`.
   - The page registers the Telegram webhook itself and stores the public URL for the cron.
   - It shows the same redirect URI.
3. Tell the user to add this exact URI to their OAuth client: Google Cloud Console →
   [Clients](https://console.cloud.google.com/auth/clients) → their client → **Authorized redirect URIs** →
   Add URI → Save.
4. For a **personal Gmail** (External), remind the user to open [Audience](https://console.cloud.google.com/auth/audience)
   and click **Publish app**. Otherwise Google revokes access every 7 days.

## Step 5 — owner connects, verify

1. The user sends `/start` to their bot and fills in the profile.
2. They press «Підключити Google Calendar».
   - Personal Gmail: they click **Advanced → Go to AI-secretary**.
   - They tick all permissions.
3. Smoke test: they send «зустріч з тестом завтра о 10:00» → «Створити». The event must appear in Google Calendar.
4. `curl <FunctionUrl>api/health` must return `"ok": true`, `"database": true` and `"telegram_webhook": true`.
5. Logs: `sam logs --stack-name ai-secretary --name ApiFunction --tail`, or CloudWatch through the MCP.

## Step 6 — final report to the user

Keep it short:
- the bot's @username, the Function URL and the region;
- what was verified;
- anything left for the user to do;
- how to update: `git pull && npm ci && npm run build:aws && cd aws && sam deploy`.

Finish with one line on optional extras. The user can add these any time as stack parameters; `/api/setup` shows
the steps:
- voice messages: `ElevenLabsApiKey`;
- Zoom: `ZoomAccountId`, `ZoomClientId`, `ZoomClientSecret`;
- instant new-mail notices: `GmailPubsubTopic`.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| **403 from the Function URL** | The public invoke permission is missing. `AuthType: NONE` needs `lambda:InvokeFunctionUrl` (SAM adds it). On newer accounts it also needs `lambda:InvokeFunction` for principal `*`, limited to Function URL calls. Add it following the current AWS docs. |
| Streaming unavailable | For `ApiFunction`, set `InvokeMode: BUFFERED` and `Handler: aws.bufferedHandler`. It works the same but replies only after background work finishes. |
| Cron says PUBLIC_URL is missing | Nobody has opened the URL yet. Open `/api/setup` once. |
| Google: `redirect_uri_mismatch` | The URI in the Google client differs from `GoogleRedirectUri`. Copy it exactly. |
| Google: `access_denied` / "app not available" | The External app is still in Testing. Publish it: Audience → Publish app. |
| `"database": false` | Wrong Neon URL, or it is missing `?sslmode=require`. |
| Anything else | The bot reports errors to its owner, and `/errors` lists them. |
