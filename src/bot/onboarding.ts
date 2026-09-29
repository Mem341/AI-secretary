import { type Env, gmailPushConfigured } from "../env";
import { gmailPushEndpoint } from "../google/gmailPush";
import { connectLink, hasGmailScope, hasGoogleAuth } from "../google/oauth";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { durationOf, formatOf, type MeetingFormat, type User } from "./owner";

/** The menu under the input field. Each button is the same as its command. */
export const MENU: { text: string; command: string }[][] = [
  [
    { text: "📝 Поставити зустріч", command: "/new" },
    { text: "📋 Сьогодні", command: "/today" },
  ],
  [
    { text: "🗓 Завтра", command: "/tomorrow" },
    { text: "📆 Тиждень", command: "/week" },
    { text: "🕒 Вільні вікна", command: "/free" },
  ],
  [
    { text: "✉️ Пошта", command: "/mail" },
    { text: "⚙️ Налаштування", command: "/settings" },
  ],
];

export const MENU_ROWS = MENU.map((row) => row.map((b) => b.text));

/** The command behind a menu button's text, if it is one. */
export function menuCommand(text: string): string | null {
  for (const row of MENU) for (const b of row) if (b.text === text) return b.command;
  return null;
}

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
  await tg.send(user.tg_id, `${hello}\n\n${helpText()}`, { menu: MENU_ROWS });
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
    `Модель ШІ: ${esc(env.LLM_MODEL)}`,
    `Нагадування: щоранку список зустрічей; за ${env.REMINDER_MINUTES} хв — якщо налаштовано частий cron`,
    `Google Calendar: ${connected ? "✅ підключено" : "❌ не підключено"}`,
    `Gmail: ${!connected ? "—" : gmail ? "✅ підключено" : "⚠️ перепідключіть Google і дайте доступ до пошти"}`,
    "",
    "<i>Змінюються змінними розгортання (Vercel → Settings → Environment Variables): OWNER_NAME, OWNER_POSITION, " +
      "OWNER_PHONE, DEFAULT_DURATION_MIN, DEFAULT_FORMAT, DEFAULT_ADDRESS, LLM_MODEL, REMINDER_MINUTES.</i>",
  ];
  if (gmailPushConfigured(env)) {
    lines.push("", `Адреса push-підписки Pub/Sub для сповіщень про нові листи (секретна, не публікуйте):\n<code>${esc(gmailPushEndpoint(env))}</code>`);
  }
  const keyboard: InlineKeyboard = [[{ text: connected ? "🔄 Перепідключити Google" : "🔗 Підключити Google", url: await connectLink(env) }]];
  await new Telegram(env).send(user.tg_id, lines.join("\n"), { keyboard });
}

export function helpText(): string {
  return [
    "<b>Що я вмію</b> — кнопки меню внизу або команди:",
    "",
    "📝 /new — поставити зустріч: опишіть її текстом чи голосом, перешліть переписку або скріншот — я підготую картку.",
    "   Можна й без команди: будь-який текст чи переслане повідомлення стає карткою зустрічі.",
    "📋 /today — зустрічі на сьогодні · 🗓 /tomorrow — на завтра · 📆 /week — на тиждень",
    "🕒 /free — найближчі вільні вікна",
    "✉️ /mail — пошта: «перевір нові листи», «напиши Івану, що зустріч переносимо»",
    "💬 Відповідайте на моє повідомлення про зустріч: «перенеси на 15:00», «скасуй», «хто буде?», «додай нотатку: …».",
    "🔔 Про нові, перенесені й скасовані події повідомляю одразу; щоранку — зустрічі на сьогодні.",
    "",
    "/contacts — кого я знаю з календаря · /settings — налаштування · /cancel — скасувати дію",
  ].join("\n");
}
