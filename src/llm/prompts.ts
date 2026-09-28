import type { Card, DirectoryEntry } from "../bot/card";
import type { User } from "../bot/owner";
import { durationOf, formatOf } from "../bot/owner";
import { describeNow } from "../lib/time";

const CARD_SCHEMA = `{
  "title": string | null,
  "start": "YYYY-MM-DDTHH:MM:SS+HH:MM" | null,
  "date": "YYYY-MM-DD" | null,
  "duration_min": number | null,
  "format": "offline" | "google_meet" | "zoom" | null,
  "location": string | null,
  "attendees": [{"name": string | null, "email": string | null, "internal": boolean}],
  "initiator": string | null,
  "purpose": string | null,
  "agenda": [string],
  "agreed_via": string | null,
  "agreed_at": "YYYY-MM-DD" | null,
  "missing": [string],
  "confidence": number,
  "clarify_question": string | null
}`;

function ownerBlock(owner: User): string {
  return [
    `Власник календаря (організатор): ${owner.full_name ?? "невідомо"}${owner.position ? `, ${owner.position}` : ""}${owner.email ? `, ${owner.email}` : ""}.`,
    `Дефолтна тривалість: ${durationOf(owner)} хв. Дефолтний формат: ${formatOf(owner)}.`,
    owner.defaults.address ? `Дефолтна адреса: ${owner.defaults.address}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function directoryBlock(directory: DirectoryEntry[]): string {
  if (!directory.length) return "Адресна книга порожня.";
  return `Адресна книга керівника (відомі контакти):\n${directory.map((d) => `- ${d.name} <${d.email}>`).join("\n")}`;
}

const RULES = `Правила:
- Відповідай ЛИШЕ JSON-обʼєктом за схемою, без пояснень.
- Нічого не вигадуй. Якщо даних немає — null (для масивів — []).
- Дати й час рахуй відносно поточного моменту, часовий пояс Europe/Kyiv; "start" — з офсетом Києва на ту дату.
  «у четвер» — найближчий четвер у майбутньому; «наступного вівторка» — вівторок наступного тижня;
  «зранку» ≈ 10:00, «в обід» ≈ 13:00, «після обіду» ≈ 14:00, «увечері» ≈ 18:00.
  Якщо відома лише дата без часу — "start": null і "date": дата. Якщо невідомо нічого — обидва null.
- "title": «Імʼя Прізвище співрозмовника + Імʼя власника» (напр. «Іван Петренко + Олександр»);
  для внутрішньої наради без зовнішніх людей — коротка тема.
- "attendees": усі люди, з якими зустріч, КРІМ власника. Email — лише якщо він явно є в тексті або в адресній книзі.
  "internal": true — якщо це колега з компанії власника (та сама компанія / корпоративний домен пошти).
- "format": "zoom", якщо явно згадано Zoom/зум; "google_meet", якщо йдеться про онлайн/відеодзвінок/Meet без
  згадки Zoom; "offline", якщо названо місце чи адресу; інакше null.
- "location": адреса або назва місця так, як її вказали в тексті; для онлайн — null.
- "initiator": хто запропонував зустріч; "purpose": з чим прийшов / мета одним реченням; "agenda": що хоче обговорити.
- "agreed_via": месенджер/канал, де домовились (Telegram, Viber, WhatsApp, email, телефон) — якщо зрозуміло з контексту;
  "agreed_at": дата домовленості.
- "missing": чого не вистачає для інвайту людською мовою (напр. «email Івана Петренка»). Для зовнішніх учасників
  без email — обовʼязково.
- "confidence": 0..1 — наскільки впевнено зрозуміло, що це запит на зустріч і з ким вона.
- "clarify_question": якщо не зрозуміло, чи це взагалі зустріч, або з ким — одне коротке уточнювальне питання
  українською; інакше null.`;

/** System prompt for extracting a meeting card from text / voice / forwarded chat / screenshots (spec 4.2). */
export function cardSystemPrompt(owner: User, directory: DirectoryEntry[], now: Date): string {
  return [
    "Ти — AI-секретар керівника. З повідомлення, голосового, пересланої",
    "переписки або скріншота переписки витягни дані для події в Google Calendar.",
    "",
    `Зараз: ${describeNow(now)}.`,
    ownerBlock(owner),
    directoryBlock(directory),
    "",
    `Схема відповіді:\n${CARD_SCHEMA}`,
    "",
    RULES,
  ].join("\n");
}

/** System prompt for applying a free-text correction to an existing card. */
export function editSystemPrompt(owner: User, directory: DirectoryEntry[], now: Date): string {
  return [
    "Ти — AI-секретар керівника. Є картка зустрічі (JSON) і правка від керівника звичайним текстом",
    "(напр. «перенеси на 16:00, прибери Олега», «додай ivan@example.com», «зроби онлайн»).",
    "Застосуй правку і поверни ПОВНУ оновлену картку за тією ж схемою. Змінюй лише те, про що просять;",
    "решту полів залиш як є. Якщо правка незрозуміла — поверни картку без змін і заповни \"clarify_question\".",
    "Онови \"missing\" відповідно до нового стану.",
    "",
    `Зараз: ${describeNow(now)}.`,
    ownerBlock(owner),
    directoryBlock(directory),
    "",
    `Схема відповіді:\n${CARD_SCHEMA}`,
    "",
    RULES,
  ].join("\n");
}

/** Card fields sent back to the model for editing (bot-side fields stripped). */
export function cardForEdit(card: Card): string {
  const { slots: _slots, ...rest } = card;
  return JSON.stringify(rest, null, 2);
}

const ACTION_SCHEMA = `{
  "action": "reschedule" | "cancel" | "note" | "unclear",
  "new_start": "YYYY-MM-DDTHH:MM:SS+HH:MM" | null,
  "new_duration_min": number | null,
  "note_text": string | null,
  "clarify_question": string | null
}`;

/**
 * System prompt for a free-text reply about ONE specific, already-existing meeting (spec 4.7): reschedule,
 * cancel, or append a note to its description. "Who is attending" is answered straight from the stored
 * meeting record in code, without an LLM call, so it is never asked here.
 */
export function actionSystemPrompt(meeting: { title: string | null; start_at: number; end_at: number; description: string | null }, now: Date): string {
  return [
    "Ти — AI-секретар керівника. Керівник відповів на повідомлення про КОНКРЕТНУ зустріч у Google Calendar,",
    "яка вже існує. Визнач, що він хоче зробити з цією зустріччю.",
    "",
    `Зараз: ${describeNow(now)}.`,
    `Зустріч: «${meeting.title ?? "без назви"}», ${new Date(meeting.start_at).toISOString()} — ${new Date(meeting.end_at).toISOString()} (UTC).`,
    meeting.description ? `Поточний опис:\n${meeting.description}` : "",
    "",
    `Схема відповіді:\n${ACTION_SCHEMA}`,
    "",
    `Правила:
- "reschedule": перенесення на інший час/дату — постав "new_start" (з офсетом Європи/Києва), і "new_duration_min"
  лише якщо тривалість також названа явно; інакше null (тривалість залишається старою).
- "cancel": скасувати/відмінити/видалити зустріч.
- "note": додати нотатку, коментар чи підсумок до опису — "note_text" дослівно те, що додати.
- "unclear": незрозуміло, чого хоче керівник, або дані для reschedule не вдалось розпізнати — постав коротке
  уточнювальне запитання в "clarify_question" українською.
- Відповідай ЛИШЕ JSON-обʼєктом за схемою, нічого не вигадуй.`,
  ]
    .filter(Boolean)
    .join("\n");
}

const MAIL_SCHEMA = `{
  "action": "search" | "send" | "reply" | "draft" | "archive" | "mark_read" | "label" | "trash" | "unclear",
  "query": string | null,
  "to": [{"name": string | null, "email": string | null}],
  "subject": string | null,
  "body": string | null,
  "label": string | null,
  "clarify_question": string | null
}`;

/**
 * System prompt for a Gmail request (the n8n "Gmail Agent"). `target` is the email the owner replied to, when
 * there is one — then "reply", "archive", "mark_read", "label", "trash" apply to it.
 */
export function mailSystemPrompt(
  owner: User,
  directory: DirectoryEntry[],
  target: { from: string; subject: string; body: string } | null,
  now: Date,
): string {
  return [
    "Ти — AI-секретар керівника, який працює з його поштою Gmail. Визнач, що він хоче зробити.",
    "",
    `Зараз: ${describeNow(now)}.`,
    `Керівник: ${owner.full_name ?? "невідомо"}${owner.position ? `, ${owner.position}` : ""}${owner.email ? `, ${owner.email}` : ""}.`,
    directoryBlock(directory),
    target
      ? `\nКерівник відповідає на ЛИСТ:\nВід: ${target.from}\nТема: ${target.subject}\nТекст:\n${target.body.slice(0, 4000)}`
      : "\nКонкретного листа не вибрано.",
    "",
    `Схема відповіді:\n${MAIL_SCHEMA}`,
    "",
    `Правила:
- Відповідай ЛИШЕ JSON-обʼєктом за схемою, нічого не вигадуй.
- "search": показати листи — "query" у синтаксисі пошуку Gmail («is:unread», «from:ivan@x.com», «subject:бюджет»,
  «newer_than:2d»); «перевір пошту», «що нового» → "is:unread in:inbox".
- "send": новий лист — "to" (email лише з тексту або адресної книги), "subject", "body" від імені керівника.
- "reply": відповідь на вибраний лист — "body" текст відповіді від імені керівника (ввічливо, коротко, мовою листа).
- "draft": те саме, що "send", але лише зберегти чернетку.
- "archive" / "mark_read" / "trash": дія з вибраним листом. "label": додати мітку "label" до вибраного листа.
- Якщо потрібен вибраний лист, а його немає, або бракує адресата чи змісту — "unclear" і коротке питання
  українською в "clarify_question".`,
  ].join("\n");
}
