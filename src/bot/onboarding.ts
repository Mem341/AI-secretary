import type { Env } from "../env";
import { durationOf, formatOf, getUserById, type MeetingFormat, updateUser, type User } from "../db/users";
import { connectLink, hasGoogleAuth } from "../google/oauth";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard, TgMessage } from "../telegram/types";

/**
 * Dialog steps. "o_*" is the owner's onboarding chain, "m_*" the internal member's, "s_*" a single setting
 * changed from /settings (returns to the settings screen afterwards).
 */
type Step = "name" | "position" | "phone" | "duration" | "format" | "address" | "email";

const OWNER_CHAIN: Step[] = ["name", "position", "phone", "duration", "format", "address"];
const MEMBER_CHAIN: Step[] = ["name", "email"];

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;
const PHONE_RE = /^\+?[\d\s()-]{7,20}$/;

function parseState(state: string | null): { mode: "o" | "m" | "s"; step: Step } | null {
  const m = /^([oms])_(\w+)$/.exec(state ?? "");
  return m ? { mode: m[1] as "o" | "m" | "s", step: m[2] as Step } : null;
}

async function ask(env: Env, user: User, mode: "o" | "m" | "s", step: Step): Promise<void> {
  await updateUser(env.DB, user.id, { dialog_state: `${mode}_${step}` });
  const tg = new Telegram(env);
  const chat = user.tg_id;
  switch (step) {
    case "name":
      await tg.send(chat, "Як вас звати? Напишіть <b>імʼя та прізвище</b> — так вас бачитимуть учасники зустрічей.");
      return;
    case "position":
      await tg.send(chat, "Ваша <b>посада</b>? (піде в підпис у подіях)");
      return;
    case "phone":
      await tg.send(chat, "Ваш <b>телефон</b> для підпису в подіях. Натисніть кнопку нижче або напишіть номер.", {
        replyKeyboard: [[{ text: "📱 Поділитися номером", request_contact: true }]],
      });
      return;
    case "duration":
      await tg.send(chat, "Тривалість зустрічі <b>за замовчуванням</b>:", {
        keyboard: [[30, 45, 60, 90].map((m) => ({ text: `${m} хв`, callback_data: `o:dur:${m}` }))],
      });
      return;
    case "format":
      await tg.send(chat, "Формат зустрічі <b>за замовчуванням</b>:", {
        keyboard: [
          [
            { text: "🏢 Офлайн", callback_data: "o:fmt:offline" },
            { text: "💻 Google Meet", callback_data: "o:fmt:google_meet" },
          ],
        ],
      });
      return;
    case "address":
      await tg.send(chat, "Адреса для офлайн-зустрічей <b>за замовчуванням</b> (якщо місце не вказали в переписці):", {
        keyboard: [[{ text: "Пропустити", callback_data: "o:addr:skip" }]],
      });
      return;
    case "email":
      await tg.send(chat, "Вкажіть вашу <b>робочу пошту</b> — за нею я впізнаю вас в інвайтах і надсилатиму нагадування.");
      return;
  }
}

async function advance(env: Env, user: User, mode: "o" | "m" | "s", step: Step): Promise<void> {
  if (mode === "s") {
    await updateUser(env.DB, user.id, { dialog_state: null });
    await showSettings(env, (await reload(env, user))!);
    return;
  }
  const chain = mode === "o" ? OWNER_CHAIN : MEMBER_CHAIN;
  const next = chain[chain.indexOf(step) + 1];
  if (next) {
    await ask(env, user, mode, next);
    return;
  }
  await updateUser(env.DB, user.id, { dialog_state: null });
  await finishOnboarding(env, (await reload(env, user))!);
}

function reload(env: Env, user: User): Promise<User | null> {
  return getUserById(env.DB, user.id);
}

async function finishOnboarding(env: Env, user: User): Promise<void> {
  const tg = new Telegram(env);
  if (user.role === "member") {
    await tg.send(
      user.tg_id,
      "✅ Готово! Я надсилатиму вам нагадування про зустрічі, де ви учасник, і підсумки, якими поділиться організатор.",
      { removeKeyboard: true },
    );
    return;
  }
  await tg.send(user.tg_id, "✅ Профіль збережено.", { removeKeyboard: true });
  if (await hasGoogleAuth(env, user.id)) {
    await tg.send(user.tg_id, helpText(user));
    return;
  }
  await sendConnectCalendar(env, user);
}

export async function sendConnectCalendar(env: Env, user: User): Promise<void> {
  await new Telegram(env).send(
    user.tg_id,
    "Останній крок — підключіть <b>Google Calendar</b>. Я створюватиму події від вашого імені, а Google сам " +
      "повідомлятиме мене про будь-які зміни в календарі.",
    { keyboard: [[{ text: "🔗 Підключити Google Calendar", url: await connectLink(env, user.id) }]] },
  );
}

/** /start */
export async function startOnboarding(env: Env, user: User): Promise<void> {
  const tg = new Telegram(env);
  const profileDone = user.role === "owner" ? !!(user.full_name && user.position) : !!(user.full_name && user.email);
  if (profileDone) {
    if (user.role === "owner" && !(await hasGoogleAuth(env, user.id))) {
      await sendConnectCalendar(env, user);
      return;
    }
    await tg.send(user.tg_id, `👋 З поверненням, ${esc(user.full_name)}!\n\n${helpText(user)}`);
    return;
  }
  await tg.send(
    user.tg_id,
    user.role === "owner"
      ? "👋 Вітаю! Я AI-секретар: створюю зустрічі з переписки чи голосового, надсилаю інвайти, нагадую і веду протоколи.\n\nНалаштуємо профіль — це кілька питань."
      : "👋 Вітаю! Я AI-секретар керівників Ribas. Підключу вас як учасника зустрічей — два питання.",
  );
  await ask(env, user, user.role === "owner" ? "o" : "m", "name");
}

/**
 * Handles a message while the user is in a dialog step. Returns false when the user is not in a dialog
 * (the message should be routed elsewhere).
 */
export async function handleDialogMessage(env: Env, user: User, msg: TgMessage): Promise<boolean> {
  const state = parseState(user.dialog_state);
  if (!state) return false;
  const tg = new Telegram(env);
  const text = (msg.text ?? "").trim();
  const { mode, step } = state;

  switch (step) {
    case "name": {
      if (text.split(/\s+/).length < 2 || text.length > 100) {
        await tg.send(user.tg_id, "Напишіть, будь ласка, імʼя та прізвище, наприклад: <i>Олександр Коваленко</i>.");
        return true;
      }
      await updateUser(env.DB, user.id, { full_name: text });
      break;
    }
    case "position": {
      if (!text || text.length > 150) {
        await tg.send(user.tg_id, "Напишіть посаду текстом.");
        return true;
      }
      await updateUser(env.DB, user.id, { position: text });
      break;
    }
    case "phone": {
      // Only the user's own contact is accepted from the "share" button.
      const ownContact = msg.contact && (!msg.contact.user_id || msg.contact.user_id === user.tg_id) ? msg.contact : undefined;
      const phone = ownContact?.phone_number ?? text;
      if (!PHONE_RE.test(phone)) {
        await tg.send(user.tg_id, "Не схоже на номер телефону. Приклад: <i>+380 67 123 45 67</i>.");
        return true;
      }
      await updateUser(env.DB, user.id, { phone: phone.startsWith("+") || !ownContact ? phone : `+${phone}` });
      break;
    }
    case "address": {
      if (!text) return true;
      await updateUser(env.DB, user.id, { defaults: { ...user.defaults, address: text } });
      break;
    }
    case "email": {
      const email = text.toLowerCase();
      if (!EMAIL_RE.test(email)) {
        await tg.send(user.tg_id, "Не схоже на email. Приклад: <i>name@ribashotels.com</i>.");
        return true;
      }
      await updateUser(env.DB, user.id, { email });
      break;
    }
    case "duration":
    case "format":
      await tg.send(user.tg_id, "Оберіть варіант кнопкою вище 👆");
      return true;
  }
  await advance(env, user, mode, step);
  return true;
}

/** "o:<field>:<value>" buttons of the onboarding / settings dialog. */
export async function handleDialogCallback(env: Env, user: User, field: string, value: string): Promise<string | undefined> {
  const state = parseState(user.dialog_state);
  if (field === "dur") {
    const minutes = Number(value);
    if (![30, 45, 60, 90].includes(minutes)) return undefined;
    await updateUser(env.DB, user.id, { defaults: { ...user.defaults, duration_min: minutes } });
    if (state?.step === "duration") await advance(env, user, state.mode, "duration");
    return `${minutes} хв`;
  }
  if (field === "fmt") {
    if (value !== "offline" && value !== "google_meet") return undefined;
    await updateUser(env.DB, user.id, { defaults: { ...user.defaults, format: value as MeetingFormat } });
    if (state?.step === "format") await advance(env, user, state.mode, "format");
    return value === "offline" ? "Офлайн" : "Google Meet";
  }
  if (field === "addr" && value === "skip") {
    if (state?.step === "address") await advance(env, user, state.mode, "address");
    return "Пропущено";
  }
  if (field === "set") {
    const steps: Record<string, Step> = {
      name: "name", position: "position", phone: "phone", duration: "duration", format: "format", address: "address", email: "email",
    };
    const step = steps[value];
    if (step) await ask(env, user, "s", step);
    return undefined;
  }
  return undefined;
}

/** /settings */
export async function showSettings(env: Env, user: User): Promise<void> {
  const connected = await hasGoogleAuth(env, user.id);
  const lines = [
    "⚙️ <b>Налаштування</b>",
    "",
    `Імʼя: ${esc(user.full_name ?? "—")}`,
    `Пошта: ${esc(user.email ?? "—")}`,
  ];
  const keyboard: InlineKeyboard = [
    [
      { text: "Імʼя", callback_data: "o:set:name" },
      { text: "Пошта", callback_data: "o:set:email" },
    ],
  ];
  if (user.role === "owner") {
    lines.push(
      `Посада: ${esc(user.position ?? "—")}`,
      `Телефон: ${esc(user.phone ?? "—")}`,
      `Тривалість за замовчуванням: ${durationOf(user)} хв`,
      `Формат за замовчуванням: ${formatOf(user) === "google_meet" ? "Google Meet" : "офлайн"}`,
      `Адреса за замовчуванням: ${esc(user.defaults.address ?? "—")}`,
      `Google Calendar: ${connected ? "✅ підключено" : "❌ не підключено"}`,
    );
    keyboard.push(
      [
        { text: "Посада", callback_data: "o:set:position" },
        { text: "Телефон", callback_data: "o:set:phone" },
      ],
      [
        { text: "Тривалість", callback_data: "o:set:duration" },
        { text: "Формат", callback_data: "o:set:format" },
        { text: "Адреса", callback_data: "o:set:address" },
      ],
      [{ text: connected ? "🔄 Перепідключити календар" : "🔗 Підключити календар", url: await connectLink(env, user.id) }],
    );
  }
  await new Telegram(env).send(user.tg_id, lines.join("\n"), { keyboard });
}

export function helpText(user: User): string {
  if (user.role === "member") {
    return [
      "Я надсилаю нагадування про зустрічі, де ви учасник, і підсумки від організатора.",
      "",
      "/settings — імʼя та робоча пошта",
      "/help — ця довідка",
    ].join("\n");
  }
  return [
    "<b>Що я вмію</b>",
    "",
    "📝 Напишіть, надиктуйте голосом, перешліть переписку або скиньте скріншот — я підготую картку зустрічі.",
    "Наприклад: <i>«зустріч з Іваном Петренком у четвер о 15:00 по бюджету Буковелю»</i>.",
    "✅ Після кнопки «Створити» подія зʼявиться в Google Calendar, а учасники отримають запрошення на пошту.",
    "🔄 Зміни в календарі (зокрема зроблені вручну) я бачу автоматично.",
    "",
    "/new — нова зустріч",
    "/settings — профіль, значення за замовчуванням, календар",
    "/cancel — скасувати поточну дію",
    "/help — ця довідка",
  ].join("\n");
}
