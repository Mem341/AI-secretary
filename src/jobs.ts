import { type AgentInput, handleWithAgents } from "./agent";
import { helpText } from "./bot/onboarding";
import { digestEnabled } from "./bot/settings";
import { type Env, gmailPushConfigured } from "./env";
import { gmailSync, startGmailWatch } from "./google/gmailPush";
import { connectLink, forgetGoogleAuth, GoogleAuthRevokedError, hasGmailScope, hasGoogleAuth } from "./google/oauth";
import { sendDigest, sendReminders } from "./google/reminders";
import { markUpcoming, startWatch, syncRecent } from "./google/sync";
import { bytesToBase64 } from "./lib/crypto";
import { logError } from "./lib/errors";
import type { ContentPart } from "./llm/openrouter";
import { takeBatch } from "./session";
import { transcribe } from "./stt/transcribe";
import { esc, Telegram } from "./telegram/api";

/**
 * Background jobs. They run after the HTTP response (Vercel `waitUntil`). There is no database: a job carries
 * everything it needs.
 */
export type Job =
  /** One input for the agents (n8n "AI Agent ALL"); photoIds are Telegram files shown to the model. */
  | { type: "agent"; input: AgentInput; photoIds: string[] }
  /** Debounced burst of forwarded messages; processed only if `seq` is still the latest. */
  | { type: "batch"; chatId: number; seq: number }
  /** Transcribe a voice message (n8n "Whisper STT"), then hand it to the agents. */
  | { type: "voice"; chatId: number; fileId: string; messageId: number; replyText: string | null; replyRef?: string | null }
  /** Report calendar changes after a Google push. */
  | { type: "sync" }
  /** Right after Google is connected: push channel, remember upcoming events, Gmail watch, greet. */
  | { type: "connected"; gmail: boolean }
  /** Daily: morning digest, renew the push channels, remember newly added events. */
  | { type: "daily" }
  /** Report emails that arrived since the last Gmail push. */
  | { type: "gmail_sync" }
  /** Telegram reminders shortly before meetings (/api/cron/reminders). */
  | { type: "reminders" };

export const JOB_ATTEMPTS = 3;
/** Agent runs change things (events, mail): never repeated automatically, as in n8n. */
const ONCE = new Set<Job["type"]>(["agent", "batch", "voice"]);

const PHOTO_MARK = /^\[\[photo:([^\]]+)\]\]$/;

async function images(env: Env, fileIds: string[]): Promise<ContentPart[]> {
  const tg = new Telegram(env);
  const out: ContentPart[] = [];
  for (const id of fileIds) {
    const { bytes, path } = await tg.download(id);
    const mime = path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
    out.push({ type: "image_url", image_url: { url: `data:${mime};base64,${bytesToBase64(bytes)}` } });
  }
  return out;
}

/** The chat shows "печатает…" while the agents work (n8n "Send a chat action"). */
async function withTyping(env: Env, chatId: number, work: () => Promise<void>): Promise<void> {
  const stop = new Telegram(env).keepTyping(chatId);
  try {
    await work();
  } finally {
    stop();
  }
}

export async function runJob(env: Env, job: Job): Promise<void> {
  switch (job.type) {
    case "agent":
      return withTyping(env, job.input.chatId, async () =>
        handleWithAgents(env, { ...job.input, images: await images(env, job.photoIds) }),
      );
    case "batch": {
      const batch = takeBatch(job.chatId, job.seq);
      if (!batch) return;
      const photos = batch.lines.map((l) => PHOTO_MARK.exec(l)?.[1]).filter((x): x is string => !!x);
      const text = `Переслана переписка:\n${batch.lines.filter((l) => !PHOTO_MARK.test(l)).join("\n")}`;
      return withTyping(env, job.chatId, async () =>
        handleWithAgents(env, { chatId: job.chatId, inputType: "forward", text, images: await images(env, photos) }),
      );
    }
    case "voice":
      return withTyping(env, job.chatId, async () => {
        const tg = new Telegram(env);
        const { bytes } = await tg.download(job.fileId);
        const text = await transcribe(env, bytes);
        if (!text) {
          await tg.send(job.chatId, "Не вдалося розібрати голосове. Спробуйте ще раз або напишіть текстом.", { replyTo: job.messageId });
          return;
        }
        await tg.send(job.chatId, `🎙 <i>${esc(text)}</i>`, { replyTo: job.messageId });
        await handleWithAgents(env, { chatId: job.chatId, inputType: "voice", text, replyText: job.replyText, replyRef: job.replyRef });
      });
    case "sync":
      if (await hasGoogleAuth(env)) await syncRecent(env);
      return;
    case "connected": {
      await startWatch(env);
      const count = await markUpcoming(env);
      // New-mail notifications are optional: a Pub/Sub problem must not fail the connection.
      if (job.gmail && gmailPushConfigured(env)) {
        await startGmailWatch(env, true).catch((err) => logError(env, "gmail.watch", err));
      }
      await new Telegram(env).send(env.OWNER_TELEGRAM_ID, `✅ Google підключено. Подій на найближчі 30 днів: ${count}.\n\n${helpText()}`);
      return;
    }
    case "daily":
      if (!(await hasGoogleAuth(env))) return;
      if (await digestEnabled(env)) await sendDigest(env).catch((err) => logError(env, "digest", err));
      await startWatch(env);
      await markUpcoming(env);
      // A Gmail watch lapses after 7 days; renewing daily keeps new-mail notifications flowing.
      if (gmailPushConfigured(env) && (await hasGmailScope(env))) {
        await startGmailWatch(env).catch((err) => logError(env, "gmail.watch", err));
      }
      return;
    case "gmail_sync":
      if (await hasGmailScope(env)) await gmailSync(env);
      return;
    case "reminders":
      if (await hasGoogleAuth(env)) await sendReminders(env);
      return;
  }
}

async function handleRevoked(env: Env): Promise<void> {
  await forgetGoogleAuth(env);
  await new Telegram(env).send(env.OWNER_TELEGRAM_ID, "⚠️ Доступ до Google втрачено. Підключіть його знову.", {
    keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]],
  });
}

/** Tells the owner a job finally failed so the request is not lost silently. */
async function reportJobFailure(env: Env, job: Job): Promise<void> {
  const tg = new Telegram(env);
  if (job.type === "agent" || job.type === "batch") {
    await tg.send(env.OWNER_TELEGRAM_ID, "😔 Не вдалося обробити запит. Спробуйте ще раз.").catch(() => undefined);
  } else if (job.type === "voice") {
    await tg.send(job.chatId, "😔 Не вдалося обробити голосове. Спробуйте ще раз.", { replyTo: job.messageId }).catch(() => undefined);
  }
}

/**
 * Runs a job with up to three attempts (spec section 6). A revoked Google authorization is not retried: the owner
 * is asked to reconnect. The final failure is logged, reported to the owner, and never thrown.
 */
export async function runWithRetry(
  env: Env,
  job: Job,
  sleep: (ms: number) => Promise<void>,
  attempts = JOB_ATTEMPTS,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await runJob(env, job);
      return;
    } catch (err) {
      if (err instanceof GoogleAuthRevokedError) {
        await handleRevoked(env).catch((e) => logError(env, "job.revoked", e));
        return;
      }
      if (attempt < (ONCE.has(job.type) ? 1 : attempts)) {
        await sleep(2000 * attempt);
        continue;
      }
      await logError(env, `job.${job.type}`, err);
      await reportJobFailure(env, job).catch(() => undefined);
      return;
    }
  }
}
