import { createDraft, getDraft, saveCard, transition } from "../db/drafts";
import { linkMessage } from "../db/messageLinks";
import { getUserById, listContacts, modelOf, saveContact, type User } from "../db/users";
import type { Env } from "../env";
import { addressOf, Gmail, type MailMessage, nameOf, replySubject } from "../google/gmail";
import { connectLink, forgetGoogleAuth, GoogleAuthRevokedError, hasGmailScope, hasGoogleAuth } from "../google/oauth";
import { chatJson } from "../llm/openrouter";
import { mailSystemPrompt } from "../llm/prompts";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { type DirectoryEntry, findInDirectory } from "./card";

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

async function requireGmail(env: Env, user: User, chatId: number): Promise<boolean> {
  if ((await hasGoogleAuth(env, user.id)) && (await hasGmailScope(env, user.id))) return true;
  await new Telegram(env).send(
    chatId,
    "Щоб я працював з поштою, дайте доступ до Gmail: перепідключіть Google (у вікні Google поставте галочки для пошти).",
    { keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env, user.id) }]] },
  );
  return false;
}

/** Entry point from the router, "/mail", or a reply to an email notice (`targetId`). */
export async function startMailDraft(env: Env, user: User, chatId: number, text: string, targetId: string | null = null): Promise<void> {
  if (!(await requireGmail(env, user, chatId))) return;
  const draftId = await createDraft(env.db, user.id, "text", text, "parsing", null, { kind: "mail" });
  if (targetId) await saveCard(env.db, draftId, { target_id: targetId }, "parsing");
  await new Telegram(env).typing(chatId);
  await env.jobs.send({ type: "mail_parse", draftId });
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
  const msg = await new Telegram(env).send(env.OWNER_TELEGRAM_ID, mailCardHtml(m, heading), { keyboard: mailButtons(m) });
  await linkMessage(env.db, msg.message_id, "mail", m.id);
}

async function showSearch(env: Env, user: User, query: string): Promise<void> {
  const gmail = new Gmail(env, user.id);
  const ids = await gmail.search(query, 5);
  const tg = new Telegram(env);
  if (!ids.length) {
    await tg.send(user.tg_id, `📭 Листів не знайдено (${esc(query)}).`);
    return;
  }
  await tg.send(user.tg_id, `📬 Знайдено: ${ids.length}${ids.length === 5 ? "+" : ""}. Відповідайте на лист, щоб відповісти, архівувати чи додати мітку.`);
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

export async function parseMailDraft(env: Env, draftId: string, now = new Date()): Promise<void> {
  const draft = await getDraft(env.db, draftId);
  if (!draft || draft.state !== "parsing") return;
  const user = await getUserById(env.db, draft.user_id);
  if (!user) return;
  const targetId = (draft.card as Partial<MailAction> | null)?.target_id ?? null;
  const gmail = new Gmail(env, user.id);
  const target = targetId ? await gmail.get(targetId) : null;
  const directory = await listContacts(env.db);
  const raw = await chatJson(env, modelOf(user, env.LLM_MODEL), [
    { role: "system", content: mailSystemPrompt(user, directory, target && { from: target.from, subject: target.subject, body: target.bodyText }, now) },
    { role: "user", content: draft.source_text },
  ]);
  const action = normalizeMail(raw, directory, targetId);
  const tg = new Telegram(env);

  // Read-only and easily reversible actions run at once; anything that sends or removes mail waits for "✅".
  if (action.action === "search") {
    await transition(env.db, draftId, ["parsing"], "created");
    await showSearch(env, user, action.query ?? "is:unread in:inbox");
    return;
  }
  if (action.action === "archive" || action.action === "mark_read") {
    await gmail.modify(target!.id, [], action.action === "archive" ? ["INBOX"] : ["UNREAD"]);
    await transition(env.db, draftId, ["parsing"], "created");
    await tg.send(user.tg_id, action.action === "archive" ? "🗄 Лист в архіві." : "✅ Позначено як прочитаний.");
    return;
  }
  if (action.action === "draft") {
    await gmail.createDraft({ to: action.to.map((t) => t.email!), subject: action.subject ?? "", body: action.body ?? "" });
    await transition(env.db, draftId, ["parsing"], "created");
    await tg.send(user.tg_id, `📝 Чернетку «${esc(action.subject ?? "(без теми)")}» збережено в Gmail.`);
    return;
  }

  const { html, confirm } = renderMail(action, target);
  const keyboard: InlineKeyboard = [];
  if (confirm) keyboard.push([{ text: confirm, callback_data: `m:${draftId}:y` }]);
  keyboard.push([{ text: "✖️ Скасувати", callback_data: `m:${draftId}:x` }]);
  let messageId = draft.card_message_id;
  if (messageId) {
    try {
      await tg.edit(user.tg_id, messageId, html, keyboard);
    } catch {
      messageId = null;
    }
  }
  if (!messageId) messageId = (await tg.send(user.tg_id, html, { keyboard })).message_id;
  await saveCard(env.db, draftId, action, "pending", messageId);
}

/** "m:<draftId>:<y|x>" — confirmation of a mail action that sends or removes something. */
export async function handleMailCallback(env: Env, user: User, draftId: string, button: string): Promise<string | undefined> {
  const tg = new Telegram(env);
  const draft = await getDraft(env.db, draftId);
  if (!draft || draft.user_id !== user.id || draft.kind !== "mail") return "Дію не знайдено";
  const messageId = draft.card_message_id;
  if (button === "x") {
    if (!(await transition(env.db, draft.id, ["pending"], "cancelled"))) return "Уже неактуально";
    if (messageId) await tg.edit(user.tg_id, messageId, "✖️ Скасовано.");
    return "Скасовано";
  }
  if (button !== "y") return undefined;
  const action = draft.card as MailAction;
  if (!(await transition(env.db, draft.id, ["pending"], "creating"))) return "Вже обробляється";

  try {
    const gmail = new Gmail(env, user.id);
    let result: string;
    if (action.action === "send") {
      await gmail.send({ to: action.to.map((t) => t.email!), subject: action.subject ?? "", body: action.body ?? "" });
      for (const t of action.to) if (t.name && t.email) await saveContact(env.db, t.name, t.email);
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
      await transition(env.db, draft.id, ["creating"], "pending");
      return "Немає що підтвердити";
    }
    await transition(env.db, draft.id, ["creating"], "created");
    if (messageId) await tg.edit(user.tg_id, messageId, result);
    else await tg.send(user.tg_id, result);
    return "Готово";
  } catch (err) {
    await transition(env.db, draft.id, ["creating"], "pending");
    if (err instanceof GoogleAuthRevokedError) {
      await forgetGoogleAuth(env, user.id);
      await tg.send(user.tg_id, "⚠️ Доступ до Google втрачено. Підключіть його знову і спробуйте ще раз.", {
        keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env, user.id) }]],
      });
      return undefined;
    }
    throw err;
  }
}

/** "g:<gmailId>:<r|u|a>" — quick, reversible buttons under an email: read in full, mark read, archive. */
export async function handleMailQuickAction(env: Env, user: User, gmailId: string, op: string): Promise<string | undefined> {
  const gmail = new Gmail(env, user.id);
  const tg = new Telegram(env);
  if (op === "r") {
    const m = await gmail.get(gmailId);
    const body = m.bodyText.length > MAX_BODY ? `${m.bodyText.slice(0, MAX_BODY)}…` : m.bodyText;
    const msg = await tg.send(
      user.tg_id,
      [`📧 <b>${esc(m.from)}</b>`, `<b>${esc(m.subject || "(без теми)")}</b>`, esc(m.date), "", esc(body || m.snippet)].join("\n"),
    );
    await linkMessage(env.db, msg.message_id, "mail", m.id);
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
