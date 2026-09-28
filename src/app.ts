import {
  type Config,
  type Env,
  gmailPushConfigured,
  googleConfigured,
  googleRedirectUri,
  REQUIRED_VARS,
  zoomConfigured,
} from "./env";
import { decodePush, gmailPushToken, type PubSubPush, startGmailWatch } from "./google/gmailPush";
import { completeAuth, connectLink, forgetGoogleAuth, googleAuthUrl, hasGmailScope, hasGoogleAuth, verifyState } from "./google/oauth";
import { isOurChannel } from "./google/sync";
import { type Job, runWithRetry } from "./jobs";
import { safeEqual } from "./lib/crypto";
import { logError } from "./lib/errors";
import { code, renderSetupPage, type SetupStep } from "./setup";
import { esc, Telegram } from "./telegram/api";
import { handleUpdate } from "./telegram/handler";
import type { TgUpdate } from "./telegram/types";

export interface Runtime {
  /** Keeps the invocation alive for background work after the response (Vercel `waitUntil`). */
  defer(promise: Promise<unknown>): void;
  sleep(ms: number): Promise<void>;
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wires configuration and the background job runner together. */
export function createEnv(config: Config, runtime: Runtime): Env {
  const env: Env = {
    ...config,
    jobs: {
      async send(job: Job, opts?: { delaySeconds?: number }) {
        runtime.defer(
          (async () => {
            if (opts?.delaySeconds) await runtime.sleep(opts.delaySeconds * 1000);
            await runWithRetry(env, job, runtime.sleep);
          })(),
        );
      },
    },
  };
  return env;
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center;color:#1f2328}
h1{font-size:1.4rem}p{color:#57606a;line-height:1.5}</style></head><body><h1>${esc(title)}</h1><p>${esc(body)}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** POST /api/telegram — Telegram webhook. Answers at once; the update is handled in the background. */
export async function telegramWebhook(req: Request, env: Env, runtime: Runtime): Promise<Response> {
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const update = (await req.json()) as TgUpdate;
  runtime.defer(
    handleUpdate(env, update).catch(async (err) => {
      await logError(env, "telegram.update", err);
      const chatId = update.message?.chat.id ?? update.callback_query?.from.id;
      if (chatId === env.OWNER_TELEGRAM_ID) {
        await new Telegram(env).send(chatId, "😔 Щось пішло не так. Спробуйте ще раз.").catch(() => undefined);
      }
    }),
  );
  return new Response("ok");
}

/** GET /api/oauth/start — redirects to Google's consent screen. */
export async function oauthStart(req: Request, env: Env): Promise<Response> {
  if (!googleConfigured(env)) return Response.redirect(`${env.PUBLIC_URL}/api/setup`, 302);
  const state = new URL(req.url).searchParams.get("state") ?? "";
  if (!(await verifyState(env, state))) {
    return page("Посилання застаріло", "Відкрийте /settings у боті й натисніть «Підключити Google» ще раз.", 400);
  }
  return Response.redirect(googleAuthUrl(env, state), 302);
}

/** GET /api/oauth/callback — keeps the grant in the chat, subscribes to push, greets the owner (spec 4.1). */
export async function oauthCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!(await verifyState(env, url.searchParams.get("state") ?? ""))) {
    return page("Посилання застаріло", "Поверніться в Telegram і спробуйте підключити Google ще раз.", 400);
  }
  const tg = new Telegram(env);
  const owner = env.OWNER_TELEGRAM_ID;

  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) {
    await tg.send(owner, "Підключення Google скасовано. Спробувати ще раз — /settings.").catch(() => undefined);
    return page("Підключення скасовано", "Поверніться в Telegram.");
  }

  try {
    const { scope } = await completeAuth(env, code);
    if (!scope.includes("calendar.events")) {
      await forgetGoogleAuth(env);
      await tg.send(owner, "Потрібен доступ до подій календаря — поставте галочку на екрані Google.", {
        keyboard: [[{ text: "🔗 Спробувати ще раз", url: await connectLink(env) }]],
      });
      return page("Недостатньо доступу", "Поверніться в Telegram і надайте доступ до календаря.", 400);
    }
    await env.jobs.send({ type: "connected", gmail: scope.includes("gmail.modify") });
  } catch (err) {
    await logError(env, "oauth.callback", err);
    await tg.send(owner, "😔 Не вдалося підключити Google. Спробуйте ще раз через /settings.").catch(() => undefined);
    return page("Помилка", "Не вдалося підключити Google. Спробуйте ще раз.", 500);
  }
  return page("Google підключено ✅", "Можна повертатися в Telegram.");
}

/** POST /api/gcal-push — Google push (spec section 3): only a "something changed" signal. */
export async function gcalPush(req: Request, env: Env): Promise<Response> {
  const channelId = req.headers.get("x-goog-channel-id");
  if (!channelId) return new Response("bad request", { status: 400 });
  // Unknown or foreign channel: acknowledge so Google does not retry; it stops at expiration.
  if (!isOurChannel(env, channelId, req.headers.get("x-goog-channel-token"))) return new Response("ok");
  if (req.headers.get("x-goog-resource-state") !== "sync") await env.jobs.send({ type: "sync" });
  return new Response("ok");
}

/**
 * POST /api/gmail-push?token=… — Cloud Pub/Sub push subscription for the Gmail watch. Answers 2xx at once (Pub/Sub
 * retries otherwise) and reads the new emails in the background.
 */
export async function gmailPush(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(new URL(req.url).searchParams.get("token"), gmailPushToken(env))) return new Response("forbidden", { status: 403 });
  const body = (await req.json().catch(() => ({}))) as PubSubPush;
  const note = decodePush(body);
  if (note?.emailAddress) console.log("Gmail push", note.emailAddress);
  await env.jobs.send({ type: "gmail_sync" });
  return new Response(null, { status: 204 });
}

/**
 * GET /api/cron/daily — Vercel Cron (Hobby plan allows one run a day): renews the push channels and remembers newly
 * added events, the safety net for lost pushes. The work is idempotent; CRON_SECRET, when set,
 * restricts the endpoint to Vercel Cron.
 */
export async function dailyCron(req: Request, env: Env): Promise<Response> {
  if (env.CRON_SECRET && !safeEqual(req.headers.get("authorization"), `Bearer ${env.CRON_SECRET}`)) {
    return new Response("unauthorized", { status: 401 });
  }
  await env.jobs.send({ type: "daily" });
  return Response.json({ ok: true });
}

/** True once the owner has opened the bot (Telegram knows the chat). */
async function ownerStarted(env: Env): Promise<boolean> {
  return new Telegram(env)
    .call("getChat", { chat_id: env.OWNER_TELEGRAM_ID })
    .then(() => true)
    .catch(() => false);
}

/**
 * GET /api/health — deployment check for the owner or a deploy agent: configuration is fine and the Telegram webhook
 * points here. Never returns secrets.
 */
export async function healthCheck(_req: Request, env: Env): Promise<Response> {
  const checks: Record<string, unknown> = { config: true };
  try {
    const info = await new Telegram(env).call<{ url: string; pending_update_count: number; last_error_message?: string }>(
      "getWebhookInfo",
      {},
    );
    checks.telegram_webhook = info.url === `${env.PUBLIC_URL}/api/telegram` ? true : `points to "${info.url}"`;
    if (info.last_error_message) checks.telegram_last_error = info.last_error_message;
  } catch (err) {
    checks.telegram_webhook = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  checks.owner_started = await ownerStarted(env);
  checks.google_connected = await hasGoogleAuth(env).catch(() => false);
  checks.gmail_connected = checks.google_connected ? await hasGmailScope(env).catch(() => false) : false;
  checks.public_url = env.PUBLIC_URL;
  const ok = checks.telegram_webhook === true;
  return Response.json({ ok, ...checks }, { status: ok ? 200 : 503 });
}

const BOT_COMMANDS = [
  { command: "new", description: "Нова зустріч" },
  { command: "mail", description: "Пошта Gmail" },
  { command: "contacts", description: "Адресна книга" },
  { command: "settings", description: "Профіль і календар" },
  { command: "cancel", description: "Скасувати поточну дію" },
  { command: "help", description: "Що вміє бот" },
];

/** Points the Telegram webhook at this deployment (idempotent) and returns the bot's username. */
export async function ensureTelegramWebhook(env: Env): Promise<{ username: string; changed: boolean }> {
  const tg = new Telegram(env);
  const me = await tg.call<{ username: string }>("getMe", {});
  const url = `${env.PUBLIC_URL}/api/telegram`;
  const info = await tg.call<{ url: string; max_connections?: number }>("getWebhookInfo", {});
  // The command menu is refreshed every time, so an updated deployment shows new commands.
  await tg.call("setMyCommands", { commands: BOT_COMMANDS });
  // The secret cannot be read back, so the webhook is (re)registered whenever the URL or the settings differ.
  if (info.url === url && info.max_connections === 1) return { username: me.username, changed: false };
  await tg.call("setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    // One update at a time: a burst of forwarded messages reaches the same instance in order (see session.ts).
    max_connections: 1,
    drop_pending_updates: true,
  });
  return { username: me.username, changed: true };
}

/**
 * GET /api/setup — the page whoever deployed this copy opens first: registers the Telegram webhook and shows a
 * checklist (Telegram, Google, first /start). Safe to open repeatedly; reveals no secrets.
 */
export async function setupPage(_req: Request, env: Env): Promise<Response> {
  const steps: SetupStep[] = [
    { status: "ok", title: "Змінні середовища", details: `Обовʼязкові задані: ${REQUIRED_VARS.map(code).join(", ")}.` },
  ];

  let botUsername: string | null = null;
  try {
    const { username } = await ensureTelegramWebhook(env);
    botUsername = username;
    steps.push({
      status: "ok",
      title: "Telegram-бот",
      details: `Вебхук зареєстровано на ${code(`${env.PUBLIC_URL}/api/telegram`)}. Бот: <a href="https://t.me/${esc(username)}">@${esc(username)}</a>`,
    });
  } catch (err) {
    steps.push({
      status: "error",
      title: "Telegram-бот",
      details: `Не вдалося звʼязатися з Telegram: ${esc(err instanceof Error ? err.message : String(err))}. Перевірте ${code("TELEGRAM_BOT_TOKEN")}.`,
    });
  }

  const redirect = googleRedirectUri(env);
  steps.push(
    googleConfigured(env)
      ? { status: "ok", title: "Google Calendar і Gmail", details: `OAuth-клієнт задано. Додайте в нього цей Authorized redirect URI (Google Cloud Console → Clients → ваш клієнт): ${code(redirect)}` }
      : {
          status: "todo",
          title: "Google Calendar і Gmail",
          details: `Створіть OAuth-клієнт, щоб бот працював з вашим календарем і поштою:<ol>
<li>У своєму проєкті Google Cloud увімкніть <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Google Calendar API</a> і <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Gmail API</a>.</li>
<li><a href="https://console.cloud.google.com/auth/overview">OAuth consent screen</a>: для Google Workspace — <b>Internal</b> (найпростіше); для звичайного Gmail — <b>External</b>.</li>
<li><a href="https://console.cloud.google.com/apis/credentials">Credentials</a> → Create credentials → OAuth client ID → <b>Web application</b>, Authorized redirect URI: ${code(redirect)}</li>
<li>Додайте змінні ${code("GOOGLE_CLIENT_ID")} і ${code("GOOGLE_CLIENT_SECRET")} у налаштуваннях хостингу та перерозгорніть.</li></ol>
<b>Про доступ до пошти.</b> Gmail — «restricted» дозвіл Google. Для Workspace (Internal) обмежень немає. Для звичайного Gmail
(External) натисніть <b>Publish app</b>: під час входу Google покаже «застосунок не перевірено» — <i>Advanced → Continue</i>
(для особистого використання це нормально, ліміт 100 користувачів). У режимі <b>Testing</b> Google вимагає перепідключення раз на
7 днів (бот нагадає кнопкою). Щоб прибрати попередження зовсім — верифікація застосунку в Google.`,
        },
  );

  steps.push(
    gmailPushConfigured(env)
      ? {
          status: "ok",
          title: "Миттєві сповіщення про нові листи",
          details: `Pub/Sub-топік ${code(env.GMAIL_PUBSUB_TOPIC)}. Адресу для push-підписки (з секретним токеном) бот надсилає вам у /settings.`,
        }
      : {
          status: "optional",
          title: "Миттєві сповіщення про нові листи (необовʼязково)",
          details: `Без цього пошта працює на запит («перевір пошту»). Щоб бот одразу повідомляв про нові листи:<ol>
<li>Увімкніть <a href="https://console.cloud.google.com/apis/library/pubsub.googleapis.com">Cloud Pub/Sub API</a> і створіть топік, напр. ${code("gmail-notify")}.</li>
<li>У топіку → Permissions дайте ${code("gmail-api-push@system.gserviceaccount.com")} роль <b>Pub/Sub Publisher</b>.</li>
<li>Додайте змінну ${code("GMAIL_PUBSUB_TOPIC")} = ${code("projects/<project-id>/topics/gmail-notify")} і перерозгорніть.</li>
<li>Відкрийте в боті /settings — там буде адреса для push-підписки. Створіть у топіку підписку типу <b>Push</b> на цю адресу.</li>
<li>Перепідключіть Google у /settings — бот підпишеться на скриньку.</li></ol>`,
        },
  );

  steps.push(
    zoomConfigured(env)
      ? { status: "ok", title: "Zoom", details: "Zoom підключено — його можна обрати форматом зустрічі." }
      : {
          status: "optional",
          title: "Zoom (необовʼязково)",
          details: `Google Meet працює без налаштувань. Щоб створювати зустрічі в Zoom: у <a href="https://marketplace.zoom.us/develop/create">Zoom Marketplace</a>
створіть застосунок <b>Server-to-Server OAuth</b> зі scope ${code("meeting:write:admin")} і додайте ${code("ZOOM_ACCOUNT_ID")}, ${code("ZOOM_CLIENT_ID")}, ${code("ZOOM_CLIENT_SECRET")}.`,
        },
  );

  const started = await ownerStarted(env);
  const calendar = started && (await hasGoogleAuth(env).catch(() => false));
  const botLink = botUsername ? `<a class="button" href="https://t.me/${esc(botUsername)}?start=setup">Відкрити бота</a>` : "";
  steps.push(
    calendar
      ? { status: "ok", title: "Ви підключені", details: "Google підключено. Пишіть боту про зустрічі." }
      : {
          status: "todo",
          title: started ? "Підключіть Google у боті" : "Напишіть боту /start",
          details: `Бот відповідає лише власнику з ${code("OWNER_TELEGRAM_ID")}. Відкрийте бота, напишіть /start і натисніть «Підключити Google».<br>${botLink}`,
        },
  );
  return renderSetupPage(steps);
}

/** The setup page when the deployment cannot start yet: which variables are missing or wrong. */
export function setupBootErrorPage(source: Record<string, string | undefined>, message: string): Response {
  const missing = REQUIRED_VARS.filter((k) => !source[k]?.trim());
  const steps: SetupStep[] = [];
  if (missing.length) {
    steps.push({
      status: "error",
      title: "Змінні середовища",
      details: `Додайте змінні середовища й перерозгорніть (Vercel: Project → Settings → Environment Variables; AWS: параметри стека в ${code("template.yaml")}): ${missing.map(code).join(", ")}.<ol>
<li>${code("TELEGRAM_BOT_TOKEN")} — у <a href="https://t.me/BotFather">@BotFather</a> командою /newbot.</li>
<li>${code("OWNER_TELEGRAM_ID")} — ваш числовий ID, його напише <a href="https://t.me/userinfobot">@userinfobot</a>. Бот відповідатиме лише цій людині.</li>
<li>${code("OPENROUTER_API_KEY")} — <a href="https://openrouter.ai/keys">openrouter.ai/keys</a>.</li></ol>`,
    });
  } else {
    // Variables are present, so the failure is the value of one of them.
    steps.push({ status: "error", title: "Запуск", details: esc(message) });
  }
  return renderSetupPage(steps);
}
