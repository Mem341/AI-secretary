import { type Env, gmailPushConfigured, zoomConfigured } from "../env";
import { gmailPushEndpoint } from "../google/gmailPush";
import { connectLink, hasGmailScope, hasGoogleAuth, loadOwnerSettings, type OwnerSettings, saveOwnerSettings } from "../google/oauth";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import type { User } from "./owner";

/**
 * /settings: what is connected, what can be connected, and the owner's own choices (when to remind, the morning
 * list) — changed with buttons, saved in the pinned Google message. No database.
 */

/** Reminder choices offered as buttons, in minutes before a meeting. */
export const REMINDER_CHOICES = [60, 30, 15, 10, 5];

/** When to remind: the owner's choice, else REMINDER_MINUTES (30 and 10). Largest first; [] = off. */
export async function reminderMarks(env: Env): Promise<number[]> {
  const s = await loadOwnerSettings(env).catch((): OwnerSettings => ({}));
  return [...(s.r ?? env.REMINDER_MINUTES)].sort((a, b) => b - a);
}

export async function digestEnabled(env: Env): Promise<boolean> {
  const s = await loadOwnerSettings(env).catch((): OwnerSettings => ({}));
  return s.d ?? true;
}

function marksText(marks: number[]): string {
  if (!marks.length) return "вимкнено";
  // "за 30 і 10 хв", "за 1 год, 30 хв і 10 хв"
  const hour = marks.includes(60);
  const list = marks.map((m) => (m === 60 ? "1 год" : hour ? `${m} хв` : String(m)));
  const joined = list.length > 1 ? `${list.slice(0, -1).join(", ")} і ${list.at(-1)}` : list[0];
  return `за ${joined}${hour ? "" : " хв"} до зустрічі`;
}

const line = (ok: boolean, text: string) => `${ok ? "✅" : "➕"} ${text}`;

async function mainView(env: Env, user: User): Promise<{ html: string; keyboard: InlineKeyboard }> {
  const google = await hasGoogleAuth(env);
  const gmail = google && (await hasGmailScope(env));
  const marks = await reminderMarks(env);
  const digest = await digestEnabled(env);
  const name = user.full_name ? `<b>${esc(user.full_name)}</b>` : "<b>Власник</b>";

  const connected: string[] = [];
  const available: string[] = [];
  (google ? connected : available).push(line(google, "Google Calendar — зустрічі, розклад, запрошення"));
  if (google) (gmail ? connected : available).push(line(gmail, gmail ? "Gmail — пошта" : "Gmail — перепідключіть Google й дозвольте пошту"));
  else available.push(line(false, "Gmail — пошта (разом із Google)"));
  connected.push(line(true, "Голосові повідомлення"));
  (gmailPushConfigured(env) ? connected : available).push(line(gmailPushConfigured(env), "Миттєві сповіщення про нові листи"));
  (zoomConfigured(env) ? connected : available).push(line(zoomConfigured(env), "Zoom — зустрічі в Zoom"));

  const html = [
    "⚙️ <b>Налаштування</b>",
    "",
    `👤 ${name}${user.email ? `\n📧 ${esc(user.email)}` : ""}`,
    "",
    "<b>Підключено</b>",
    ...connected,
    ...(available.length ? ["", "<b>Можна підключити</b>", ...available] : []),
    "",
    "<b>Сповіщення</b>",
    `⏰ Нагадування: ${marksText(marks)}`,
    `☀️ Ранковий список зустрічей: ${digest ? "увімкнено" : "вимкнено"}`,
    "🔔 Нові запрошення, зміни в календарі й відповіді гостей — одразу",
  ].join("\n");

  const keyboard: InlineKeyboard = [];
  if (google) {
    keyboard.push([
      { text: "⏰ Нагадування", callback_data: "set:rem" },
      { text: `☀️ Ранковий список: ${digest ? "✅" : "❌"}`, callback_data: "set:digest" },
    ]);
  }
  keyboard.push([{ text: google ? "🔄 Перепідключити Google" : "🔗 Підключити Google", url: await connectLink(env) }]);
  if (gmailPushConfigured(env) && gmail) keyboard.push([{ text: "📧 Адреса для сповіщень про листи", callback_data: "set:mailpush" }]);
  if (available.length) keyboard.push([{ text: "🛠 Як підключити решту", url: `${env.PUBLIC_URL}/api/setup` }]);
  return { html, keyboard };
}

async function remindersView(env: Env): Promise<{ html: string; keyboard: InlineKeyboard }> {
  const marks = await reminderMarks(env);
  const button = (m: number) => ({ text: `${marks.includes(m) ? "✅" : "▫️"} ${m === 60 ? "1 год" : `${m} хв`}`, callback_data: `set:r:${m}` });
  return {
    html: [
      "⏰ <b>Коли нагадувати про зустріч?</b>",
      "",
      "Оберіть один чи кілька варіантів — натисніть ще раз, щоб прибрати.",
      "",
      `Зараз: ${marksText(marks)}`,
      "",
      "<i>Нагадування приходять, якщо на сторінці налаштування підключено виклик кожні 5 хвилин (cron-job.org).</i>",
    ].join("\n"),
    keyboard: [
      REMINDER_CHOICES.slice(0, 3).map(button),
      REMINDER_CHOICES.slice(3).map(button),
      [
        { text: "🔕 Не нагадувати", callback_data: "set:r:off" },
        { text: "⬅️ Готово", callback_data: "set:back" },
      ],
    ],
  };
}

/** /settings */
export async function showSettings(env: Env, user: User): Promise<void> {
  const view = await mainView(env, user);
  await new Telegram(env).send(user.tg_id, view.html, { keyboard: view.keyboard });
}

/** A button under the settings message ("set:…"): handled right here, no AI. */
export async function handleSettingsButton(env: Env, user: User, data: string, callbackId: string, messageId: number): Promise<void> {
  const tg = new Telegram(env);
  const answer = (text?: string) => tg.answerCallback(callbackId, text).catch(() => undefined);
  const show = async (view: { html: string; keyboard: InlineKeyboard }) => tg.edit(user.tg_id, messageId, view.html, view.keyboard);

  if (data === "set:mailpush") {
    await answer();
    await tg.send(
      user.tg_id,
      `Адреса push-підписки Pub/Sub для сповіщень про нові листи (секретна, нікому не показуйте):\n<code>${esc(gmailPushEndpoint(env))}</code>`,
    );
    return;
  }
  if (data === "set:back") {
    await answer();
    return show(await mainView(env, user));
  }
  if (!(await hasGoogleAuth(env))) {
    await answer("Спершу підключіть Google");
    return;
  }
  const settings = await loadOwnerSettings(env);
  if (data === "set:rem") {
    await answer();
    return show(await remindersView(env));
  }
  if (data === "set:digest") {
    settings.d = !(await digestEnabled(env));
    await saveOwnerSettings(env, settings);
    await answer(settings.d ? "Ранковий список увімкнено" : "Ранковий список вимкнено");
    return show(await mainView(env, user));
  }
  if (data.startsWith("set:r:")) {
    const value = data.slice("set:r:".length);
    const marks = await reminderMarks(env);
    const m = Number(value);
    settings.r = value === "off" ? [] : marks.includes(m) ? marks.filter((x) => x !== m) : [...marks, m].sort((a, b) => b - a);
    await saveOwnerSettings(env, settings);
    await answer(settings.r.length ? `Нагадування: ${marksText(settings.r)}` : "Нагадування вимкнено");
    return show(await remindersView(env));
  }
  await answer();
}
