import { bitrixConfigured, type Env } from "../env";
import { Telegram } from "../telegram/api";

/**
 * The owner's command menu (the «≡» button by the input field): the core commands plus one per connected service.
 * Refreshed on /start, /settings and whenever a service is connected or disconnected.
 */
export function ownerCommands(env: Env): { command: string; description: string }[] {
  return [
    { command: "start", description: "Почати / підключити Google" },
    ...(bitrixConfigured(env) ? [{ command: "bitrix", description: "📋 Задачі Bitrix24" }] : []),
    { command: "settings", description: "⚙️ Налаштування й підключення" },
    { command: "reset", description: "Почати розмову заново" },
    { command: "help", description: "Що вміє бот" },
  ];
}

export async function refreshCommands(env: Env): Promise<void> {
  await new Telegram(env)
    .call("setMyCommands", { commands: ownerCommands(env), scope: { type: "chat", chat_id: env.OWNER_TELEGRAM_ID } })
    .catch(() => undefined);
}
