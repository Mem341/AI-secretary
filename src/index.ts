import { editDraft, handleOwnerText, parseDraft, processBatch } from "./bot/meetings";
import { helpText } from "./bot/onboarding";
import { getDraft, transition } from "./db/drafts";
import { getUserById, updateUser } from "./db/users";
import type { Env } from "./env";
import { completeAuth, connectLink, forgetGoogleAuth, googleAuthUrl, GoogleAuthRevokedError, verifyState } from "./google/oauth";
import { channelOwner, fullSync, incrementalSync, RENEW_BEFORE_MS, startWatch } from "./google/sync";
import type { Job } from "./jobs";
import { safeEqual } from "./lib/crypto";
import { logError } from "./lib/errors";
import { transcribe } from "./stt/elevenlabs";
import { esc, Telegram } from "./telegram/api";
import { handleUpdate } from "./telegram/handler";
import type { TgUpdate } from "./telegram/types";

export type { Env };

// Cron expressions from wrangler.jsonc.
const CRON_RENEW_CHANNELS = "17 3 * * *";
const CRON_FULL_SYNC = "5 */6 * * *";

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center;color:#1f2328}
h1{font-size:1.4rem}p{color:#57606a;line-height:1.5}</style></head><body><h1>${esc(title)}</h1><p>${esc(body)}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function telegramWebhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const update = (await req.json()) as TgUpdate;
  // Answer Telegram right away; heavy work goes to the queue from inside the handler.
  ctx.waitUntil(
    handleUpdate(env, update).catch(async (err) => {
      await logError(env, "telegram.update", err, { payload: update });
      const chatId = update.message?.chat.id ?? update.callback_query?.from.id;
      if (chatId) await new Telegram(env).send(chatId, "😔 Щось пішло не так. Спробуйте ще раз.").catch(() => undefined);
    }),
  );
  return new Response("ok");
}

async function oauthStart(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  if (!(await verifyState(env, state))) {
    return page("Посилання застаріло", "Відкрийте /settings у боті й натисніть «Підключити календар» ще раз.", 400);
  }
  return Response.redirect(googleAuthUrl(env, state), 302);
}

async function oauthCallback(url: URL, env: Env): Promise<Response> {
  const userId = await verifyState(env, url.searchParams.get("state") ?? "");
  if (!userId) return page("Посилання застаріло", "Поверніться в Telegram і спробуйте підключити календар ще раз.", 400);
  const user = await getUserById(env.DB, userId);
  if (!user?.active || user.role !== "owner") return page("Немає доступу", "Цей акаунт не має доступу до бота.", 403);
  const tg = new Telegram(env);

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error || !code) {
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
    if (email && !user.email) await updateUser(env.DB, userId, { email: email.toLowerCase() });
    // Spec 4.1: right after OAuth — events.watch subscription and the initial 30-day sync.
    await startWatch(env, userId);
    await env.JOBS.send({ type: "full_sync", userId, notify: true });
  } catch (err) {
    await logError(env, "oauth.callback", err, { userId });
    await tg.send(user.tg_id, "😔 Не вдалося підключити календар. Спробуйте ще раз через /settings.").catch(() => undefined);
    return page("Помилка", "Не вдалося підключити календар. Спробуйте ще раз.", 500);
  }
  return page("Календар підключено ✅", "Можна повертатися в Telegram.");
}

/** Google push (spec section 3): only a "something changed" signal; the sync runs in the queue. */
async function gcalPush(req: Request, env: Env): Promise<Response> {
  const channelId = req.headers.get("x-goog-channel-id");
  const state = req.headers.get("x-goog-resource-state");
  if (!channelId) return new Response("bad request", { status: 400 });
  const userId = await channelOwner(env, channelId, req.headers.get("x-goog-channel-token"));
  // Unknown or stale channel: acknowledge so Google does not retry; it stops at expiration.
  if (!userId) return new Response("ok");
  if (state !== "sync") await env.JOBS.send({ type: "sync", userId });
  return new Response("ok");
}

async function handleRevoked(env: Env, userId: number): Promise<void> {
  await forgetGoogleAuth(env, userId);
  const user = await getUserById(env.DB, userId);
  if (user) {
    await new Telegram(env).send(user.tg_id, "⚠️ Доступ до Google Calendar втрачено. Підключіть календар знову.", {
      keyboard: [[{ text: "🔗 Підключити Google Calendar", url: await connectLink(env, userId) }]],
    });
  }
}

async function runJob(env: Env, job: Job): Promise<void> {
  switch (job.type) {
    case "batch":
      return processBatch(env, job.draftId, job.seq);
    case "parse":
      return parseDraft(env, job.draftId);
    case "edit":
      return editDraft(env, job.draftId, job.instruction);
    case "voice": {
      const user = await getUserById(env.DB, job.userId);
      if (!user) return;
      const tg = new Telegram(env);
      const { bytes } = await tg.download(job.fileId);
      const { text } = await transcribe(env, bytes, "voice.ogg");
      if (!text.trim()) {
        await tg.send(job.chatId, "Не вдалося розібрати голосове. Спробуйте ще раз або напишіть текстом.", { replyTo: job.messageId });
        return;
      }
      await tg.send(job.chatId, `🎙 <i>${esc(text.trim())}</i>`, { replyTo: job.messageId });
      return handleOwnerText(env, user, job.chatId, text.trim(), "voice", job.replyTo);
    }
    case "sync":
      await incrementalSync(env, job.userId);
      return;
    case "full_sync": {
      const count = await fullSync(env, job.userId);
      if (job.notify) {
        const user = await getUserById(env.DB, job.userId);
        if (user) {
          await new Telegram(env).send(
            user.tg_id,
            `✅ Календар підключено. Бачу подій на найближчі 30 днів: ${count}.\n\n${helpText(user)}`,
          );
        }
      }
      return;
    }
    case "renew":
      return startWatch(env, job.userId);
  }
}

/** Tells the owner a job finally failed (after all retries) so the request is not lost silently. */
async function reportJobFailure(env: Env, job: Job): Promise<void> {
  const tg = new Telegram(env);
  if (job.type === "batch" || job.type === "parse" || job.type === "edit") {
    const draft = await getDraft(env.DB, job.draftId);
    if (!draft) return;
    await transition(env.DB, draft.id, ["parsing", "collecting"], "failed");
    const user = await getUserById(env.DB, draft.user_id);
    if (user) await tg.send(user.tg_id, "😔 Не вдалося підготувати картку. Спробуйте ще раз.").catch(() => undefined);
  } else if (job.type === "voice") {
    await tg.send(job.chatId, "😔 Не вдалося обробити голосове. Спробуйте ще раз.", { replyTo: job.messageId }).catch(() => undefined);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/telegram/webhook") return await telegramWebhook(req, env, ctx);
      if (req.method === "POST" && url.pathname === "/gcal/push") return await gcalPush(req, env);
      if (req.method === "GET" && url.pathname === "/oauth/google/start") return await oauthStart(url, env);
      if (req.method === "GET" && url.pathname === "/oauth/google/callback") return await oauthCallback(url, env);
      if (req.method === "GET" && url.pathname === "/") return new Response("AI-secretary is running");
      return new Response("not found", { status: 404 });
    } catch (err) {
      await logError(env, `http ${url.pathname}`, err);
      return new Response("internal error", { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const jobs: Job[] = [];
    if (controller.cron === CRON_RENEW_CHANNELS) {
      // Channels expiring within a day, plus connected owners whose subscription failed earlier.
      const { results } = await env.DB.prepare(
        `SELECT g.user_id FROM google_auth g LEFT JOIN watch_channels w ON w.user_id = g.user_id
         WHERE w.user_id IS NULL OR w.expiration < ?`,
      )
        .bind(Date.now() + RENEW_BEFORE_MS)
        .all<{ user_id: number }>();
      for (const r of results) jobs.push({ type: "renew", userId: r.user_id });
    } else if (controller.cron === CRON_FULL_SYNC) {
      const { results } = await env.DB.prepare("SELECT user_id FROM watch_channels").all<{ user_id: number }>();
      for (const r of results) jobs.push({ type: "full_sync", userId: r.user_id });
    }
    // sendBatch accepts up to 100 messages.
    for (let i = 0; i < jobs.length; i += 100) {
      ctx.waitUntil(env.JOBS.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body }))));
    }
  },

  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        await runJob(env, job);
        message.ack();
      } catch (err) {
        if (err instanceof GoogleAuthRevokedError) {
          await handleRevoked(env, err.userId);
          message.ack();
          continue;
        }
        // max_retries = 2 → up to 3 attempts in total (spec section 6).
        if (message.attempts < 3) {
          message.retry({ delaySeconds: 5 * message.attempts });
          continue;
        }
        await logError(env, `job.${job.type}`, err, { userId: "userId" in job ? job.userId : null, payload: job });
        await reportJobFailure(env, job);
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<Env, Job>;
