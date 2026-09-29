import { type Env, gmailPushConfigured } from "../env";
import { gmailPushEndpoint } from "../google/gmailPush";
import { connectLink, hasGmailScope, hasGoogleAuth } from "../google/oauth";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { durationOf, formatOf, type MeetingFormat, type User } from "./owner";

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
  await tg.send(user.tg_id, `${hello}\n\n${helpText()}`);
}

const FORMAT_LABELS: Record<MeetingFormat, string> = { offline: "офлайн", google_meet: "Google Meet", zoom: "Zoom" };

/** /settings — what the bot uses; the values themselves are deployment variables. */
export async function showSettings(env: Env, user: User): Promise<void> {
  const connected = await hasGoogleAuth(env);
  const gmail = connected && (await hasGmailScope(env));
  const lines = [
    "⚙️ <b>Налаштування</b>",
    "",
    `Імʼя: ${esc(user.full_name ?? "—")}`,
    `Посада: ${esc(user.position ?? "—")}`,
    `Телефон: ${esc(user.phone ?? "—")}`,
    `Пошта (з Google): ${esc(user.email ?? "—")}`,
    `Тривалість за замовчуванням: ${durationOf(user)} хв`,
    `Формат за замовчуванням: ${FORMAT_LABELS[formatOf(user)]}`,
    `Адреса за замовчуванням: ${esc(user.defaults.address ?? "—")}`,
    `Модель ШІ: ${esc(env.LLM_MODEL)} (роутер: ${esc(env.ROUTER_MODEL)})`,
    `Нагадування: щоранку список зустрічей; за ${env.REMINDER_MINUTES} хв — якщо налаштовано частий cron`,
    `Google Calendar: ${connected ? "✅ підключено" : "❌ не підключено"}`,
    `Gmail: ${!connected ? "—" : gmail ? "✅ підключено" : "⚠️ перепідключіть Google і дайте доступ до пошти"}`,
    "",
    "<i>Змінюються змінними розгортання (Vercel → Settings → Environment Variables): OWNER_NAME, OWNER_POSITION, " +
      "OWNER_PHONE, DEFAULT_DURATION_MIN, DEFAULT_FORMAT, DEFAULT_ADDRESS, LLM_MODEL, ROUTER_MODEL, REMINDER_MINUTES.</i>",
  ];
  if (gmailPushConfigured(env)) {
    lines.push("", `Адреса push-підписки Pub/Sub для сповіщень про нові листи (секретна, не публікуйте):\n<code>${esc(gmailPushEndpoint(env))}</code>`);
  }
  const keyboard: InlineKeyboard = [[{ text: connected ? "🔄 Перепідключити Google" : "🔗 Підключити Google", url: await connectLink(env) }]];
  await new Telegram(env).send(user.tg_id, lines.join("\n"), { keyboard });
}

export function helpText(): string {
  return [
    "<b>Що я вмію</b>",
    "",
    "💬 Пишіть як завгодно, без команд — я сам зрозумію, чого ви хочете.",
    "📝 Напишіть, надиктуйте голосом, перешліть переписку або скиньте скріншот — я підготую картку зустрічі.",
    "📅 Питайте про розклад: <i>«що в мене завтра?»</i>, <i>«чи я вільний у пʼятницю о 15?»</i>.",
    "⏰ Щоранку надсилаю зустрічі на сьогодні.",
    "Наприклад: <i>«зустріч з Іваном Петренком у четвер о 15:00 по бюджету Буковелю»</i>.",
    "✅ Після кнопки «Створити» подія зʼявиться в Google Calendar, а учасники отримають запрошення на пошту.",
    "🔄 Нові, перенесені й скасовані події (зокрема зроблені вручну) я бачу й одразу повідомляю.",
    "💬 Відповідайте на моє повідомлення про зустріч, щоб перенести чи скасувати її, дізнатись учасників або додати нотатку.",
    "📧 Пишіть щось на кшталт «перевір пошту» або «напиши Івану лист» — я також умію Gmail.",
    "📇 Email людей, з якими ви вже зустрічались, я знаходжу в календарі — достатньо імені.",
    "",
    "/new — нова зустріч",
    "/mail — дія з поштою",
    "/contacts — кого я знаю з календаря",
    "/settings — профіль і підключення Google",
    "/cancel — скасувати поточну дію",
    "/help — ця довідка",
  ].join("\n");
}
