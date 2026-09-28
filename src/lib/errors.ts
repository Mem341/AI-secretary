import type { Env } from "../env";
import { esc, Telegram } from "../telegram/api";

/**
 * Logs a failure (function logs) and tells the owner in Telegram (spec section 6, "Надійність"). There is no error
 * table: the chat with the bot is the log. Never throws.
 */
export async function logError(env: Env, scope: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${scope}]`, message, err instanceof Error ? err.stack : "");
  const text = `⚠️ <b>Помилка</b> <code>${esc(scope)}</code>\n<pre>${esc(message.slice(0, 1500))}</pre>`;
  await new Telegram(env).send(env.OWNER_TELEGRAM_ID, text).catch(() => undefined);
}
