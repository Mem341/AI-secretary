import { type Env, gmailPushConfigured } from "../env";
import { gmailPushEndpoint } from "../google/gmailPush";
import { connectLink, hasGmailScope, hasGoogleAuth } from "../google/oauth";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { durationOf, type User } from "./owner";

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

/** /settings — what the bot uses; the values themselves are deployment variables. */
export async function showSettings(env: Env, user: User): Promise<void> {
  const connected = await hasGoogleAuth(env);
  const gmail = connected && (await hasGmailScope(env));
  const lines = [
    "⚙️ <b>Налаштування</b>",
    "",
    `Імʼя: ${esc(user.full_name ?? "—")}`,
    `Пошта (з Google): ${esc(user.email ?? "—")}`,
    `Тривалість за замовчуванням: ${durationOf(user)} хв`,
    "Формат за замовчуванням: Google Meet (Zoom — якщо попросите)",
    `Модель Supervisor: ${esc(env.LLM_MODEL)}`,
    `Модель агентів (календар, пошта): ${esc(env.AGENT_MODEL)}`,
    `Нагадування: щоранку список зустрічей; за ${env.REMINDER_MINUTES.join(" і ")} хв до зустрічі — якщо налаштовано cron-job.org (/api/cron/reminders)`,
    `Google Calendar: ${connected ? "✅ підключено" : "❌ не підключено"}`,
    `Gmail: ${!connected ? "—" : gmail ? "✅ підключено" : "⚠️ перепідключіть Google і дайте доступ до пошти"}`,
    "",
    "<i>Змінюються змінними розгортання (Vercel → Settings → Environment Variables): OWNER_NAME, " +
      "DEFAULT_DURATION_MIN, LLM_MODEL, AGENT_MODEL, REMINDER_MINUTES.</i>",
  ];
  if (gmailPushConfigured(env)) {
    lines.push("", `Адреса push-підписки Pub/Sub для сповіщень про нові листи (секретна, не публікуйте):\n<code>${esc(gmailPushEndpoint(env))}</code>`);
  }
  const keyboard: InlineKeyboard = [[{ text: connected ? "🔄 Перепідключити Google" : "🔗 Підключити Google", url: await connectLink(env) }]];
  await new Telegram(env).send(user.tg_id, lines.join("\n"), { keyboard });
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
    "/settings — налаштування · /reset — почати розмову заново · /help — ця довідка",
  ].join("\n");
}
