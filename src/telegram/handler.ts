import { handleActionCallback } from "../bot/actions";
import { handleMailCallback, handleMailQuickAction, startMailDraft } from "../bot/mail";
import { handleBatchInput, handleCardCallback, handleOwnerText, FORWARD_DEBOUNCE_S, PHOTO_DEBOUNCE_S, photoLine } from "../bot/meetings";
import {
  handleDialogCallback,
  handleDialogMessage,
  helpText,
  showSettings,
  startOnboarding,
} from "../bot/onboarding";
import { all } from "../db/client";
import { cancelInputDrafts } from "../db/drafts";
import { deleteContact, ensureUser, listContacts, saveContact, updateUser, type User } from "../db/users";
import { isOwner, type Env } from "../env";
import { hasGoogleAuth } from "../google/oauth";
import { formatTime, toKyivDate } from "../lib/time";
import { esc, Telegram, TG_DOWNLOAD_LIMIT } from "./api";
import type { TgCallbackQuery, TgMessage, TgMessageOrigin, TgUpdate, TgUser } from "./types";

/**
 * The bot serves exactly one person: OWNER_TELEGRAM_ID. Messages and button presses from anyone else are
 * ignored without a reply, so strangers learn nothing about the bot.
 */
async function authorize(env: Env, from: TgUser): Promise<User | null> {
  if (from.is_bot || !isOwner(env, from.id)) return null;
  return ensureUser(env.db, from.id, from.username ?? null);
}

export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg?.from || msg.chat.type !== "private") return;

  const user = await authorize(env, msg.from);
  if (!user) {
    console.warn(`Ignored message from non-owner ${msg.from.id}`);
    return;
  }

  const text = msg.text?.trim() ?? "";
  if (text.startsWith("/")) return handleCommand(env, user, msg, text);
  if (await handleDialogMessage(env, user, msg)) return;
  if (!user.full_name) {
    await startOnboarding(env, user);
    return;
  }
  await handleOwnerMessage(env, user, msg);
}

function originName(origin: TgMessageOrigin, owner: User): string {
  switch (origin.type) {
    case "user": {
      if (origin.sender_user.id === owner.tg_id) return `${owner.full_name ?? "Я"} (власник)`;
      return [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(" ");
    }
    case "hidden_user":
      return origin.sender_user_name;
    case "chat":
      return origin.sender_chat.title ?? "чат";
    case "channel":
      return origin.chat.title ?? "канал";
  }
}

/** "[28.09.2026 14:02] Іван Петренко: текст" — one line of a forwarded conversation for the LLM. */
export function forwardedLine(msg: TgMessage, owner: User): string {
  const origin = msg.forward_origin!;
  const at = new Date(origin.date * 1000);
  const [y, m, d] = toKyivDate(at).split("-");
  const body = (msg.text ?? msg.caption ?? "").replace(/\n/g, " ").trim();
  return `[${d}.${m}.${y} ${formatTime(at)}] ${originName(origin, owner)}: ${body || "(вкладення)"}`;
}

async function handleOwnerMessage(env: Env, user: User, msg: TgMessage): Promise<void> {
  const tg = new Telegram(env);
  const photo = msg.photo?.at(-1) ?? (msg.document?.mime_type?.startsWith("image/") ? msg.document : undefined);

  if (msg.forward_origin) {
    const lines = [forwardedLine(msg, user)];
    if (photo) lines.push(photoLine(photo.file_id));
    await handleBatchInput(env, user, msg.chat.id, lines.join("\n"), "forward", FORWARD_DEBOUNCE_S);
    return;
  }

  if (photo) {
    if ((photo.file_size ?? 0) > TG_DOWNLOAD_LIMIT) {
      await tg.send(msg.chat.id, "Зображення завелике (понад 20 МБ).");
      return;
    }
    const lines = [photoLine(photo.file_id)];
    if (msg.caption) lines.unshift(`Підпис: ${msg.caption}`);
    await handleBatchInput(env, user, msg.chat.id, lines.join("\n"), "screenshot", PHOTO_DEBOUNCE_S);
    return;
  }

  if (msg.voice) {
    if ((msg.voice.file_size ?? 0) > TG_DOWNLOAD_LIMIT) {
      await tg.send(msg.chat.id, "Голосове завелике (понад 20 МБ).");
      return;
    }
    await tg.typing(msg.chat.id);
    await env.jobs.send({
      type: "voice",
      userId: user.id,
      chatId: msg.chat.id,
      fileId: msg.voice.file_id,
      messageId: msg.message_id,
      replyTo: msg.reply_to_message?.message_id ?? null,
    });
    return;
  }

  if (msg.audio || msg.document) {
    await tg.send(msg.chat.id, "Обробка записів зустрічей зʼявиться на етапі «Протокол». Поки що я приймаю текст, голосові, переслану переписку та скріншоти.");
    return;
  }

  const text = msg.text?.trim();
  if (text) await handleOwnerText(env, user, msg.chat.id, text, "text", msg.reply_to_message?.message_id ?? null);
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

async function handleCommand(env: Env, user: User, msg: TgMessage, text: string): Promise<void> {
  const tg = new Telegram(env);
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd!.split("@")[0]!.toLowerCase();

  // Any command interrupts a dialog step.
  if (user.dialog_state && cmd !== "/start") {
    await updateUser(env.db, user.id, { dialog_state: null });
    user.dialog_state = null;
  }

  switch (cmd) {
    case "/start":
      await startOnboarding(env, user);
      return;
    case "/settings":
      await showSettings(env, user);
      return;
    case "/cancel":
      await cancelInputDrafts(env.db, user.id);
      await tg.send(user.tg_id, "Гаразд, скасовано.", { removeKeyboard: true });
      return;
    case "/new":
      if (!user.full_name || !(await hasGoogleAuth(env, user.id))) {
        await startOnboarding(env, user);
        return;
      }
      await tg.send(user.tg_id, "Опишіть зустріч текстом або голосом, перешліть переписку чи надішліть скріншот — я підготую картку.");
      return;
    case "/mail": {
      const request = args.join(" ").trim();
      if (!request) {
        await tg.send(
          user.tg_id,
          "Що зробити з поштою? Напишіть, напр.: <code>/mail перевір нові листи</code> або <code>/mail напиши Івану, що зустріч переносимо</code>.",
        );
        return;
      }
      await startMailDraft(env, user, msg.chat.id, request);
      return;
    }
    case "/contacts": {
      const contacts = await listContacts(env.db, 100);
      await tg.send(
        user.tg_id,
        contacts.length
          ? `📇 <b>Адресна книга</b>\n${contacts.map((c) => `• ${esc(c.name)} — ${esc(c.email)}`).join("\n")}`
          : "Адресна книга порожня. Вона поповнюється учасниками створених зустрічей або командою\n<code>/contact Імʼя Прізвище email</code>",
      );
      return;
    }
    case "/contact": {
      const email = args.at(-1) ?? "";
      const name = args.slice(0, -1).join(" ").trim();
      if (!EMAIL_RE.test(email) || !name) {
        await tg.send(user.tg_id, "Формат: <code>/contact Імʼя Прізвище email</code>\nВидалити: <code>/contact_del email</code>");
        return;
      }
      await saveContact(env.db, name, email);
      await tg.send(user.tg_id, `✅ Збережено: ${esc(name)} — ${esc(email.toLowerCase())}`);
      return;
    }
    case "/contact_del": {
      const ok = !!args[0] && (await deleteContact(env.db, args[0]));
      await tg.send(user.tg_id, ok ? "🗑 Видалено." : "Такого email в адресній книзі немає.");
      return;
    }
    case "/errors": {
      const rows = await all<{ ts: number; scope: string; message: string }>(
        env.db,
        "SELECT ts, scope, message FROM errors ORDER BY ts DESC LIMIT 10",
      );
      const lines = rows.map(
        (e) => `<code>${toKyivDate(new Date(e.ts))} ${formatTime(new Date(e.ts))}</code> ${esc(e.scope)}: ${esc(e.message.slice(0, 200))}`,
      );
      await tg.send(user.tg_id, lines.length ? lines.join("\n\n") : "Помилок немає 🎉");
      return;
    }
  }
  await tg.send(user.tg_id, helpText());
}

async function handleCallback(env: Env, cq: TgCallbackQuery): Promise<void> {
  const tg = new Telegram(env);
  const user = await authorize(env, cq.from);
  if (!user) return;
  const [kind, a = "", b = ""] = (cq.data ?? "").split(":");
  let toast: string | undefined;
  try {
    if (kind === "d") toast = await handleCardCallback(env, user, a, b);
    else if (kind === "a") toast = await handleActionCallback(env, user, a, b);
    else if (kind === "m") toast = await handleMailCallback(env, user, a, b);
    else if (kind === "g") toast = await handleMailQuickAction(env, user, a, b);
    else if (kind === "o") toast = await handleDialogCallback(env, user, a, b);
  } finally {
    await tg.answerCallback(cq.id, toast).catch(() => undefined);
  }
}
