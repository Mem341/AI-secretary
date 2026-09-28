---
name: deploy-aws
description: Deploy a personal copy of the open-source AI-secretary Telegram bot to the user's own AWS account (Lambda Function URL + EventBridge cron via AWS SAM, Postgres on Neon) — ask the few inputs only the user can provide, build, deploy, and finish on the /api/setup page. Use when the user asks to deploy, redeploy, update or set up the bot on AWS / Amazon / Lambda.
---

# Deploy AI-secretary to AWS

AI-secretary is open source; anyone can run their own copy. Each copy serves exactly **one** Telegram user
(`OWNER_TELEGRAM_ID`), everyone else is ignored. On AWS it runs as:

- **ApiFunction** — one Lambda behind a **Function URL** (response streaming) serving every endpoint
  (`/api/telegram`, `/api/gcal-push`, `/api/gmail-push`, `/api/oauth/*`, `/api/setup`, `/api/health`);
- **CronFunction** — the daily job (renews Google push channels, safety-net sync), on an EventBridge schedule;
- **Postgres** outside AWS on **Neon** (free, reachable over HTTPS, so no VPC/NAT is needed).

Infrastructure is `aws/template.yaml` (AWS SAM); code is bundled by `npm run build:aws` into `dist/aws/aws.js`.
Human-readable background: `docs/deploy-aws.md`. Never echo secrets back to the user or commit them;
`aws/samconfig.toml` is git-ignored for that reason.

## Step 0 — tools and access (check, don't ask, when you can)

- `node -v` → 22.x; `aws --version` (AWS CLI v2); `sam --version` (AWS SAM CLI). Install SAM with the official
  installer (Homebrew `brew install aws-sam-cli`, the Windows MSI, or the Linux zip from AWS docs).
- `aws sts get-caller-identity` must succeed. If it does not, ask the user to configure credentials
  (`aws configure` / `aws configure sso`, or an AWS MCP server) — never ask them to paste secret keys into chat
  if a profile can be used instead.
- Prefer AWS MCP tools when connected (e.g. for CloudFormation outputs and logs); otherwise use the CLIs.

## Step 1 — ask the user (one message, all at once)

| # | What | Required | How the user gets it |
|---|------|----------|----------------------|
| 1 | Telegram **bot token** | yes | @BotFather → `/newbot` |
| 2 | Their **numeric Telegram ID** — the only person the bot answers | yes | Message @userinfobot (a @username does not work) |
| 3 | **OpenRouter API key** | yes | https://openrouter.ai/keys (account needs credit) |
| 4 | **Postgres connection string** | yes | Free database at https://neon.tech → Connection string (`postgresql://…?sslmode=require`) |
| 5 | AWS **region** | no, default `eu-central-1` | Closest to the user (Frankfurt for Ukraine) |
| 6 | Google Calendar/Gmail now or later? | no | The /api/setup page gives the steps and the redirect URI after the first deploy |
| 7 | ElevenLabs key (voice), Zoom Server-to-Server app, Gmail Pub/Sub topic | no | Optional — see /api/setup |
| 8 | Custom domain? | no | Default: the Function URL (detected automatically) |

Nothing else is needed: the webhook secret and encryption key are derived from the bot token, and the public URL
is taken from the Function URL on the first request.

## Step 2 — build and deploy

```bash
npm ci
npm run build:aws                      # → dist/aws/aws.js
cd aws
sam deploy \
  --stack-name ai-secretary --region <region> \
  --capabilities CAPABILITY_IAM --resolve-s3 --no-confirm-changeset \
  --parameter-overrides \
    OwnerTelegramId=<id> TelegramBotToken=<token> OpenRouterApiKey=<key> DatabaseUrl='<postgres-url>'
```

**Without SAM CLI, through the AWS MCP server** (its `run_script` calls boto3; no local AWS CLI needed):
1. `npm run build:aws`, then zip `dist/aws/aws.js` (as `aws.js` at the archive root).
2. Create or pick an S3 bucket in the region; upload the zip with a presigned PUT URL from `get_presigned_url`.
3. In `aws/template.yaml` replace `CodeUri: ../dist/aws/` with `CodeUri: s3://<bucket>/<key>.zip`.
4. CloudFormation `CreateStack` (later `UpdateStack`) with that template body, the parameters, and
   `Capabilities: [CAPABILITY_IAM, CAPABILITY_AUTO_EXPAND]` (the SAM transform needs AUTO_EXPAND); poll
   `DescribeStacks` until `CREATE_COMPLETE`, then read the outputs.

Save the parameters for later updates: copy `aws/samconfig.toml.example` to `aws/samconfig.toml` and fill it in
(then `sam deploy` alone redeploys). Optional parameters: `GoogleClientId`, `GoogleClientSecret`,
`ElevenLabsApiKey`, `ZoomAccountId`, `ZoomClientId`, `ZoomClientSecret`, `GmailPubsubTopic`, `LlmModel`,
`PublicUrl`, `EncryptionKey`, `CronSecret` (see the template).

## Step 3 — finish on the setup page

1. Read the stack outputs: `aws cloudformation describe-stacks --stack-name ai-secretary --query "Stacks[0].Outputs"`.
   `FunctionUrl` is the bot's address; `GoogleRedirectUri` is what Google needs.
2. Open `<FunctionUrl>api/setup` (or just `<FunctionUrl>`). It registers the Telegram webhook itself and shows a
   checklist of what is left.
3. Google Calendar & Gmail: guide the user through the steps on that page (enable Calendar + Gmail APIs, OAuth
   consent screen, **Web application** client with the `GoogleRedirectUri`), then redeploy with
   `GoogleClientId`/`GoogleClientSecret`. Consent screen: Google Workspace → *Internal* (no limits); personal
   Gmail → *External + Publish app* — Gmail is a "restricted" scope, so Google shows "this app isn't verified" on
   sign-in (*Advanced → Continue* is fine for one person; unverified apps are capped at 100 users). In *Testing*
   the grant expires every 7 days (the bot asks to reconnect); Google verification removes the warning.
4. The user sends `/start` to the bot, fills the profile, presses «Підключити Google Calendar».

## Step 4 — verify

- `curl <FunctionUrl>api/health` → `"ok": true`, `"database": true`, `"telegram_webhook": true`.
- The owner writes «зустріч з тестом завтра о 10:00» → «Створити» → the event is in Google Calendar.
- A message from another Telegram account gets no reply.
- Logs: `sam logs --stack-name ai-secretary --name ApiFunction --tail` (and `CronFunction`).

## Updating

`git pull && npm ci && npm run build:aws && cd aws && sam deploy`. The database schema migrates itself.

## Troubleshooting

- **403 from the Function URL**: the public invoke permission is missing. A Function URL with `AuthType: NONE`
  needs a resource policy allowing `lambda:InvokeFunctionUrl` (SAM adds it) and, on newer accounts, also
  `lambda:InvokeFunction` for principal `*` restricted to Function URL invocations — add it per the current AWS
  docs for Function URLs.
- **Streaming unavailable** (rare region/account limits): set `InvokeMode: BUFFERED` and `Handler: aws.bufferedHandler`
  for `ApiFunction` — it works the same but answers after the background work finishes.
- **Cron says PUBLIC_URL is missing**: nobody has opened the bot's URL yet — open `/api/setup` once.
- Everything else (Google, Telegram, Gmail): the errors are listed in the bot with `/errors` and on `/api/setup`.
