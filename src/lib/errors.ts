import { exec } from "../db/client";
import type { Env } from "../env";
import { esc, Telegram } from "../telegram/api";

/**
 * Records a failure in the `errors` table and notifies the owner in Telegram
 * (spec section 6, "Надійність"). Never throws.
 */
export async function logError(
  env: Env,
  scope: string,
  err: unknown,
  ctx: { userId?: number | null; payload?: unknown } = {},
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${scope}]`, message, err instanceof Error ? err.stack : "");
  try {
    const payload = ctx.payload === undefined ? null : JSON.stringify(ctx.payload).slice(0, 10_000);
    await exec(env.db, "INSERT INTO errors (ts, scope, user_id, message, payload) VALUES ($1, $2, $3, $4, $5)", [
      Date.now(),
      scope,
      ctx.userId ?? null,
      message.slice(0, 2000),
      payload,
    ]);
  } catch (dbErr) {
    console.error("errors table write failed", dbErr);
  }
  const tg = new Telegram(env);
  const text = `⚠️ <b>Помилка</b> <code>${esc(scope)}</code>\n<pre>${esc(message.slice(0, 1500))}</pre>`;
  await tg.send(env.OWNER_TELEGRAM_ID, text).catch(() => undefined);
}
