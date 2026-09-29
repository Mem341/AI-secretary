/**
 * What is new in each version, for the owner: after a deployment the bot says it once (bot/news.ts). Add a release
 * (the next number, newest first) with every change the owner would notice; plain words, no technical details.
 * Whether the owner must do something (reconnect Google, the Pub/Sub check) is found out live, not written here.
 */
export interface Release {
  v: number;
  date: string;
  added?: string[];
  changed?: string[];
}

export const RELEASES: Release[] = [
  {
    v: 2,
    date: "2026-09-29",
    added: ["📧 /settings → «Нова пошта в бот»: вмикайте чи вимикайте пересилання нових листів сюди"],
    changed: [
      "⏰ Нагадування: без зайвих кнопок — кожне приходить і в Telegram, і сповіщенням Google Calendar; тестового нагадування більше немає",
      "📋 Bitrix24: відповідь на моє питання про задачу (назва, людина, дедлайн, спостерігач) лишається в задачах, навіть якщо в ній є «післязавтра»",
    ],
  },
  {
    v: 1,
    date: "2026-09-29",
    added: [
      "☀️ Ранковий звіт у ваш час: зустрічі з учасниками й посиланнями, перетини, вільні вікна, запрошення з ✅/❌, пошта, задачі Bitrix24, перша зустріч завтра — /settings → ☀️",
      "📊 Excel у Bitrix24: спершу обираєте, що вивантажити (прострочені, дедлайн цього тижня, де я відповідальний…)",
      "🔎 /settings → ⏰ → «Перевірити й надіслати тест» — перевіряє нагадування крок за кроком і надсилає тестове",
      "🆕 Після кожного оновлення я пишу, що змінилося",
    ],
    changed: [
      "⏰ Нагадування про зустрічі приходять самі в обрані хвилини — і в Telegram, і сповіщенням Google Calendar",
      "🧠 Памʼять: одна розмова до 100 питань-відповідей; коли я щось питаю — просто відповідайте, я продовжу ту саму дію",
    ],
  },
];

export const CURRENT_VERSION = RELEASES[0]!.v;
