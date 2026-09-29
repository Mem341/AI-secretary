import { createHash } from "node:crypto";
import { type Env, gmailTopic } from "../env";
import { handleReminderEmail, mailNotices } from "./reminders";
import { HttpError } from "../lib/http";
import { formatTime, toKyivDate } from "../lib/time";
import { firstTime } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData } from "../telegram/hidden";
import { type GMessage, Gmail, toMailMessage } from "./gmail";

/** Hidden in a new-mail notice, so a reply to it tells the Gmail agent which email it is about. */
export interface MailRef {
  k: "mail";
  id: string;
}

/** The n8n WF3 "Формат" notice: 📧 Нова пошта! with sender, subject, recipients, time, snippet and a Gmail link. */
export function newMailNotice(m: GMessage): string {
  const mail = toMailMessage(m);
  let date = "";
  if (m.internalDate) {
    const d = new Date(Number(m.internalDate));
    const [y, mo, day] = toKyivDate(d).split("-");
    date = `${day}.${mo}.${y}, ${formatTime(d)}`;
  } else if (mail.date) date = mail.date;
  let msg = "📧 <b>Нова пошта!</b>\n\n";
  msg += `📩 <b>Від:</b> ${esc(mail.from || "Невідомий")}\n`;
  msg += `📌 <b>Тема:</b> ${esc(mail.subject || "Без теми")}\n`;
  if (mail.to) msg += `📨 <b>Кому:</b> ${esc(mail.to)}\n`;
  if (date) msg += `🕐 ${esc(date)}\n`;
  msg += `\n${esc(mail.snippet.replace(/<[^>]*>/g, ""))}`;
  msg += `\n\n🔗 <a href="https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(mail.id)}">Відкрити в Gmail</a>`;
  return msg;
}

/**
 * Instant new-mail notifications (the n8n "Gmail Trigger → Telegram" flow). Gmail publishes mailbox changes to a
 * Cloud Pub/Sub topic (GMAIL_PUBSUB_TOPIC); a push subscription on that topic calls /api/gmail-push; the bot then
 * sends each new INBOX email to the owner. Nothing is stored: an email that was reported gets a hidden Gmail label,
 * so it is never reported twice.
 */

/** Hidden label (not shown in Gmail's label list or on messages) marking emails already sent to Telegram. */
export const SEEN_LABEL = "AI-secretary-seen";
const SEEN_QUERY = `in:inbox -label:${SEEN_LABEL} -from:me newer_than:1d`;

/** Secret in the push endpoint URL, derived so no extra variable is needed. Shown to the owner in /settings only. */
export function gmailPushToken(env: Env): string {
  return createHash("sha256").update(`gmail-push:${env.ENCRYPTION_KEY}`).digest("hex").slice(0, 40);
}

export function gmailPushEndpoint(env: Env): string {
  return `${env.PUBLIC_URL}/api/gmail-push?token=${gmailPushToken(env)}`;
}

let seenLabelId: string | null = null;

export async function seenLabel(gmail: Gmail): Promise<string> {
  seenLabelId ??= (await gmail.ensureLabel(SEEN_LABEL, true)).id;
  return seenLabelId;
}

/**
 * (Re)subscribes the mailbox to the topic; Google expires a watch after 7 days, so the daily cron renews it. On the
 * first subscription the recent inbox is marked as seen, so connecting does not flood the chat with old email.
 */
export async function startGmailWatch(env: Env, first = false): Promise<void> {
  const gmail = new Gmail(env);
  await gmail.watch(gmailTopic(env));
  if (!first) return;
  const label = await seenLabel(gmail);
  for (const id of await gmail.search(SEEN_QUERY, 50)) await gmail.modify(id, [label], []);
}

/** Sends every new INBOX email not reported yet. Returns how many were reported. */
export async function gmailSync(env: Env): Promise<number> {
  const gmail = new Gmail(env);
  const label = await seenLabel(gmail);
  let sent = 0;
  for (const id of await gmail.search(SEEN_QUERY, 10)) {
    // Pub/Sub often pushes several times for one email; the label is the real guard, this saves requests.
    if (!firstTime(`mail:${id}`, 10 * 60_000)) continue;
    // Marked first: a failure while sending must not make every later push report the same email again.
    await gmail.modify(id, [label], []);
    try {
      const m = await gmail.call<GMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
      // The calendar's reminder email: a meeting reminder instead of a "new mail" notice.
      if (await handleReminderEmail(env, m)) continue;
      if (!(await mailNotices(env))) continue;
      await new Telegram(env).send(env.OWNER_TELEGRAM_ID, hiddenData({ k: "mail", id } satisfies MailRef) + newMailNotice(m));
      sent++;
    } catch (err) {
      // A message deleted between the push and now is simply skipped.
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }
  return sent;
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
