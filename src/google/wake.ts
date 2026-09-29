import type { Env } from "../env";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { connectLink } from "./oauth";
import { type PushSetup, pubsubApiLink, setupGoogleWake } from "./pubsub";

export { setupGoogleWake };

/** What to tell the owner about Google as the bot's clock, and the one button that fixes it. */
export async function wakeAdvice(env: Env, result: PushSetup): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const retry = { text: "🔁 Перевірити ще раз", callback_data: "set:wake" };
  if (result.ok) {
    return {
      text: "✅ <b>Нагадування працюють.</b> Їх надсилає сам Google: я поставив на ваші зустрічі нагадування листом, у потрібну хвилину Google надсилає лист, а я одразу пересилаю його сюди й прибираю з пошти.",
      keyboard: [],
    };
  }
  switch (result.reason) {
    case "no_scope":
      return {
        text: "⚠️ Щоб нагадування працювали, перепідключіть Google й дозвольте всі доступи (пошта й сповіщення).",
        keyboard: [[{ text: "🔄 Перепідключити Google", url: await connectLink(env) }]],
      };
    case "api_disabled":
      return {
        text: "⚠️ Залишився один крок: увімкніть <b>Cloud Pub/Sub API</b> у вашому проєкті Google Cloud (кнопка нижче → Enable), потім натисніть «Перевірити ще раз».",
        keyboard: [[{ text: "🔗 Увімкнути Cloud Pub/Sub API", url: pubsubApiLink(env) }], [retry]],
      };
    case "no_project":
      return { text: "⚠️ Не бачу проєкту Google Cloud: завантажте JSON Google-клієнта заново й покладіть його в GOOGLE_CLIENT_JSON.", keyboard: [] };
    default:
      return { text: `⚠️ Не вдалося налаштувати нагадування: ${esc((result.detail ?? "").slice(0, 200))}`, keyboard: [[retry]] };
  }
}

export async function reportWake(env: Env, chatId: number): Promise<void> {
  const advice = await wakeAdvice(env, await setupGoogleWake(env));
  await new Telegram(env).send(chatId, advice.text, advice.keyboard.length ? { keyboard: advice.keyboard } : {});
}
