import type { Env } from "../env";
import { Telegram } from "../telegram/api";
import { completeAuth, connectLink, forgetGoogleAuth, missingScopes } from "./oauth";

export type ConnectResult = "connected" | "no_calendar";

/**
 * Finishes connecting Google with an authorization code — from the Web callback or from the address the owner
 * pasted into the chat (Desktop app client). The greeting comes from the "connected" job.
 */
export async function connectWithCode(env: Env, code: string): Promise<ConnectResult> {
  const { scope } = await completeAuth(env, code);
  if (!scope.includes("calendar.events")) {
    await forgetGoogleAuth(env);
    await new Telegram(env).send(env.OWNER_TELEGRAM_ID, "Потрібен доступ до подій календаря — поставте галочку на екрані Google.", {
      keyboard: [[{ text: "🔗 Спробувати ще раз", url: await connectLink(env) }]],
    });
    return "no_calendar";
  }
  const missing = missingScopes(scope);
  if (missing.length) {
    // Google shows each permission as its own checkbox, unticked: say which ones were left out.
    await new Telegram(env).send(
      env.OWNER_TELEGRAM_ID,
      `⚠️ Google підключено, але без цих галочок:\n${missing.map((m) => `• ${m}`).join("\n")}\n\nБез них не працюють нагадування в Telegram. Натисніть кнопку й на екрані Google поставте <b>«Вибрати все» (Select all)</b>.`,
      { keyboard: [[{ text: "🔄 Підключити з усіма галочками", url: await connectLink(env) }]] },
    );
  }
  await env.jobs.send({ type: "connected", gmail: scope.includes("gmail.modify") });
  return "connected";
}

let usernameCache: string | null = null;

/** The bot's @username (for "back to Telegram" links); null when Telegram is unreachable. */
export async function botUsername(env: Env): Promise<string | null> {
  usernameCache ??= await new Telegram(env)
    .call<{ username: string }>("getMe", {})
    .then((me) => me.username)
    .catch(() => null);
  return usernameCache;
}
