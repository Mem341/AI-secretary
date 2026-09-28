import type { Config } from "../env";
import { expectOk, fetchWithRetry, HttpError } from "../lib/http";
import type { InlineKeyboard, TgFile, TgMessage } from "./types";

/** Telegram Bot API allows bots to download files up to 20 MB. */
export const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export interface SendOptions {
  keyboard?: InlineKeyboard;
  replyTo?: number;
  /** Show a one-time reply keyboard (e.g. "share contact"). */
  replyKeyboard?: { text: string; request_contact?: boolean }[][];
  removeKeyboard?: boolean;
  /** Opens the reply field on the owner's side, so the answer comes back as a reply to this message. */
  forceReply?: string;
}

export class Telegram {
  constructor(private readonly env: Pick<Config, "TELEGRAM_BOT_TOKEN">) {}

  async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetchWithRetry(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok: boolean; result: T; description?: string } | null;
    if (!json?.ok) throw new HttpError(`telegram.${method}`, res.status, json?.description ?? "");
    return json.result;
  }

  private markup(opts: SendOptions): Record<string, unknown> | undefined {
    if (opts.forceReply !== undefined) return { force_reply: true, input_field_placeholder: opts.forceReply || undefined };
    if (opts.keyboard) return { inline_keyboard: opts.keyboard };
    if (opts.replyKeyboard) return { keyboard: opts.replyKeyboard, resize_keyboard: true, one_time_keyboard: true };
    if (opts.removeKeyboard) return { remove_keyboard: true };
    return undefined;
  }

  /** Sends an HTML-formatted message. Callers must escape user content with `esc`. */
  send(chatId: number, html: string, opts: SendOptions = {}): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: this.markup(opts),
      reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
    });
  }

  async edit(chatId: number, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      });
    } catch (err) {
      // Re-rendering an unchanged card is not an error.
      if (err instanceof HttpError && err.body.includes("message is not modified")) return;
      throw err;
    }
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  async typing(chatId: number): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  }

  /** Downloads a file (≤ 20 MB). */
  async download(fileId: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; path: string }> {
    const file = await this.call<TgFile>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    const res = await expectOk(
      "telegram.file",
      await fetchWithRetry(`https://api.telegram.org/file/bot${this.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, {}),
    );
    return { bytes: new Uint8Array(await res.arrayBuffer()), path: file.file_path };
  }
}

/** Escapes text for Telegram HTML parse mode. */
export function esc(text: string | null | undefined): string {
  return (text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
