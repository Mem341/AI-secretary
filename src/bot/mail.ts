import type { Env } from "../env";
import { addressOf, Gmail, type MailMessage, nameOf, replySubject } from "../google/gmail";
import { connectLink, forgetGoogleAuth, GoogleAuthRevokedError, hasGmailScope, hasGoogleAuth } from "../google/oauth";
import { chatJson } from "../llm/openrouter";
import { mailSystemPrompt } from "../llm/prompts";
import { expectAnswer } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData, readHidden } from "../telegram/hidden";
import type { InlineKeyboard, TgMessage } from "../telegram/types";
import { type DirectoryEntry, findInDirectory } from "./card";
import { loadDirectory } from "./contacts";
import { loadOwner } from "./owner";

/** A Gmail request, as understood by the LLM (the n8n "Gmail Agent" tools, behind a confirmation card). */
export interface MailAction {
  action: "search" | "send" | "reply" | "draft" | "archive" | "mark_read" | "label" | "trash" | "unclear";
  query: string | null;
  to: { name: string | null; email: string | null }[];
  subject: string | null;
  body: string | null;
  label: string | null;
  clarify_question: string | null;
  /** The Gmail message the owner replied to (a notice or a search result), when there is one. */
  target_id: string | null;
}

const ACTIONS = new Set(["search", "send", "reply", "draft", "archive", "mark_read", "label", "trash"]);
const NEEDS_TARGET = new Set(["reply", "archive", "mark_read", "label", "trash"]);
const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Keyword routing of a NEW free-text request to Gmail rather than to a meeting card (the n8n router's table).
 * Whole words only, so "листопада" (November) never counts as "лист".
 */
const MAIL_RE =
  /(^|[^\p{L}])(лист(а|и|ів|і|ом|ами)?|пошт(а|у|і|ою)|почт(а|у|е|ой)|письм(о|а|ом)|email|e-mail|імейл|имейл|мейл|inbox|вхідн\p{L}*|чернетк\p{L}*|черновик\p{L}*|gmail|мітк(а|у|и)|label)(?=$|[^\p{L}])/iu;

export function looksLikeMailRequest(text: string): boolean {
  return MAIL_RE.test(text);
}

export function normalizeMail(raw: unknown, directory: DirectoryEntry[], targetId: string | null): MailAction {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let action = (typeof r.action === "string" && ACTIONS.has(r.action) ? r.action : "unclear") as MailAction["action"];
  const to: MailAction["to"] = [];
  for (const item of Array.isArray(r.to) ? r.to : []) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = str(rec.name);
    let email = str(rec.email)?.toLowerCase() ?? null;
    if (email && !EMAIL_RE.test(email)) email = null;
    if (!email && name) email = findInDirectory(directory, name)?.email.toLowerCase() ?? null;
    if (name || email) to.push({ name, email });
  }
  let clarify = str(r.clarify_question);
  if (NEEDS_TARGET.has(action) && !targetId) {
    action = "unclear";
    clarify ??= "Про який лист ідеться? Відповідайте на повідомлення з листом.";
  }
  if ((action === "send" || action === "draft") && (!to.length || to.some((t) => !t.email))) {
    const missing = to.filter((t) => !t.email).map((t) => t.name).filter(Boolean);
    action = "unclear";
    clarify ??= missing.length ? `Вкажіть email для: ${missing.join(", ")}.` : "Кому надіслати лист?";
  }
  return {
    action,
    query: str(r.query),
    to,
    subject: str(r.subject),
    body: str(r.body),
    label: str(r.label),
    clarify_question: clarify,
    target_id: targetId,
  };
}

/** Hidden in a message showing an email, so a reply to it acts on that email. */
export interface MailRef {
  k: "mail";
  id: string;
}

/** Hidden in a clarifying question about mail: the request so far and the email it is about. */
export interface MailQuestion {
  k: "mailq";
  src: string;
  t: string | null;
}

/** Hidden in a confirmation of an action that sends or removes mail. */
interface MailActionData {
  k: "mact";
  a: MailAction;
}

async function requireGmail(env: Env, chatId: number): Promise<boolean> {
  if ((await hasGoogleAuth(env)) && (await hasGmailScope(env))) return true;
  await new Telegram(env).send(
    chatId,
    "Щоб я працював з поштою, дайте доступ до Gmail: перепідключіть Google (у вікні Google поставте галочки для пошти).",
    { keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]] },
  );
  return false;
}

/** Entry point from the router, "/mail", or a reply to an email (`targetId`). */
export async function startMailDraft(env: Env, chatId: number, text: string, targetId: string | null = null): Promise<void> {
  if (!(await requireGmail(env, chatId))) return;
  await new Telegram(env).typing(chatId);
  await env.jobs.send({ type: "mail", text, targetId });
}

// ---------------------------------------------------------------------------------------------------------------
// Showing email

const MAX_BODY = 3500;

export function mailCardHtml(m: MailMessage, heading = "📧"): string {
  return [
    `${heading} <b>${esc(nameOf(m.from))}</b>${m.unread ? " · нове" : ""}`,
    `<b>${esc(m.subject || "(без теми)")}</b>`,
    esc(m.snippet),
  ].join("\n");
}

export function mailButtons(m: MailMessage): InlineKeyboard {
  const row = [{ text: "📖 Прочитати", callback_data: `g:${m.id}:r` }];
  if (m.unread) row.push({ text: "✅ Прочитано", callback_data: `g:${m.id}:u` });
  row.push({ text: "🗄 В архів", callback_data: `g:${m.id}:a` });
  return [row];
}

/** Sends one message per email so a reply to any of them acts on exactly that email. */
export async function sendMailCard(env: Env, m: MailMessage, heading?: string): Promise<void> {
  const html = hiddenData({ k: "mail", id: m.id } satisfies MailRef) + mailCardHtml(m, heading);
  await new Telegram(env).send(env.OWNER_TELEGRAM_ID, html, { keyboard: mailButtons(m) });
}

async function showSearch(env: Env, query: string): Promise<void> {
  const gmail = new Gmail(env);
  const ids = await gmail.search(query, 5);
  const tg = new Telegram(env);
  if (!ids.length) {
    await tg.send(env.OWNER_TELEGRAM_ID, `📭 Листів не знайдено (${esc(query)}).`);
    return;
  }
  await tg.send(env.OWNER_TELEGRAM_ID, `📬 Знайдено: ${ids.length}${ids.length === 5 ? "+" : ""}. Відповідайте на лист, щоб відповісти, архівувати чи додати мітку.`);
  for (const id of ids) await sendMailCard(env, await gmail.get(id));
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing and confirmation

function renderMail(action: MailAction, target: MailMessage | null): { html: string; confirm: string | null } {
  const recipients = action.to.map((t) => (t.name ? `${esc(t.name)} &lt;${esc(t.email)}&gt;` : esc(t.email))).join(", ");
  switch (action.action) {
    case "send":
      return {
        html: [`📤 <b>Надіслати лист?</b>`, "", `Кому: ${recipients}`, `Тема: ${esc(action.subject ?? "(без теми)")}`, "", `<i>${esc(action.body)}</i>`].join("\n"),
        confirm: "✅ Надіслати",
      };
    case "reply":
      return {
        html: [
          `↩️ <b>Відповісти ${esc(nameOf(target!.from))}?</b>`,
          `Тема: ${esc(replySubject(target!.subject))}`,
          "",
          `<i>${esc(action.body)}</i>`,
        ].join("\n"),
        confirm: "✅ Надіслати",
      };
    case "label":
      return { html: `🏷 <b>Додати мітку «${esc(action.label)}»</b> до листа «${esc(target!.subject)}»?`, confirm: "✅ Так" };
    case "trash":
      return { html: `🗑 <b>Перемістити в кошик</b> лист «${esc(target!.subject)}» від ${esc(nameOf(target!.from))}?`, confirm: "✅ Так" };
    default:
      return {
        html: `❓ ${esc(action.clarify_question ?? "Уточніть, будь ласка, що зробити з поштою.")}\n\n<i>Відповідайте на це повідомлення.</i>`,
        confirm: null,
      };
  }
}

/** Job: classifies a Gmail request; runs read-only actions, asks to confirm anything that sends or removes mail. */
export async function parseMail(env: Env, text: string, targetId: string | null, now = new Date()): Promise<void> {
  const user = await loadOwner(env);
  const gmail = new Gmail(env);
  const target = targetId ? await gmail.get(targetId) : null;
  const directory = await loadDirectory(env);
  const raw = await chatJson(env, env.LLM_MODEL, [
    { role: "system", content: mailSystemPrompt(user, directory, target && { from: target.from, subject: target.subject, body: target.bodyText }, now) },
    { role: "user", content: text },
  ]);
  const action = normalizeMail(raw, directory, targetId);
  const tg = new Telegram(env);
  const chat = env.OWNER_TELEGRAM_ID;

  // Read-only and easily reversible actions run at once; anything that sends or removes mail waits for "✅".
  if (action.action === "search") {
    await showSearch(env, action.query ?? "is:unread in:inbox");
    return;
  }
  if (action.action === "archive" || action.action === "mark_read") {
    await gmail.modify(target!.id, [], action.action === "archive" ? ["INBOX"] : ["UNREAD"]);
    await tg.send(chat, action.action === "archive" ? "🗄 Лист в архіві." : "✅ Позначено як прочитаний.");
    return;
  }
  if (action.action === "draft") {
    await gmail.createDraft({ to: action.to.map((t) => t.email!), subject: action.subject ?? "", body: action.body ?? "" });
    await tg.send(chat, `📝 Чернетку «${esc(action.subject ?? "(без теми)")}» збережено в Gmail.`);
    return;
  }

  const { html, confirm } = renderMail(action, target);
  if (!confirm) {
    const question: MailQuestion = { k: "mailq", src: text.slice(-1000), t: targetId };
    await tg.send(chat, hiddenData(question) + html, { forceReply: "Відповідь" });
    expectAnswer(chat, question);
    return;
  }
  const keyboard: InlineKeyboard = [[{ text: confirm, callback_data: "m:y" }, { text: "✖️ Скасувати", callback_data: "m:x" }]];
  await tg.send(chat, hiddenData({ k: "mact", a: action } satisfies MailActionData) + html, { keyboard });
}

/** "m:<y|x>" — confirmation of a mail action that sends or removes something; the action is in the message. */
export async function handleMailCallback(env: Env, message: TgMessage | undefined, button: string): Promise<string | undefined> {
  const tg = new Telegram(env);
  const data = readHidden<MailActionData>(message);
  if (!message || data?.k !== "mact") return "Дію не знайдено";
  const chat = env.OWNER_TELEGRAM_ID;
  if (button === "x") {
    await tg.edit(chat, message.message_id, "✖️ Скасовано.");
    return "Скасовано";
  }
  if (button !== "y") return undefined;
  const action = data.a;
  // Shown before sending, so a second tap finds no buttons.
  await tg.edit(chat, message.message_id, "⏳ Виконую…");

  try {
    const gmail = new Gmail(env);
    let result: string;
    if (action.action === "send") {
      await gmail.send({ to: action.to.map((t) => t.email!), subject: action.subject ?? "", body: action.body ?? "" });
      result = `✅ Лист надіслано: ${esc(action.to.map((t) => t.name ?? t.email).join(", "))}`;
    } else if (action.action === "reply" && action.target_id) {
      const target = await gmail.get(action.target_id);
      await gmail.send(
        {
          to: [addressOf(target.from)],
          subject: replySubject(target.subject),
          body: action.body ?? "",
          inReplyTo: target.messageId,
          references: target.references,
        },
        target.threadId,
      );
      result = `✅ Відповідь надіслано: ${esc(nameOf(target.from))}`;
    } else if (action.action === "label" && action.target_id && action.label) {
      const label = await gmail.ensureLabel(action.label);
      await gmail.modify(action.target_id, [label.id], []);
      result = `🏷 Мітку «${esc(label.name)}» додано.`;
    } else if (action.action === "trash" && action.target_id) {
      await gmail.trash(action.target_id);
      result = "🗑 Лист у кошику (його можна відновити в Gmail протягом 30 днів).";
    } else {
      return "Немає що підтвердити";
    }
    await tg.edit(chat, message.message_id, result);
    return "Готово";
  } catch (err) {
    await tg.edit(chat, message.message_id, "😔 Не вдалося виконати. Спробуйте ще раз.").catch(() => undefined);
    if (err instanceof GoogleAuthRevokedError) {
      await forgetGoogleAuth(env);
      await tg.send(chat, "⚠️ Доступ до Google втрачено. Підключіть його знову і спробуйте ще раз.", {
        keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]],
      });
      return undefined;
    }
    throw err;
  }
}

/** "g:<gmailId>:<r|u|a>" — quick, reversible buttons under an email: read in full, mark read, archive. */
export async function handleMailQuickAction(env: Env, gmailId: string, op: string): Promise<string | undefined> {
  const gmail = new Gmail(env);
  const tg = new Telegram(env);
  if (op === "r") {
    const m = await gmail.get(gmailId);
    const body = m.bodyText.length > MAX_BODY ? `${m.bodyText.slice(0, MAX_BODY)}…` : m.bodyText;
    await tg.send(
      env.OWNER_TELEGRAM_ID,
      hiddenData({ k: "mail", id: m.id } satisfies MailRef) +
      [`📧 <b>${esc(m.from)}</b>`, `<b>${esc(m.subject || "(без теми)")}</b>`, esc(m.date), "", esc(body || m.snippet)].join("\n"),
    );
    if (m.unread) await gmail.modify(gmailId, [], ["UNREAD"]);
    return undefined;
  }
  if (op === "u") {
    await gmail.modify(gmailId, [], ["UNREAD"]);
    return "Прочитано";
  }
  if (op === "a") {
    await gmail.modify(gmailId, [], ["INBOX"]);
    return "В архіві";
  }
  return undefined;
}
