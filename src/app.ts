import {
  type Config,
  type Env,
  googleConfigured,
  REQUIRED_VARS,
} from "./env";
import { decodePush, gmailPushToken, type PubSubPush, startGmailWatch } from "./google/gmailPush";
import { botUsername, connectWithCode } from "./google/connect";
import { googleAuthUrl, hasGmailScope, hasGoogleAuth, verifyState } from "./google/oauth";
import { isOurChannel } from "./google/sync";
import { type Job, runWithRetry } from "./jobs";
import { safeEqual } from "./lib/crypto";
import { logError } from "./lib/errors";
import { code, messagePage, renderPage, renderSetupPage, type SetupStep, stepsList } from "./setup";
import { esc, Telegram } from "./telegram/api";
import { firstTime } from "./session";
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

/** "Back to Telegram" button for the result pages. */
async function backToBot(env: Env): Promise<{ href: string; label: string } | undefined> {
  const username = await botUsername(env);
  return username ? { href: `https://t.me/${username}`, label: "Повернутися в Telegram" } : undefined;
}

/**
 * Reminders need a clock, and a free Vercel project has none finer than a day. Besides the 5-minute pinger
 * (/api/cron/reminders), any traffic the bot gets anyway — a Telegram message, a calendar or Gmail push — also checks
 * for due reminders, at most every 3 minutes per instance. Reminders are marked on the event, so double checks never
 * send twice.
 */
async function nudgeReminders(env: Env): Promise<void> {
  if (firstTime("nudge:reminders", 3 * 60_000)) await env.jobs.send({ type: "reminders" }).catch(() => undefined);
}

/** POST /api/telegram — Telegram webhook. Answers at once; the update is handled in the background. */
export async function telegramWebhook(req: Request, env: Env, runtime: Runtime): Promise<Response> {
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const update = (await req.json()) as TgUpdate;
  await nudgeReminders(env);
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

/**
 * GET /api/oauth/start — the owner's "Підключити Google" link. Web client: straight to Google. Desktop app client:
 * a short, friendly page first, because after Google the browser lands on the owner's own computer (an error page)
 * and its address has to be sent to the bot.
 */
export async function oauthStart(req: Request, env: Env): Promise<Response> {
  if (!googleConfigured(env)) return Response.redirect(`${env.PUBLIC_URL}/api/setup`, 302);
  const state = new URL(req.url).searchParams.get("state") ?? "";
  if (!(await verifyState(env, state))) {
    return messagePage("⏳", "Посилання застаріло", "Напишіть боту /settings і натисніть «Підключити Google» ще раз.", 400, await backToBot(env));
  }
  if (env.GOOGLE_OAUTH_MODE !== "desktop") return Response.redirect(googleAuthUrl(env, state), 302);
  const bot = await botUsername(env);
  const botLink = bot ? `<a href="https://t.me/${esc(bot)}">@${esc(bot)}</a>` : "боту";
  return renderPage(
    "Підключення Google",
    `<header><h1>🔗 Підключення Google</h1><p>Три кроки — хвилина часу. Бот отримає доступ до вашого календаря й пошти.</p></header>
${stepsList([
  {
    title: "Увійдіть у Google",
    details: `Оберіть акаунт і дозвольте доступ до календаря та пошти (поставте всі галочки).
Якщо Google попередить «застосунок не перевірено» — натисніть <b>Додатково</b> → <b>Перейти</b>: це ваш власний бот.<br>
Якщо Google пише <b>«Доступ заблоковано… застосунок тестується»</b> (помилка 403 access_denied) — у Google Cloud відкрийте
<a href="https://console.cloud.google.com/auth/audience">Google Auth Platform → Audience</a> і натисніть <b>Publish app</b>
(або додайте свою пошту в <b>Test users</b>), потім спробуйте ще раз.<br>
<a class="button" href="${esc(googleAuthUrl(env, state))}">Увійти через Google</a>`,
  },
  {
    title: "Браузер покаже сторінку з помилкою — так і треба",
    details: `Після входу відкриється адреса, що починається з ${code("http://127.0.0.1")}, і браузер напише
«не вдається отримати доступ до сайту». Нічого не зламалось: у цій адресі — одноразовий код доступу.`,
  },
  {
    title: "Скопіюйте адресу з адресного рядка й надішліть боту",
    details: `Надішліть її повідомленням ${botLink} у Telegram — бот підключиться сам і відповість «✅ Google підключено».
Код діє кілька хвилин.`,
  },
])}`,
  );
}

/** GET /api/oauth/callback — Web client: keeps the grant in the chat, subscribes to push, greets the owner (spec 4.1). */
export async function oauthCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const back = await backToBot(env);
  if (!(await verifyState(env, url.searchParams.get("state") ?? ""))) {
    return messagePage("⏳", "Посилання застаріло", "Поверніться в Telegram і спробуйте підключити Google ще раз.", 400, back);
  }
  const tg = new Telegram(env);
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) {
    await tg.send(env.OWNER_TELEGRAM_ID, "Підключення Google скасовано. Спробувати ще раз — /settings.").catch(() => undefined);
    return messagePage("✖️", "Підключення скасовано", "Нічого не змінилось. Спробувати ще раз можна в боті: /settings.", 200, back);
  }
  try {
    if ((await connectWithCode(env, code)) === "no_calendar") {
      return messagePage("⚠️", "Потрібен доступ до календаря", "Поверніться в Telegram і надайте доступ до календаря.", 400, back);
    }
  } catch (err) {
    await logError(env, "oauth.callback", err);
    await tg.send(env.OWNER_TELEGRAM_ID, "😔 Не вдалося підключити Google. Спробуйте ще раз через /settings.").catch(() => undefined);
    return messagePage("😔", "Не вдалося підключити Google", "Спробуйте ще раз через /settings у боті.", 500, back);
  }
  return messagePage("✅", "Google підключено", "Можна повертатися в Telegram — бот уже надіслав підтвердження.", 200, back);
}

/** POST /api/gcal-push — Google push (spec section 3): only a "something changed" signal. */
export async function gcalPush(req: Request, env: Env): Promise<Response> {
  const channelId = req.headers.get("x-goog-channel-id");
  if (!channelId) return new Response("bad request", { status: 400 });
  // Unknown or foreign channel: acknowledge so Google does not retry; it stops at expiration.
  if (!isOurChannel(env, channelId, req.headers.get("x-goog-channel-token"))) return new Response("ok");
  if (req.headers.get("x-goog-resource-state") !== "sync") {
    await env.jobs.send({ type: "sync" });
    await nudgeReminders(env);
  }
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
  await nudgeReminders(env);
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
 * GET /api/cron/reminders — Telegram reminders REMINDER_MINUTES (30 and 10) before meetings, no AI involved. Needs a
 * call every 5 minutes: a free pinger (cron-job.org) or a Vercel Pro cron. Same CRON_SECRET rule as the daily cron.
 */
export async function remindersCron(req: Request, env: Env): Promise<Response> {
  if (env.CRON_SECRET && !safeEqual(req.headers.get("authorization"), `Bearer ${env.CRON_SECRET}`)) {
    return new Response("unauthorized", { status: 401 });
  }
  await env.jobs.send({ type: "reminders" });
  return Response.json({ ok: true });
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
  { command: "start", description: "Почати / підключити Google" },
  { command: "settings", description: "Налаштування" },
  { command: "bitrix", description: "Задачі Bitrix24" },
  { command: "reset", description: "Почати розмову заново" },
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
 * GET /api/setup — opened once after a deploy: registers the Telegram webhook and sends the browser straight to
 * the bot. No status page: everything else happens in the bot. Checks for tools and deploy agents: /api/health.
 */
export async function setupPage(_req: Request, env: Env): Promise<Response> {
  try {
    const { username } = await ensureTelegramWebhook(env);
    return new Response(null, { status: 302, headers: { location: `https://t.me/${username}?start=setup`, "cache-control": "no-store" } });
  } catch {
    return messagePage("⚠️", "Бот не відповідає", "Telegram не прийняв токен бота. Перевірте токен і перерозгорніть проєкт.", 502);
  }
}

/** The setup page when the deployment cannot start yet: which variables are missing or wrong. */
export function setupBootErrorPage(source: Record<string, string | undefined>, message: string): Response {
  const missing = REQUIRED_VARS.filter((k) => !source[k]?.trim());
  const steps: SetupStep[] = [];
  if (missing.length) {
    steps.push({
      status: "error",
      title: "Змінні середовища",
      details: `Додайте змінні середовища й перерозгорніть (Vercel: Project → Settings → Environment Variables): ${missing.map(code).join(", ")}.<ol>
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
