import { getUserById, updateUser } from "./db/users";
import { all } from "./db/client";
import { type Config, type Env, googleConfigured, googleRedirectUri, REQUIRED_VARS, voiceConfigured } from "./env";
import type { Db } from "./db/client";
import { completeAuth, connectLink, forgetGoogleAuth, googleAuthUrl, verifyState } from "./google/oauth";
import { channelOwner, RENEW_BEFORE_MS, startWatch } from "./google/sync";
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

/** Wires configuration, database and the background job runner together. */
export function createEnv(config: Config, db: Db, runtime: Runtime): Env {
  const env: Env = {
    ...config,
    db,
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
      await logError(env, "telegram.update", err, { payload: update });
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
    return page("Посилання застаріло", "Відкрийте /settings у боті й натисніть «Підключити календар» ще раз.", 400);
  }
  return Response.redirect(googleAuthUrl(env, state), 302);
}

/** GET /api/oauth/callback — stores tokens, subscribes to push, starts the initial sync (spec 4.1). */
export async function oauthCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const userId = await verifyState(env, url.searchParams.get("state") ?? "");
  if (!userId) return page("Посилання застаріло", "Поверніться в Telegram і спробуйте підключити календар ще раз.", 400);
  const user = await getUserById(env.db, userId);
  if (!user || user.tg_id !== env.OWNER_TELEGRAM_ID) return page("Немає доступу", "Цей акаунт не має доступу до бота.", 403);
  const tg = new Telegram(env);

  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) {
    await tg.send(user.tg_id, "Підключення календаря скасовано. Спробувати ще раз — /settings.").catch(() => undefined);
    return page("Підключення скасовано", "Поверніться в Telegram.");
  }

  try {
    const { email, scope } = await completeAuth(env, userId, code);
    if (!scope.includes("calendar.events")) {
      await forgetGoogleAuth(env, userId);
      await tg.send(user.tg_id, "Потрібен доступ до подій календаря — поставте галочку на екрані Google.", {
        keyboard: [[{ text: "🔗 Спробувати ще раз", url: await connectLink(env, userId) }]],
      });
      return page("Недостатньо доступу", "Поверніться в Telegram і надайте доступ до календаря.", 400);
    }
    if (email) await updateUser(env.db, userId, { email: email.toLowerCase() });
    await startWatch(env, userId);
    await env.jobs.send({ type: "full_sync", userId, notify: true });
  } catch (err) {
    await logError(env, "oauth.callback", err, { userId });
    await tg.send(user.tg_id, "😔 Не вдалося підключити календар. Спробуйте ще раз через /settings.").catch(() => undefined);
    return page("Помилка", "Не вдалося підключити календар. Спробуйте ще раз.", 500);
  }
  return page("Календар підключено ✅", "Можна повертатися в Telegram.");
}

/** POST /api/gcal-push — Google push (spec section 3): only a "something changed" signal. */
export async function gcalPush(req: Request, env: Env): Promise<Response> {
  const channelId = req.headers.get("x-goog-channel-id");
  if (!channelId) return new Response("bad request", { status: 400 });
  const userId = await channelOwner(env, channelId, req.headers.get("x-goog-channel-token"));
  // Unknown or stale channel: acknowledge so Google does not retry; it stops at expiration.
  if (!userId) return new Response("ok");
  if (req.headers.get("x-goog-resource-state") !== "sync") await env.jobs.send({ type: "sync", userId });
  return new Response("ok");
}

/**
 * GET /api/cron/daily — Vercel Cron (Hobby plan allows one run a day): renews push channels that expire within two
 * days and runs the full window sync, the safety net for lost pushes. The work is idempotent; CRON_SECRET, when set,
 * restricts the endpoint to Vercel Cron.
 */
export async function dailyCron(req: Request, env: Env): Promise<Response> {
  if (env.CRON_SECRET && !safeEqual(req.headers.get("authorization"), `Bearer ${env.CRON_SECRET}`)) {
    return new Response("unauthorized", { status: 401 });
  }
  const rows = await all<{ user_id: number; expiration: number | null }>(
    env.db,
    "SELECT g.user_id, w.expiration FROM google_auth g LEFT JOIN watch_channels w ON w.user_id = g.user_id",
  );
  for (const r of rows) {
    const renew = r.expiration === null || r.expiration < Date.now() + RENEW_BEFORE_MS;
    await env.jobs.send({ type: "daily", userId: r.user_id, renew });
  }
  return Response.json({ ok: true, users: rows.length });
}

/**
 * GET /api/health — deployment check for the owner or a deploy agent: configuration and database are fine, and whether
 * the Telegram webhook points here. Never returns secrets.
 */
export async function healthCheck(_req: Request, env: Env): Promise<Response> {
  const checks: Record<string, unknown> = { config: true };
  try {
    await all(env.db, "SELECT 1");
    checks.database = true;
  } catch (err) {
    checks.database = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
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
  const owner = await all<{ id: number }>(env.db, "SELECT id FROM users WHERE tg_id = $1", [env.OWNER_TELEGRAM_ID]);
  checks.owner_started = owner.length > 0;
  checks.calendar_connected = owner.length
    ? (await all(env.db, "SELECT 1 FROM google_auth WHERE user_id = $1", [owner[0]!.id])).length > 0
    : false;
  checks.public_url = env.PUBLIC_URL;
  const ok = checks.database === true && checks.telegram_webhook === true;
  return Response.json({ ok, ...checks }, { status: ok ? 200 : 503 });
}

const BOT_COMMANDS = [
  { command: "new", description: "Нова зустріч" },
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
  const info = await tg.call<{ url: string }>("getWebhookInfo", {});
  // The secret cannot be read back, so the webhook is (re)registered whenever the URL differs.
  if (info.url === url) return { username: me.username, changed: false };
  await tg.call("setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  await tg.call("setMyCommands", { commands: BOT_COMMANDS });
  return { username: me.username, changed: true };
}

/**
 * GET /api/setup — the page whoever deployed this copy opens first: registers the Telegram webhook and shows a
 * checklist (Telegram, Google Calendar, voice, first /start). Safe to open repeatedly; reveals no secrets.
 */
export async function setupPage(_req: Request, env: Env): Promise<Response> {
  const steps: SetupStep[] = [
    { status: "ok", title: "Змінні середовища", details: `Обовʼязкові задані: ${REQUIRED_VARS.map(code).join(", ")}.` },
    { status: "ok", title: "База даних", details: "Postgres підключено, таблиці створено автоматично." },
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
      ? { status: "ok", title: "Google Calendar", details: `OAuth-клієнт задано. Redirect URI: ${code(redirect)}` }
      : {
          status: "todo",
          title: "Google Calendar",
          details: `Створіть OAuth-клієнт, щоб бот міг працювати з вашим календарем:<ol>
<li><a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">Увімкніть Google Calendar API</a> у своєму проєкті Google Cloud.</li>
<li><a href="https://console.cloud.google.com/auth/overview">OAuth consent screen</a>: для Google Workspace — <b>Internal</b>; для звичайного Gmail — <b>External</b> і кнопка <b>Publish app</b> (у режимі Testing Google відключає доступ кожні 7 днів).</li>
<li><a href="https://console.cloud.google.com/apis/credentials">Credentials</a> → Create credentials → OAuth client ID → <b>Web application</b>, Authorized redirect URI: ${code(redirect)}</li>
<li>Додайте у Vercel змінні ${code("GOOGLE_CLIENT_ID")} і ${code("GOOGLE_CLIENT_SECRET")} та зробіть Redeploy.</li></ol>`,
        },
  );

  steps.push(
    voiceConfigured(env)
      ? { status: "ok", title: "Голосові повідомлення", details: "ElevenLabs підключено." }
      : {
          status: "optional",
          title: "Голосові повідомлення (необовʼязково)",
          details: `Щоб бот розумів голосові, додайте ${code("ELEVENLABS_API_KEY")} (<a href="https://elevenlabs.io/app/settings/api-keys">ключ ElevenLabs</a>).`,
        },
  );

  const owner = await all<{ id: number; full_name: string | null }>(env.db, "SELECT id, full_name FROM users WHERE tg_id = $1", [
    env.OWNER_TELEGRAM_ID,
  ]);
  const calendar = owner.length
    ? (await all(env.db, "SELECT 1 FROM google_auth WHERE user_id = $1", [owner[0]!.id])).length > 0
    : false;
  const botLink = botUsername ? `<a class="button" href="https://t.me/${esc(botUsername)}?start=setup">Відкрити бота</a>` : "";
  steps.push(
    calendar
      ? { status: "ok", title: "Ви підключені", details: "Профіль заповнено, календар підключено. Пишіть боту про зустрічі." }
      : {
          status: "todo",
          title: owner[0]?.full_name ? "Підключіть календар у боті" : "Напишіть боту /start",
          details: `Бот відповідає лише власнику з ${code("OWNER_TELEGRAM_ID")}. Відкрийте бота, заповніть профіль і натисніть «Підключити Google Calendar».<br>${botLink}`,
        },
  );
  return renderSetupPage(steps);
}

/** The setup page when the deployment cannot start yet: which variables or which database are missing. */
export function setupBootErrorPage(source: Record<string, string | undefined>, databaseUrl: string | undefined, message: string): Response {
  const missing = REQUIRED_VARS.filter((k) => !source[k]?.trim());
  const steps: SetupStep[] = [];
  if (missing.length) {
    steps.push({
      status: "error",
      title: "Змінні середовища",
      details: `Додайте у Vercel (Project → Settings → Environment Variables) і зробіть Redeploy: ${missing.map(code).join(", ")}.<ol>
<li>${code("TELEGRAM_BOT_TOKEN")} — у <a href="https://t.me/BotFather">@BotFather</a> командою /newbot.</li>
<li>${code("OWNER_TELEGRAM_ID")} — ваш числовий ID, його напише <a href="https://t.me/userinfobot">@userinfobot</a>. Бот відповідатиме лише цій людині.</li>
<li>${code("OPENROUTER_API_KEY")} — <a href="https://openrouter.ai/keys">openrouter.ai/keys</a>.</li></ol>`,
    });
  } else if (databaseUrl) {
    // Variables are present, so the failure is the value of one of them or the database connection.
    steps.push({ status: "error", title: "Запуск", details: esc(message) });
  } else {
    steps.push({ status: "ok", title: "Змінні середовища", details: `Обовʼязкові задані: ${REQUIRED_VARS.map(code).join(", ")}.` });
  }
  if (!databaseUrl) {
    steps.push({
      status: "todo",
      title: "База даних",
      details: "У Vercel відкрийте проєкт → <b>Storage</b> → <b>Create Database</b> → <b>Neon</b> (безкоштовний план), підключіть до проєкту й зробіть Redeploy. Таблиці створяться автоматично.",
    });
  }
  return renderSetupPage(steps);
}
