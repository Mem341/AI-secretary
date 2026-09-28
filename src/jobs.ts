import { parseActionDraft } from "./bot/actions";
import { parseMailDraft } from "./bot/mail";
import { editDraft, handleOwnerText, parseDraft, processBatch } from "./bot/meetings";
import { helpText } from "./bot/onboarding";
import { getDraft, transition } from "./db/drafts";
import { pruneSelfWrites } from "./db/selfWrites";
import { getUserById } from "./db/users";
import type { Env } from "./env";
import { connectLink, forgetGoogleAuth, GoogleAuthRevokedError } from "./google/oauth";
import { fullSync, incrementalSync, startWatch } from "./google/sync";
import { logError } from "./lib/errors";
import { transcribe } from "./stt/elevenlabs";
import { esc, Telegram } from "./telegram/api";

/** Background jobs. They run after the HTTP response (Vercel `waitUntil`), with retries. */
export type Job =
  /** Debounced batch of forwarded messages / screenshots; processed only if `seq` is still the latest. */
  | { type: "batch"; draftId: string; seq: number }
  /** Build a card from the draft's source text. */
  | { type: "parse"; draftId: string }
  /** Apply a free-text correction to the card. */
  | { type: "edit"; draftId: string; instruction: string }
  /** Classify a reply about an existing meeting (reschedule/cancel/note) and show the confirmation. */
  | { type: "action_parse"; draftId: string }
  /** Classify a Gmail request: run read-only actions, or show a confirmation for sending/removing. */
  | { type: "mail_parse"; draftId: string }
  /** Transcribe a voice message, then treat it as text. */
  | { type: "voice"; userId: number; chatId: number; fileId: string; messageId: number; replyTo: number | null }
  /** Incremental calendar sync after a Google push. */
  | { type: "sync"; userId: number }
  /** Full window sync (after OAuth, daily). `notify` tells the owner the result. */
  | { type: "full_sync"; userId: number; notify?: boolean }
  /** Daily maintenance: renew the push channel when `renew`, then the full sync (safety net for lost pushes). */
  | { type: "daily"; userId: number; renew: boolean };

export const JOB_ATTEMPTS = 3;

export async function runJob(env: Env, job: Job): Promise<void> {
  switch (job.type) {
    case "batch":
      return processBatch(env, job.draftId, job.seq);
    case "parse":
      return parseDraft(env, job.draftId);
    case "edit":
      return editDraft(env, job.draftId, job.instruction);
    case "action_parse":
      return parseActionDraft(env, job.draftId);
    case "mail_parse":
      return parseMailDraft(env, job.draftId);
    case "voice": {
      const user = await getUserById(env.db, job.userId);
      if (!user) return;
      const tg = new Telegram(env);
      const { bytes } = await tg.download(job.fileId);
      const text = (await transcribe(env, bytes, "voice.ogg")).text.trim();
      if (!text) {
        await tg.send(job.chatId, "Не вдалося розібрати голосове. Спробуйте ще раз або напишіть текстом.", { replyTo: job.messageId });
        return;
      }
      await tg.send(job.chatId, `🎙 <i>${esc(text)}</i>`, { replyTo: job.messageId });
      return handleOwnerText(env, user, job.chatId, text, "voice", job.replyTo);
    }
    case "sync":
      await incrementalSync(env, job.userId);
      return;
    case "full_sync": {
      const count = await fullSync(env, job.userId);
      if (job.notify) {
        const user = await getUserById(env.db, job.userId);
        if (user) {
          await new Telegram(env).send(user.tg_id, `✅ Календар підключено. Бачу подій на найближчі 30 днів: ${count}.\n\n${helpText()}`);
        }
      }
      return;
    }
    case "daily":
      if (job.renew) await startWatch(env, job.userId);
      await fullSync(env, job.userId);
      await pruneSelfWrites(env.db);
      return;
  }
}

async function handleRevoked(env: Env, userId: number): Promise<void> {
  await forgetGoogleAuth(env, userId);
  const user = await getUserById(env.db, userId);
  if (user) {
    await new Telegram(env).send(user.tg_id, "⚠️ Доступ до Google Calendar втрачено. Підключіть календар знову.", {
      keyboard: [[{ text: "🔗 Підключити Google Calendar", url: await connectLink(env, userId) }]],
    });
  }
}

/** Tells the owner a job finally failed so the request is not lost silently. */
async function reportJobFailure(env: Env, job: Job): Promise<void> {
  const tg = new Telegram(env);
  if (job.type === "batch" || job.type === "parse" || job.type === "edit" || job.type === "action_parse" || job.type === "mail_parse") {
    const draft = await getDraft(env.db, job.draftId);
    if (!draft) return;
    await transition(env.db, draft.id, ["parsing", "collecting"], "failed");
    const user = await getUserById(env.db, draft.user_id);
    if (user) await tg.send(user.tg_id, "😔 Не вдалося підготувати картку. Спробуйте ще раз.").catch(() => undefined);
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
        await handleRevoked(env, err.userId).catch((e) => logError(env, "job.revoked", e));
        return;
      }
      if (attempt < attempts) {
        await sleep(2000 * attempt);
        continue;
      }
      await logError(env, `job.${job.type}`, err, { userId: "userId" in job ? job.userId : null, payload: job });
      await reportJobFailure(env, job).catch(() => undefined);
      return;
    }
  }
}
