import { deflateRawSync, inflateRawSync } from "node:zlib";
import { fromBase64Url, toBase64Url } from "../lib/crypto";
import type { TgMessage } from "./types";

/**
 * The bot keeps no database: whatever a later button press or reply needs (a meeting card, the event a notice is
 * about, the email a card shows) travels inside the bot's own message as an invisible link. Telegram returns the
 * message with every button press (`callback_query.message`) and with every reply (`reply_to_message`), so the
 * data comes back exactly when it is needed and disappears together with the message.
 */
const PREFIX = "https://t.me/?ais=";

/** Kept well below what Telegram accepts in a link, so a message never fails to send because of its data. */
export const MAX_HIDDEN = 2000;

function pack(data: unknown): string {
  return toBase64Url(deflateRawSync(Buffer.from(JSON.stringify(data), "utf8")));
}

/** Size of the link `hiddenData` would produce; callers trim long text (e.g. a forwarded chat) to fit MAX_HIDDEN. */
export function hiddenSize(data: unknown): number {
  return PREFIX.length + pack(data).length;
}

/** Invisible HTML carrying `data` (a zero-width space linked to it); put it at the start of a message. */
export function hiddenData(data: unknown): string {
  return `<a href="${PREFIX}${pack(data)}">​</a>`;
}

/** The data hidden in a message by `hiddenData`, or null. */
export function readHidden<T>(msg: TgMessage | undefined | null): T | null {
  const entities = [...(msg?.entities ?? []), ...(msg?.caption_entities ?? [])];
  const link = entities.find((e) => e.type === "text_link" && e.url?.startsWith(PREFIX));
  if (!link?.url) return null;
  try {
    return JSON.parse(inflateRawSync(fromBase64Url(link.url.slice(PREFIX.length))).toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Test helper: the entity Telegram would attach to a message sent with `hiddenData(data)`. */
export function hiddenEntity(html: string): { type: "text_link"; offset: number; length: number; url: string } | null {
  const m = /<a href="(https:\/\/t\.me\/\?ais=[^"]+)">/.exec(html);
  return m ? { type: "text_link", offset: 0, length: 1, url: m[1]! } : null;
}
