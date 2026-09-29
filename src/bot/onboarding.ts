import type { Env } from "../env";
import { connectLink, hasGoogleAuth } from "../google/oauth";
import { esc, Telegram } from "../telegram/api";
import type { User } from "./owner";

export async function sendConnectGoogle(env: Env): Promise<void> {
  await new Telegram(env).send(
    env.OWNER_TELEGRAM_ID,
    "Підключіть <b>Google</b> — календар і пошту. Я створюватиму події від вашого імені, а Google сам повідомлятиме " +
      "мене про зміни в календарі.",
    { keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]] },
  );
}

/** /start — no questionnaire: the profile comes from Telegram and Google. */
export async function startOnboarding(env: Env, user: User): Promise<void> {
  const tg = new Telegram(env);
  const hello = user.full_name ? `👋 Вітаю, ${esc(user.full_name)}!` : "👋 Вітаю!";
  if (!(await hasGoogleAuth(env))) {
    await tg.send(
      user.tg_id,
      `${hello} Я ваш AI-секретар: створюю зустрічі з тексту, голосового, пересланої переписки чи скріншота, ` +
        "надсилаю інвайти, повідомляю про зміни в календарі й працюю з поштою.",
    );
    await sendConnectGoogle(env);
    return;
  }
  await tg.send(user.tg_id, `${hello}\n\n${helpText()}`, { removeKeyboard: true });
}

export function helpText(): string {
  return [
    "<b>Пишіть мені як людині</b> — текстом, голосом, скріншотом чи пересланою перепискою:",
    "",
    "📅 «Зустріч з Іваном завтра о 14 в Zoom» · «Що в мене сьогодні?» · «Перенеси стендап на 15:00»",
    "📧 «Перевір пошту» · «Листи від Марії за тиждень» · «Відповідай, що я погоджуюсь»",
    "💬 Відповідайте (reply) на моє повідомлення про зустріч чи лист: «скасуй», «хто буде?», «додай нотатку: …».",
    "🔔 Про нові запрошення й зміни в календарі та про нові листи повідомляю одразу; щоранку — зустрічі на сьогодні.",
    "",
    "/bitrix — задачі Bitrix24 · /settings — підключення й нагадування · /reset — почати розмову заново · /help — ця довідка",
  ].join("\n");
}
