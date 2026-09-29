import { parseAction } from "./bot/actions";
import { parseMail } from "./bot/mail";
import { type CardData, type Draft, editDraft, handleOwnerText, parseDraft, processBatch } from "./bot/meetings";
import { helpText, MENU_ROWS } from "./bot/onboarding";
import { loadOwner } from "./bot/owner";
import { type Env, gmailPushConfigured } from "./env";
import { gmailSync, startGmailWatch } from "./google/gmailPush";
import { connectLink, forgetGoogleAuth, GoogleAuthRevokedError, hasGmailScope, hasGoogleAuth } from "./google/oauth";
import { sendDigest, sendReminders } from "./google/reminders";
import { markUpcoming, startWatch, syncRecent } from "./google/sync";
import { logError } from "./lib/errors";
import { transcribe } from "./stt/transcribe";
import { esc, Telegram } from "./telegram/api";
import type { TgMessage } from "./telegram/types";

/**
 * Background jobs. They run after the HTTP response (Vercel `waitUntil`), with retries.
 * There is no database: a job carries everything it needs.
 */
export type Job =
  /** Debounced batch of forwarded messages / screenshots; processed only if `seq` is still the latest. */
  | { type: "batch"; chatId: number; seq: number }
  /** Build a card from a request and show it in place of `messageId` (a placeholder), or as a new message. */
  | { type: "parse"; draft: Draft; messageId: number | null }
  /** Apply a free-text correction to a card. */
  | { type: "edit"; data: CardData; instruction: string; messageId: number | null }
  /** Classify a reply about an existing event (reschedule/cancel/note) and ask for confirmation. */
  | { type: "action"; eventId: string; text: string }
  /** Classify a Gmail request: run read-only actions, or ask to confirm sending/removing. */
  | { type: "mail"; text: string; targetId: string | null }
  /** Transcribe a voice message, then treat it as text. */
  | { type: "voice"; chatId: number; fileId: string; messageId: number; replyTo: TgMessage | null }
  /** Report calendar changes after a Google push. */
  | { type: "sync" }
  /** Right after Google is connected: push channel, remember upcoming events, Gmail watch, greet. */
  | { type: "connected"; gmail: boolean }
  /** Daily: renew the push channels, remember newly added events (safety net for lost pushes). */
  | { type: "daily" }
  /** Report emails that arrived since the last Gmail push. */
  | { type: "gmail_sync" }
  /** Telegram reminders shortly before meetings (/api/cron/reminders). */
  | { type: "reminders" };

export const JOB_ATTEMPTS = 3;

/** Jobs the owner is waiting for: the chat shows "печатает…" while they run. */
const VISIBLE_JOBS = new Set<Job["type"]>(["batch", "parse", "edit", "action", "mail", "voice"]);

export async function runJob(env: Env, job: Job): Promise<void> {
  if (!VISIBLE_JOBS.has(job.type)) return runJobInner(env, job);
  const stop = new Telegram(env).keepTyping(env.OWNER_TELEGRAM_ID);
  try {
    await runJobInner(env, job);
  } finally {
    stop();
  }
}

async function runJobInner(env: Env, job: Job): Promise<void> {
  switch (job.type) {
    case "batch":
      return processBatch(env, job.chatId, job.seq);
    case "parse":
      return parseDraft(env, job.draft, job.messageId);
    case "edit":
      return editDraft(env, job.data, job.instruction, job.messageId);
    case "action":
      return parseAction(env, job.eventId, job.text);
    case "mail":
      return parseMail(env, job.text, job.targetId);
    case "voice": {
      const tg = new Telegram(env);
      const { bytes } = await tg.download(job.fileId);
      const text = await transcribe(env, bytes);
      if (!text) {
        await tg.send(job.chatId, "Не вдалося розібрати голосове. Спробуйте ще раз або напишіть текстом.", { replyTo: job.messageId });
        return;
      }
      await tg.send(job.chatId, `🎙 <i>${esc(text)}</i>`, { replyTo: job.messageId });
      return handleOwnerText(env, await loadOwner(env), job.chatId, text, "voice", job.replyTo);
    }
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
      await new Telegram(env).send(env.OWNER_TELEGRAM_ID, `✅ Google підключено. Подій на найближчі 30 днів: ${count}.\n\n${helpText()}`, {
        menu: MENU_ROWS,
      });
      return;
    }
    case "daily":
      if (!(await hasGoogleAuth(env))) return;
      await sendDigest(env).catch((err) => logError(env, "digest", err));
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
  if (job.type === "batch" || job.type === "parse" || job.type === "edit") {
    await tg.send(env.OWNER_TELEGRAM_ID, "😔 Не вдалося підготувати картку. Спробуйте ще раз.").catch(() => undefined);
  } else if (job.type === "action" || job.type === "mail") {
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
      if (attempt < attempts) {
        await sleep(2000 * attempt);
        continue;
      }
      await logError(env, `job.${job.type}`, err);
      await reportJobFailure(env, job).catch(() => undefined);
      return;
    }
  }
}
