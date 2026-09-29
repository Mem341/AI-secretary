import { handleActionCallback } from "../bot/actions";
import { loadDirectory } from "../bot/contacts";
import { handleMailCallback, handleMailQuickAction, startMailDraft } from "../bot/mail";
import { handleBatchInput, handleCardCallback, handleOwnerText, FORWARD_DEBOUNCE_S, PHOTO_DEBOUNCE_S, photoLine } from "../bot/meetings";
import { helpText, sendConnectGoogle, showSettings, startOnboarding } from "../bot/onboarding";
import { loadOwner, type User } from "../bot/owner";
import { isOwner, type Env } from "../env";
import { connectWithCode } from "../google/connect";
import { connectLink, hasGoogleAuth, parseGoogleAnswer, verifyState } from "../google/oauth";
import { formatTime, toKyivDate } from "../lib/time";
import { clearAnswer } from "../session";
import { esc, Telegram, TG_DOWNLOAD_LIMIT } from "./api";
import type { TgCallbackQuery, TgMessage, TgMessageOrigin, TgUpdate, TgUser } from "./types";

/**
 * The bot serves exactly one person: OWNER_TELEGRAM_ID. Messages and button presses from anyone else are
 * ignored without a reply, so strangers learn nothing about the bot.
 */
async function authorize(env: Env, from: TgUser): Promise<User | null> {
  if (from.is_bot || !isOwner(env, from.id)) return null;
  return loadOwner(env, from);
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
      chatId: msg.chat.id,
      fileId: msg.voice.file_id,
      messageId: msg.message_id,
      replyTo: msg.reply_to_message ?? null,
    });
    return;
  }

  if (msg.audio || msg.document) {
    await tg.send(msg.chat.id, "Обробка записів зустрічей зʼявиться на етапі «Протокол». Поки що я приймаю текст, голосові, переслану переписку та скріншоти.");
    return;
  }

  const text = msg.text?.trim();
  if (text && (await handleGoogleAnswer(env, msg, text))) return;
  if (text) await handleOwnerText(env, user, msg.chat.id, text, "text", msg.reply_to_message ?? null);
}

async function handleCommand(env: Env, user: User, msg: TgMessage, text: string): Promise<void> {
  const tg = new Telegram(env);
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd!.split("@")[0]!.toLowerCase();
  // Any command ends whatever the bot was waiting an answer to.
  clearAnswer(msg.chat.id);

  switch (cmd) {
    case "/start":
      await startOnboarding(env, user);
      return;
    case "/settings":
      await showSettings(env, user);
      return;
    case "/cancel":
      await tg.send(user.tg_id, "Гаразд, скасовано.", { removeKeyboard: true });
      return;
    case "/new":
      if (!(await hasGoogleAuth(env))) {
        await sendConnectGoogle(env);
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
      await startMailDraft(env, msg.chat.id, request);
      return;
    }
    case "/contacts": {
      const contacts = (await loadDirectory(env)).slice(0, 100);
      await tg.send(
        user.tg_id,
        contacts.length
          ? `📇 <b>Кого я знаю з вашого календаря</b>\n${contacts.map((c) => `• ${esc(c.name)} — ${esc(c.email)}`).join("\n")}`
          : "Поки нікого: я беру імена й email учасників ваших подій у Google Calendar. Email нової людини просто напишіть у запиті.",
      );
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
    if (kind === "d") toast = await handleCardCallback(env, user, cq.message, a);
    else if (kind === "a") toast = await handleActionCallback(env, cq.message, a);
    else if (kind === "m") toast = await handleMailCallback(env, cq.message, a);
    else if (kind === "g") toast = await handleMailQuickAction(env, a, b);
  } finally {
    await tg.answerCallback(cq.id, toast).catch(() => undefined);
  }
}

/**
 * Desktop app Google client: after consent the owner pastes the browser's address (http://127.0.0.1/?code=…) or
 * the bare code. Returns false when the text is something else.
 */
async function handleGoogleAnswer(env: Env, msg: TgMessage, text: string): Promise<boolean> {
  const answer = parseGoogleAnswer(text);
  if (!answer) return false;
  const tg = new Telegram(env);
  const retry = { keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]] };
  // The code is single-use, but it has no business staying in the chat.
  await tg.call("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => undefined);
  if (answer.error || !answer.code) {
    await tg.send(msg.chat.id, "Підключення Google скасовано. Спробувати ще раз:", retry);
    return true;
  }
  if (answer.state && !(await verifyState(env, answer.state))) {
    await tg.send(msg.chat.id, "Це посилання вже застаріло. Натисніть кнопку й підключіть Google ще раз:", retry);
    return true;
  }
  await tg.typing(msg.chat.id);
  try {
    await connectWithCode(env, answer.code);
  } catch {
    await tg.send(msg.chat.id, "😔 Google не прийняв цей код (він діє кілька хвилин і лише один раз). Спробуйте ще раз:", retry);
  }
  return true;
}
