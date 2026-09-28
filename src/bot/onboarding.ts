import { type Env, gmailPushConfigured, zoomConfigured } from "../env";
import { gmailPushEndpoint } from "../google/gmailPush";
import { durationOf, formatOf, getUserById, type MeetingFormat, modelOf, updateUser, type User } from "../db/users";
import { connectLink, hasGmailScope, hasGoogleAuth } from "../google/oauth";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard, TgMessage } from "../telegram/types";

/**
 * Dialog steps. "o_*" is the onboarding chain, "s_*" a single setting changed from /settings
 * (returns to the settings screen afterwards).
 */
type Step = "name" | "position" | "phone" | "duration" | "format" | "address" | "model";

const OWNER_CHAIN: Step[] = ["name", "position", "phone", "duration", "format", "address"];

const PHONE_RE = /^\+?[\d\s()-]{7,20}$/;
/** OpenRouter model ids look like "vendor/model[:variant]" — a loose shape check, not a catalog lookup. */
const MODEL_ID_RE = /^[a-z0-9_.-]+\/[a-z0-9_:.-]+$/i;

type Mode = "o" | "s";

function parseState(state: string | null): { mode: Mode; step: Step } | null {
  const m = /^([os])_(\w+)$/.exec(state ?? "");
  return m ? { mode: m[1] as Mode, step: m[2] as Step } : null;
}

async function ask(env: Env, user: User, mode: Mode, step: Step): Promise<void> {
  await updateUser(env.db, user.id, { dialog_state: `${mode}_${step}` });
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
    case "format": {
      const row = [
        { text: "🏢 Офлайн", callback_data: "o:fmt:offline" },
        { text: "💻 Google Meet", callback_data: "o:fmt:google_meet" },
      ];
      if (zoomConfigured(env)) row.push({ text: "🎥 Zoom", callback_data: "o:fmt:zoom" });
      await tg.send(chat, "Формат зустрічі <b>за замовчуванням</b>:", { keyboard: [row] });
      return;
    }
    case "address":
      await tg.send(chat, "Адреса для офлайн-зустрічей <b>за замовчуванням</b> (якщо місце не вказали в переписці):", {
        keyboard: [[{ text: "Пропустити", callback_data: "o:addr:skip" }]],
      });
      return;
    case "model":
      await tg.send(
        chat,
        `Зараз картки зустрічей готує модель <code>${esc(modelOf(user, env.LLM_MODEL))}</code>.\n\n` +
          "Напишіть ідентифікатор іншої моделі з OpenRouter (напр. <code>openai/gpt-5</code>) — я перемкнуся на неї. " +
          "Список моделей: https://openrouter.ai/models\n\n" +
          "⚠️ Для скріншотів переписки модель має підтримувати зображення (vision).",
        { keyboard: [[{ text: "↩️ Типова модель", callback_data: "o:model:reset" }]] },
      );
      return;
  }
}

async function advance(env: Env, user: User, mode: Mode, step: Step): Promise<void> {
  if (mode === "s") {
    await updateUser(env.db, user.id, { dialog_state: null });
    await showSettings(env, (await reload(env, user))!);
    return;
  }
  const next = OWNER_CHAIN[OWNER_CHAIN.indexOf(step) + 1];
  if (next) {
    await ask(env, user, mode, next);
    return;
  }
  await updateUser(env.db, user.id, { dialog_state: null });
  await finishOnboarding(env, (await reload(env, user))!);
}

function reload(env: Env, user: User): Promise<User | null> {
  return getUserById(env.db, user.id);
}

async function finishOnboarding(env: Env, user: User): Promise<void> {
  const tg = new Telegram(env);
  await tg.send(user.tg_id, "✅ Профіль збережено.", { removeKeyboard: true });
  if (await hasGoogleAuth(env, user.id)) {
    await tg.send(user.tg_id, helpText());
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
  if (user.full_name && user.position) {
    if (!(await hasGoogleAuth(env, user.id))) {
      await sendConnectCalendar(env, user);
      return;
    }
    await tg.send(user.tg_id, `👋 З поверненням, ${esc(user.full_name)}!\n\n${helpText()}`);
    return;
  }
  await tg.send(
    user.tg_id,
    "👋 Вітаю! Я ваш AI-секретар: створюю зустрічі з переписки чи голосового, надсилаю інвайти, нагадую, читаю пошту " +
      "і веду протоколи.\n\nНалаштуємо профіль — це кілька питань.",
  );
  await ask(env, user, "o", "name");
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
      await updateUser(env.db, user.id, { full_name: text });
      break;
    }
    case "position": {
      if (!text || text.length > 150) {
        await tg.send(user.tg_id, "Напишіть посаду текстом.");
        return true;
      }
      await updateUser(env.db, user.id, { position: text });
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
      await updateUser(env.db, user.id, { phone: phone.startsWith("+") || !ownContact ? phone : `+${phone}` });
      break;
    }
    case "address": {
      if (!text) return true;
      await updateUser(env.db, user.id, { defaults: { ...user.defaults, address: text } });
      break;
    }
    case "model": {
      if (!MODEL_ID_RE.test(text)) {
        await tg.send(user.tg_id, "Формат ідентифікатора моделі: <code>вендор/модель</code>, напр. <code>openai/gpt-5</code>.");
        return true;
      }
      await updateUser(env.db, user.id, { defaults: { ...user.defaults, llm_model: text } });
      await tg.send(user.tg_id, `✅ Модель для карток зустрічей: <code>${esc(text)}</code>`, { removeKeyboard: true });
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
    await updateUser(env.db, user.id, { defaults: { ...user.defaults, duration_min: minutes } });
    if (state?.step === "duration") await advance(env, user, state.mode, "duration");
    return `${minutes} хв`;
  }
  if (field === "fmt") {
    if (value !== "offline" && value !== "google_meet" && value !== "zoom") return undefined;
    if (value === "zoom" && !zoomConfigured(env)) return undefined;
    await updateUser(env.db, user.id, { defaults: { ...user.defaults, format: value as MeetingFormat } });
    if (state?.step === "format") await advance(env, user, state.mode, "format");
    return { offline: "Офлайн", google_meet: "Google Meet", zoom: "Zoom" }[value];
  }
  if (field === "addr" && value === "skip") {
    if (state?.step === "address") await advance(env, user, state.mode, "address");
    return "Пропущено";
  }
  if (field === "model" && value === "reset") {
    await updateUser(env.db, user.id, { defaults: { ...user.defaults, llm_model: undefined } });
    if (state?.step === "model") await advance(env, user, state.mode, "model");
    return `Типова: ${env.LLM_MODEL}`;
  }
  if (field === "set") {
    const steps: Record<string, Step> = {
      name: "name", position: "position", phone: "phone", duration: "duration", format: "format", address: "address", model: "model",
    };
    const step = steps[value];
    if (step) await ask(env, user, "s", step);
    return undefined;
  }
  return undefined;
}

const FORMAT_LABELS: Record<MeetingFormat, string> = { offline: "офлайн", google_meet: "Google Meet", zoom: "Zoom" };

/** /settings */
export async function showSettings(env: Env, user: User): Promise<void> {
  const connected = await hasGoogleAuth(env, user.id);
  const gmail = connected && (await hasGmailScope(env, user.id));
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
    `Модель для карток: ${esc(modelOf(user, env.LLM_MODEL))}${user.defaults.llm_model ? "" : " (типова)"}`,
    `Google Calendar: ${connected ? "✅ підключено" : "❌ не підключено"}`,
    `Gmail: ${!connected ? "—" : gmail ? "✅ підключено" : "⚠️ потрібно перепідключити календар, щоб дати доступ"}`,
  ];
  if (gmailPushConfigured(env)) {
    lines.push("", `Адреса push-підписки Pub/Sub для сповіщень про нові листи (секретна, не публікуйте):\n<code>${esc(gmailPushEndpoint(env))}</code>`);
  }
  const keyboard: InlineKeyboard = [
    [
      { text: "Імʼя", callback_data: "o:set:name" },
      { text: "Посада", callback_data: "o:set:position" },
      { text: "Телефон", callback_data: "o:set:phone" },
    ],
    [
      { text: "Тривалість", callback_data: "o:set:duration" },
      { text: "Формат", callback_data: "o:set:format" },
      { text: "Адреса", callback_data: "o:set:address" },
    ],
    [{ text: "Модель ШІ", callback_data: "o:set:model" }],
    [{ text: connected ? "🔄 Перепідключити календар" : "🔗 Підключити календар", url: await connectLink(env, user.id) }],
  ];
  await new Telegram(env).send(user.tg_id, lines.join("\n"), { keyboard });
}

export function helpText(): string {
  return [
    "<b>Що я вмію</b>",
    "",
    "📝 Напишіть, надиктуйте голосом, перешліть переписку або скиньте скріншот — я підготую картку зустрічі.",
    "Наприклад: <i>«зустріч з Іваном Петренком у четвер о 15:00 по бюджету Буковелю»</i>.",
    "✅ Після кнопки «Створити» подія зʼявиться в Google Calendar, а учасники отримають запрошення на пошту.",
    "🔄 Зміни в календарі (зокрема зроблені вручну) я бачу автоматично і одразу повідомляю.",
    "💬 Відповідайте на моє повідомлення про зустріч, щоб перенести чи скасувати її, дізнатись учасників або додати нотатку.",
    "📧 Пишіть щось на кшталт «перевір пошту» або «напиши Івану лист» — я також умію Gmail.",
    "📇 Імена та email учасників я запамʼятовую — наступного разу достатньо імені.",
    "",
    "/new — нова зустріч",
    "/mail — дія з поштою",
    "/contacts — адресна книга; <code>/contact Імʼя Прізвище email</code> — додати",
    "/settings — профіль, значення за замовчуванням, календар, модель ШІ",
    "/cancel — скасувати поточну дію",
    "/help — ця довідка",
  ].join("\n");
}
