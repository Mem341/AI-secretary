import { adminIds, type Env } from "../env";
import { esc, Telegram } from "../telegram/api";

/**
 * Records a failure in the `errors` table and notifies administrators in Telegram
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
    await env.DB.prepare("INSERT INTO errors (ts, scope, user_id, message, payload) VALUES (?, ?, ?, ?, ?)")
      .bind(Date.now(), scope, ctx.userId ?? null, message.slice(0, 2000), payload)
      .run();
  } catch (dbErr) {
    console.error("errors table write failed", dbErr);
  }
  const tg = new Telegram(env);
  const text = `⚠️ <b>Помилка</b> <code>${esc(scope)}</code>${ctx.userId ? ` · user #${ctx.userId}` : ""}\n<pre>${esc(message.slice(0, 1500))}</pre>`;
  await Promise.all(adminIds(env).map((id) => tg.send(id, text).catch(() => undefined)));
}
