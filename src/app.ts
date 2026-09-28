import { getUserById, updateUser } from "./db/users";
import { all } from "./db/client";
import type { Config, Env } from "./env";
import type { Db } from "./db/client";
import { completeAuth, connectLink, forgetGoogleAuth, googleAuthUrl, verifyState } from "./google/oauth";
import { channelOwner, RENEW_BEFORE_MS, startWatch } from "./google/sync";
import { type Job, runWithRetry } from "./jobs";
import { safeEqual } from "./lib/crypto";
import { logError } from "./lib/errors";
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
 * days and runs the full window sync, the safety net for lost pushes.
 */
export async function dailyCron(req: Request, env: Env): Promise<Response> {
  if (!safeEqual(req.headers.get("authorization"), `Bearer ${env.CRON_SECRET}`)) {
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
