import { createHash } from "node:crypto";
import { sendMailCard } from "../bot/mail";
import { exec, one } from "../db/client";
import type { Env } from "../env";
import { HttpError } from "../lib/http";
import { Gmail } from "./gmail";

/**
 * Instant new-mail notifications (the n8n "Gmail Trigger → Telegram" flow). Gmail publishes mailbox changes to a
 * Cloud Pub/Sub topic (GMAIL_PUBSUB_TOPIC); a push subscription on that topic calls /api/gmail-push; the bot then
 * reads the new INBOX messages via history.list and sends each one to the owner.
 */

/** Secret in the push endpoint URL, derived so no extra variable is needed. Shown to the owner in /settings only. */
export function gmailPushToken(env: Env): string {
  return createHash("sha256").update(`gmail-push:${env.ENCRYPTION_KEY}`).digest("hex").slice(0, 40);
}

export function gmailPushEndpoint(env: Env): string {
  return `${env.PUBLIC_URL}/api/gmail-push?token=${gmailPushToken(env)}`;
}

/** (Re)subscribes the mailbox to the topic; Google expires a watch after 7 days, so the daily cron renews it. */
export async function startGmailWatch(env: Env, userId: number): Promise<void> {
  const res = await new Gmail(env, userId).watch(env.GMAIL_PUBSUB_TOPIC);
  const now = Date.now();
  // Keeps the stored history id when renewing, so nothing between the two watches is missed.
  await exec(
    env.db,
    `INSERT INTO gmail_state (user_id, history_id, expiration, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET history_id = COALESCE(gmail_state.history_id, EXCLUDED.history_id),
       expiration = EXCLUDED.expiration, updated_at = EXCLUDED.updated_at`,
    [userId, res.historyId, Number(res.expiration), now],
  );
}

export async function stopGmailWatch(env: Env, userId: number): Promise<void> {
  await new Gmail(env, userId).stop().catch(() => undefined);
  await exec(env.db, "DELETE FROM gmail_state WHERE user_id = $1", [userId]);
}

/** Sends every email that arrived in the INBOX since the last push. Returns how many were reported. */
export async function gmailSync(env: Env, userId: number): Promise<number> {
  const state = await one<{ history_id: string | null }>(env.db, "SELECT history_id FROM gmail_state WHERE user_id = $1", [userId]);
  if (!state?.history_id) return 0;
  const gmail = new Gmail(env, userId);
  let result: { ids: string[]; historyId: string };
  try {
    result = await gmail.newInboxMessages(state.history_id);
  } catch (err) {
    // 404: the history id is too old (Gmail keeps about a week) — start over from now.
    if (err instanceof HttpError && err.status === 404) {
      await exec(env.db, "UPDATE gmail_state SET history_id = NULL WHERE user_id = $1", [userId]);
      await startGmailWatch(env, userId);
      return 0;
    }
    throw err;
  }
  // Saved first: a failure while sending must not make the next push report the same emails again.
  await exec(env.db, "UPDATE gmail_state SET history_id = $1, updated_at = $2 WHERE user_id = $3", [result.historyId, Date.now(), userId]);
  for (const id of result.ids) {
    try {
      await sendMailCard(env, await gmail.get(id), "📨 Новий лист ·");
    } catch (err) {
      // A message deleted between the push and now is simply skipped.
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }
  return result.ids.length;
}

export interface PubSubPush {
  message?: { data?: string; messageId?: string };
  subscription?: string;
}

/** The mailbox address in a Gmail Pub/Sub notification ({"emailAddress", "historyId"}), for logging. */
export function decodePush(body: PubSubPush): { emailAddress?: string; historyId?: string | number } | null {
  if (!body.message?.data) return null;
  try {
    return JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
