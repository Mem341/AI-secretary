import { handleBatchInput, handleCardCallback, handleOwnerText, FORWARD_DEBOUNCE_S, PHOTO_DEBOUNCE_S, photoLine } from "../bot/meetings";
import {
  handleDialogCallback,
  handleDialogMessage,
  helpText,
  showSettings,
  startOnboarding,
} from "../bot/onboarding";
import { cancelInputDrafts } from "../db/drafts";
import { allowUser, deactivateUser, getUserByTgId, listUsers, type Role, updateUser, type User } from "../db/users";
import { isAdmin, type Env } from "../env";
import { hasGoogleAuth } from "../google/oauth";
import { formatTime, toKyivDate } from "../lib/time";
import { esc, Telegram, TG_DOWNLOAD_LIMIT } from "./api";
import type { TgCallbackQuery, TgMessage, TgMessageOrigin, TgUpdate, TgUser } from "./types";

/**
 * Resolves the sender against the whitelist (spec section 2). Administrators from ADMIN_TG_IDS are
 * whitelisted automatically as owners.
 */
async function authorize(env: Env, from: TgUser): Promise<User | null> {
  let user = await getUserByTgId(env.DB, from.id);
  if (!user && isAdmin(env, from.id)) {
    await allowUser(env.DB, from.id, "owner");
    user = await getUserByTgId(env.DB, from.id);
  }
  if (!user?.active) return null;
  const username = from.username ?? null;
  if (username !== user.tg_username) {
    await updateUser(env.DB, user.id, { tg_username: username });
    user.tg_username = username;
  }
  return user;
}

export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg?.from || msg.chat.type !== "private" || msg.from.is_bot) return;

  const user = await authorize(env, msg.from);
  if (!user) {
    await new Telegram(env).send(
      msg.chat.id,
      `⛔ Доступ обмежено. Зверніться до адміністратора пілоту.\nВаш Telegram ID: <code>${msg.from.id}</code>`,
    );
    return;
  }

  const text = msg.text?.trim() ?? "";
  if (text.startsWith("/")) return handleCommand(env, user, msg, text);
  if (await handleDialogMessage(env, user, msg)) return;

  const tg = new Telegram(env);
  if (user.role !== "owner") {
    await tg.send(user.tg_id, helpText(user));
    return;
  }
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
    await env.JOBS.send({
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

async function handleCommand(env: Env, user: User, msg: TgMessage, text: string): Promise<void> {
  const tg = new Telegram(env);
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd!.split("@")[0]!.toLowerCase();

  // Any command interrupts a dialog step.
  if (user.dialog_state && cmd !== "/start") {
    await updateUser(env.DB, user.id, { dialog_state: null });
    user.dialog_state = null;
  }

  switch (cmd) {
    case "/start":
      await startOnboarding(env, user);
      return;
    case "/help":
      await tg.send(user.tg_id, helpText(user));
      return;
    case "/settings":
      await showSettings(env, user);
      return;
    case "/cancel":
      await cancelInputDrafts(env.DB, user.id);
      await tg.send(user.tg_id, "Гаразд, скасовано.", { removeKeyboard: true });
      return;
    case "/new":
      if (user.role !== "owner") break;
      if (!(await hasGoogleAuth(env, user.id))) {
        await startOnboarding(env, user);
        return;
      }
      await tg.send(
        user.tg_id,
        "Опишіть зустріч текстом або голосом, перешліть переписку чи надішліть скріншот — я підготую картку.",
      );
      return;
  }

  if (isAdmin(env, user.tg_id) && (await handleAdminCommand(env, user, cmd, args))) return;
  await tg.send(user.tg_id, helpText(user));
}

/** /allow <tg_id> [owner|member], /deny <tg_id>, /users, /errors — whitelist and diagnostics (spec section 2). */
async function handleAdminCommand(env: Env, admin: User, cmd: string, args: string[]): Promise<boolean> {
  const tg = new Telegram(env);
  switch (cmd) {
    case "/allow": {
      const tgId = Number(args[0]);
      const role = (args[1] ?? "owner") as Role;
      if (!Number.isSafeInteger(tgId) || tgId <= 0 || !["owner", "member"].includes(role)) {
        await tg.send(admin.tg_id, "Формат: <code>/allow &lt;telegram_id&gt; [owner|member]</code>");
        return true;
      }
      await allowUser(env.DB, tgId, role);
      await tg.send(admin.tg_id, `✅ ${tgId} додано як ${role === "owner" ? "власника (керівника)" : "учасника"}. Нехай натисне /start.`);
      return true;
    }
    case "/deny": {
      const tgId = Number(args[0]);
      const ok = Number.isSafeInteger(tgId) && (await deactivateUser(env.DB, tgId));
      await tg.send(admin.tg_id, ok ? `⛔ ${tgId} вимкнено.` : "Користувача не знайдено.");
      return true;
    }
    case "/users": {
      const users = await listUsers(env.DB);
      const connected = new Set(
        (await env.DB.prepare("SELECT user_id FROM google_auth").all<{ user_id: number }>()).results.map((r) => r.user_id),
      );
      const lines = users.map(
        (u) =>
          `${u.active ? "🟢" : "⚪️"} <code>${u.tg_id}</code> ${esc(u.full_name ?? "—")} · ${u.role}` +
          `${u.email ? ` · ${esc(u.email)}` : ""}${u.role === "owner" ? (connected.has(u.id) ? " · 📅" : " · без календаря") : ""}`,
      );
      await tg.send(admin.tg_id, lines.length ? lines.join("\n") : "Користувачів немає.");
      return true;
    }
    case "/errors": {
      const { results } = await env.DB.prepare("SELECT ts, scope, user_id, message FROM errors ORDER BY ts DESC LIMIT 10")
        .all<{ ts: number; scope: string; user_id: number | null; message: string }>();
      const lines = results.map(
        (e) => `<code>${toKyivDate(new Date(e.ts))} ${formatTime(new Date(e.ts))}</code> ${esc(e.scope)}: ${esc(e.message.slice(0, 200))}`,
      );
      await tg.send(admin.tg_id, lines.length ? lines.join("\n\n") : "Помилок немає 🎉");
      return true;
    }
  }
  return false;
}

async function handleCallback(env: Env, cq: TgCallbackQuery): Promise<void> {
  const tg = new Telegram(env);
  const user = await authorize(env, cq.from);
  if (!user) {
    await tg.answerCallback(cq.id, "Доступ обмежено");
    return;
  }
  const [kind, a = "", b = ""] = (cq.data ?? "").split(":");
  let toast: string | undefined;
  try {
    if (kind === "d" && user.role === "owner") toast = await handleCardCallback(env, user, a, b);
    else if (kind === "o") toast = await handleDialogCallback(env, user, a, b);
  } finally {
    await tg.answerCallback(cq.id, toast).catch(() => undefined);
  }
}
