import { Bitrix, resetBitrixCache } from "../bitrix/client";
import { bitrixUrl, ConfigError, type Env } from "../env";
import { loadIntegrations, saveIntegrations } from "../google/oauth";
import { applyIntegrations } from "../integrations";
import { refreshCommands } from "./commands";
import { expectAnswer, takeAnswer } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData, readHidden } from "../telegram/hidden";
import type { TgMessage } from "../telegram/types";
import { getAccessToken } from "../zoom/client";

/**
 * Connecting Bitrix24 and Zoom from /settings, without deployment variables: the bot asks for the key, checks it
 * against the service, keeps it encrypted in the pinned message and deletes the owner's message with the key.
 */

export type Integration = "bitrix" | "zoom";
interface Ask {
  k: "ask";
  w: Integration;
}

export const INTEGRATION_NAMES: Record<Integration, string> = { bitrix: "Bitrix24", zoom: "Zoom" };

const PROMPTS: Record<Integration, string> = {
  bitrix:
    "📋 <b>Підключення Bitrix24</b>\n\n" +
    "1. У Bitrix24 відкрийте <b>Розробникам → Інше → Вхідний вебхук</b>.\n" +
    "2. Права доступу: <b>Задачі</b>, <b>Користувачі</b> і <b>Чат і повідомлення</b> (щоб читати «Чат завдання») → <b>Зберегти</b>.\n" +
    "3. Скопіюйте «Вебхук для виклику REST API» — вигляду <code>https://ваш-портал.bitrix24.ua/rest/1/abc123…/</code>\n\n" +
    "Надішліть його у відповідь на це повідомлення. Я перевірю його й одразу видалю з чату.",
  zoom:
    "🎥 <b>Підключення Zoom</b>\n\n" +
    '1. <a href="https://marketplace.zoom.us/develop/create">Zoom Marketplace</a> → <b>Develop → Build App → Server-to-Server OAuth</b>.\n' +
    "2. Scopes: <b>meeting:write:admin</b> (створення зустрічей) → <b>Activate</b>.\n" +
    "3. На вкладці App Credentials скопіюйте <b>Account ID</b>, <b>Client ID</b> і <b>Client Secret</b>.\n\n" +
    "Надішліть їх у відповідь на це повідомлення — трьома рядками в цьому порядку. Я перевірю їх і одразу видалю з чату.",
};

export async function startConnect(env: Env, chatId: number, what: Integration): Promise<void> {
  const ask: Ask = { k: "ask", w: what };
  expectAnswer(chatId, ask);
  await new Telegram(env).send(chatId, hiddenData(ask) + PROMPTS[what]);
}

export async function disconnect(env: Env, what: Integration): Promise<void> {
  const current = await loadIntegrations(env);
  delete current[what];
  await saveIntegrations(env, current);
  await applyIntegrations(env);
  if (what === "bitrix") resetBitrixCache();
}

const looksLike: Record<Integration, (text: string) => boolean> = {
  bitrix: (t) => /\/rest\/\d+\/[^/\s]+/.test(t),
  zoom: (t) => zoomKeys(t) !== null,
};

/** Three values in order, one per line (labels like "Account ID:" are fine). */
function zoomKeys(text: string): { accountId: string; clientId: string; clientSecret: string } | null {
  const values = text
    .split(/[\n,;]+/)
    .map((l) => l.replace(/^[^:]*:\s*/, (m) => (/[a-z ]id|secret/i.test(m) ? "" : m)).trim())
    .filter((v) => /^[\w.-]{6,}$/.test(v));
  return values.length >= 3 ? { accountId: values[0]!, clientId: values[1]!, clientSecret: values[2]! } : null;
}

/** A reply with a key the bot asked for. Returns false when the message is something else. */
export async function handleConnectAnswer(env: Env, msg: TgMessage, text: string): Promise<boolean> {
  const replied = readHidden<Ask>(msg.reply_to_message);
  let ask = replied?.k === "ask" ? replied : null;
  if (!ask) {
    const pending = takeAnswer<Ask>(msg.chat.id);
    if (pending?.k === "ask" && looksLike[pending.w](text)) ask = pending;
    else if (pending) expectAnswer(msg.chat.id, pending);
  }
  if (!ask) return false;

  const tg = new Telegram(env);
  // The key has no business staying in the chat.
  await tg.call("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => undefined);
  await tg.typing(msg.chat.id);
  const retry = { keyboard: [[{ text: "🔁 Спробувати ще раз", callback_data: `set:on:${ask.w}` }]] };
  const current = await loadIntegrations(env);

  if (ask.w === "bitrix") {
    let url: string;
    try {
      url = bitrixUrl(text.trim().split(/\s+/).find((w) => w.startsWith("https://")) ?? text.trim());
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      await tg.send(msg.chat.id, "Це не схоже на адресу вебхука Bitrix24 (<code>https://…/rest/1/…/</code>).", retry);
      return true;
    }
    let who: string;
    try {
      const me = await new Bitrix({ BITRIX_WEBHOOK_URL: url }).me();
      who = [me.name, me.lastName].filter(Boolean).join(" ");
    } catch {
      await tg.send(msg.chat.id, "😔 Bitrix24 не прийняв цей вебхук. Перевірте адресу й права «Задачі», «Користувачі» та «Чат і повідомлення».", retry);
      return true;
    }
    await saveIntegrations(env, { ...current, bitrix: url });
    resetBitrixCache();
    await applyIntegrations(env);
    await refreshCommands(env);
    await tg.send(msg.chat.id, `✅ <b>Bitrix24 підключено</b>${who ? ` — ${esc(who)}` : ""}.\n\nСпробуйте /bitrix або напишіть «мої задачі».`);
    return true;
  }

  const keys = zoomKeys(text);
  if (!keys) {
    await tg.send(msg.chat.id, "Потрібні три значення: Account ID, Client ID і Client Secret — кожне з нового рядка.", retry);
    return true;
  }
  try {
    await getAccessToken({ ZOOM_ACCOUNT_ID: keys.accountId, ZOOM_CLIENT_ID: keys.clientId, ZOOM_CLIENT_SECRET: keys.clientSecret });
  } catch {
    await tg.send(msg.chat.id, "😔 Zoom не прийняв ці ключі. Перевірте, що застосунок типу Server-to-Server OAuth активовано.", retry);
    return true;
  }
  await saveIntegrations(env, { ...current, zoom: keys });
  await applyIntegrations(env);
  await tg.send(msg.chat.id, "✅ <b>Zoom підключено.</b>\n\nПишіть «зустріч … у Zoom» — посилання буде в запрошенні.");
  return true;
}
