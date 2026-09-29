import type { Env } from "../env";
import { Calendar, type GEvent } from "../google/calendar";
import { connectLink, forgetGoogleAuth, GoogleAuthRevokedError, hasGoogleAuth } from "../google/oauth";
import { type EventRef, listMeetings, type Meeting } from "../google/sync";
import { bytesToBase64, randomId } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { DAY, formatRange, parseIsoWithOffset } from "../lib/time";
import { chatJson, type ContentPart } from "../llm/openrouter";
import { cardForEdit, cardSystemPrompt, editSystemPrompt } from "../llm/prompts";
import { appendBatch, clearAnswer, expectAnswer, firstTime, takeAnswer, takeBatch } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData, hiddenSize, MAX_HIDDEN, readHidden } from "../telegram/hidden";
import type { InlineKeyboard, TgMessage } from "../telegram/types";
import { createZoomMeeting } from "../zoom/client";
import { type ActionQuestion, startAction } from "./actions";
import {
  attendeesWithoutEmail,
  buildEventBody,
  type Card,
  cardEnd,
  cardStart,
  CONFIDENCE_THRESHOLD,
  findFreeSlots,
  normalizeCard,
  renderCard,
  slotLabel,
} from "./card";
import { loadDirectory } from "./contacts";
import { type MailQuestion, type MailRef, looksLikeMailRequest, startMailDraft } from "./mail";
import { loadOwner, type User } from "./owner";

export type SourceType = "text" | "voice" | "forward" | "screenshot";

/** Spec 4.2: the bot waits after the last forwarded message and handles the series as one batch. */
export const FORWARD_DEBOUNCE_S = 10;
/** Photos sent as an album arrive as separate messages; a short debounce merges them. */
export const PHOTO_DEBOUNCE_S = 4;

const PHOTO_MARK = /^\[\[photo:([^\]]+)\]\]$/;

export function photoLine(fileId: string): string {
  return `[[photo:${fileId}]]`;
}

/**
 * A meeting request being turned into a card. There is no drafts table: the card travels hidden inside its own
 * Telegram message (see telegram/hidden.ts) and comes back with every button press and reply.
 * `id` makes the Google event id — pressing «Створити» twice creates one event.
 */
export interface Draft {
  id: string;
  src: string;
  st: SourceType;
}

/** Hidden in a card message (and in the "what to change?" prompt, with `msg` = the card's message id). */
export interface CardData {
  k: "card";
  id: string;
  card: Card;
  msg?: number;
}

/** Hidden in a clarifying question: the request so far, re-parsed together with the answer. */
export interface ClarifyData {
  k: "clarify";
  id: string;
  src: string;
  st: SourceType;
}

type Hidden = CardData | ClarifyData | EventRef | ActionQuestion | MailRef | MailQuestion | { k: string };

// ---------------------------------------------------------------------------------------------------------------
// Input routing

async function requireCalendar(env: Env, chatId: number): Promise<boolean> {
  if (await hasGoogleAuth(env)) return true;
  await new Telegram(env).send(chatId, "Спочатку підключіть Google — без нього я не зможу створити подію.", {
    keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]],
  });
  return false;
}

/**
 * Owner's free text (typed or transcribed) — the router. What the text continues is read from the message it
 * replies to (or, when it is not a reply, from what the bot has just asked in this instance): a card to edit, a
 * clarifying question, a meeting notice, an email. Otherwise mail words route to Gmail, and anything else is a new
 * meeting request.
 */
export async function handleOwnerText(
  env: Env,
  user: User,
  chatId: number,
  text: string,
  sourceType: SourceType,
  replyTo: TgMessage | null,
): Promise<void> {
  const tg = new Telegram(env);
  const context = replyTo ? readHidden<Hidden>(replyTo) : takeAnswer<Hidden>(chatId);
  if (replyTo && context) clearAnswer(chatId);

  switch (context?.k) {
    case "card": {
      const data = context as CardData;
      await tg.typing(chatId);
      await env.jobs.send({ type: "edit", data, instruction: text, messageId: data.msg ?? replyTo?.message_id ?? null });
      return;
    }
    case "clarify": {
      const data = context as ClarifyData;
      await tg.typing(chatId);
      const draft: Draft = { id: data.id, src: `${data.src}\nУточнення: ${text}`, st: data.st };
      await env.jobs.send({ type: "parse", draft, messageId: null });
      return;
    }
    case "ev":
      await startAction(env, chatId, (context as EventRef).id, text);
      return;
    case "evq": {
      const q = context as ActionQuestion;
      await startAction(env, chatId, q.id, `${q.src}\n${text}`);
      return;
    }
    case "mail":
      await startMailDraft(env, chatId, text, (context as MailRef).id);
      return;
    case "mailq": {
      const q = context as MailQuestion;
      await startMailDraft(env, chatId, `${q.src}\n${text}`.trim(), q.t);
      return;
    }
  }

  // A new request: mail words go to Gmail, everything else becomes a meeting card.
  if (looksLikeMailRequest(text)) {
    await startMailDraft(env, chatId, text);
    return;
  }
  if (!(await requireCalendar(env, chatId))) return;
  const placeholder = await tg.send(chatId, "⏳ Готую картку зустрічі…");
  await env.jobs.send({ type: "parse", draft: { id: randomId(9), src: text, st: sourceType }, messageId: placeholder.message_id });
}

/** A forwarded message or a screenshot: collected into a batch, processed after a quiet period. */
export async function handleBatchInput(
  env: Env,
  user: User,
  chatId: number,
  line: string,
  sourceType: SourceType,
  delaySeconds: number,
): Promise<void> {
  if (!(await requireCalendar(env, chatId))) return;
  const batch = appendBatch(chatId, line, sourceType);
  const seq = batch.seq;
  if (seq === 1) {
    const msg = await new Telegram(env).send(
      chatId,
      sourceType === "forward"
        ? `📥 Збираю переписку… Картку покажу через ${FORWARD_DEBOUNCE_S} с після останнього пересланого повідомлення.`
        : "📥 Отримав скріншот, розбираю…",
    );
    batch.messageId = msg.message_id;
  }
  await env.jobs.send({ type: "batch", chatId, seq }, { delaySeconds });
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs

export async function processBatch(env: Env, chatId: number, seq: number): Promise<void> {
  // Only the job carrying the latest sequence number proceeds; earlier ones see a newer seq and stop.
  const batch = takeBatch(chatId, seq);
  if (!batch) return;
  await parseDraft(env, { id: randomId(9), src: batch.lines.join("\n"), st: batch.sourceType }, batch.messageId);
}

async function buildUserContent(env: Env, draft: Draft): Promise<ContentPart[]> {
  const tg = new Telegram(env);
  const textLines: string[] = [];
  const images: ContentPart[] = [];
  for (const line of draft.src.split("\n")) {
    const photo = PHOTO_MARK.exec(line.trim());
    if (!photo) {
      textLines.push(line);
      continue;
    }
    const { bytes, path } = await tg.download(photo[1]!);
    const mime = path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
    images.push({ type: "image_url", image_url: { url: `data:${mime};base64,${bytesToBase64(bytes)}` } });
  }
  const intro: Record<SourceType, string> = {
    text: "Повідомлення керівника:",
    voice: "Голосове повідомлення керівника (транскрипт):",
    forward: "Переслана керівником переписка (Telegram):",
    screenshot: "Скріншот(и) переписки від керівника:",
  };
  const parts: ContentPart[] = [{ type: "text", text: `${intro[draft.st]}\n${textLines.join("\n").trim()}` }];
  return parts.concat(images);
}

/** Builds the card from the request and shows it (or asks a clarifying question). */
export async function parseDraft(env: Env, draft: Draft, messageId: number | null, now = new Date()): Promise<void> {
  const me = await loadOwner(env);
  const directory = await loadDirectory(env);
  const raw = await chatJson(env, env.LLM_MODEL, [
    { role: "system", content: cardSystemPrompt(me, directory, now) },
    { role: "user", content: await buildUserContent(env, draft) },
  ]);
  const card = normalizeCard(raw, me, directory);
  if (card.confidence < CONFIDENCE_THRESHOLD) {
    await askClarification(env, draft, card, messageId);
    return;
  }
  await presentCard(env, { k: "card", id: draft.id, card }, messageId, now);
}

export async function editDraft(env: Env, data: CardData, instruction: string, messageId: number | null, now = new Date()): Promise<void> {
  const user = await loadOwner(env);
  const directory = await loadDirectory(env);
  const raw = await chatJson(env, env.LLM_MODEL, [
    { role: "system", content: editSystemPrompt(user, directory, now) },
    { role: "user", content: `Картка:\n${cardForEdit(data.card)}\n\nПравка: ${instruction}` },
  ]);
  const card = normalizeCard(raw, user, directory);
  // An edit never drops the card's confidence below the threshold; the question is still shown.
  if (card.clarify_question) {
    await new Telegram(env).send(env.OWNER_TELEGRAM_ID, `❓ ${esc(card.clarify_question)}`, { replyTo: messageId ?? undefined });
    card.clarify_question = null;
  }
  await presentCard(env, { k: "card", id: data.id, card }, messageId, now);
}

/** Fits the request text into the hidden data of a message; a long forwarded chat keeps its latest part. */
function fitClarify(data: ClarifyData): ClarifyData {
  let src = data.src;
  while (src.length > 200 && hiddenSize({ ...data, src }) > MAX_HIDDEN) src = src.slice(Math.floor(src.length / 3));
  return { ...data, src };
}

async function askClarification(env: Env, draft: Draft, card: Card, messageId: number | null): Promise<void> {
  const question = card.clarify_question ?? "Не зовсім зрозумів. Уточніть, будь ласка: з ким зустріч і коли?";
  const data: ClarifyData = { k: "clarify", id: draft.id, src: draft.src, st: draft.st };
  const tg = new Telegram(env);
  const html = `${hiddenData(fitClarify(data))}❓ ${esc(question)}\n\n<i>Відповідайте на це повідомлення.</i>`;
  const keyboard: InlineKeyboard = [[{ text: "✖️ Скасувати", callback_data: "d:x" }]];
  let sent = false;
  if (messageId) sent = await tg.edit(env.OWNER_TELEGRAM_ID, messageId, html, keyboard).then(() => true, () => false);
  if (!sent) await tg.send(env.OWNER_TELEGRAM_ID, html, { keyboard });
  // The answer may come without "reply": this instance remembers the question for a while (full text included).
  expectAnswer(env.OWNER_TELEGRAM_ID, data);
}

function cardKeyboard(card: Card, now: Date): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (cardStart(card)) {
    rows.push([{ text: "✅ Створити", callback_data: "d:c" }]);
    const noEmail = attendeesWithoutEmail(card);
    if (noEmail.length) {
      const names = noEmail.map((a) => a.name ?? "?").join(", ");
      const label = `✅ Створити без: ${names}`;
      rows.push([{ text: label.length > 60 ? `${label.slice(0, 57)}…` : label, callback_data: "d:w" }]);
    }
  } else {
    (card.slots ?? []).forEach((iso, i) => {
      const slot = parseIsoWithOffset(iso);
      if (slot) rows.push([{ text: `🕒 ${slotLabel(slot, now)}`, callback_data: `d:s${i}` }]);
    });
  }
  rows.push([
    { text: "✏️ Змінити", callback_data: "d:e" },
    { text: "✖️ Скасувати", callback_data: "d:x" },
  ]);
  return rows;
}

/** Computes slots / conflicts from the live calendar, renders the card and shows it in place of `messageId`. */
export async function presentCard(env: Env, data: CardData, messageId: number | null, now = new Date()): Promise<void> {
  const card = data.card;
  const start = cardStart(card);
  let conflicts: Meeting[] = [];
  if (start) {
    card.slots = undefined;
    conflicts = await listMeetings(env, start.getTime(), cardEnd(card)!.getTime());
  } else {
    const busy = await listMeetings(env, now.getTime(), now.getTime() + 14 * DAY);
    card.slots = findFreeSlots({
      now,
      durationMin: card.duration_min,
      busy: busy.map((m) => ({ start: m.start_at, end: m.end_at })),
      date: card.date,
    }).map((d) => d.toISOString());
  }
  const html = hiddenData({ k: "card", id: data.id, card } satisfies CardData) + renderCard(card, { now, conflicts });
  const keyboard = cardKeyboard(card, now);
  const tg = new Telegram(env);
  if (messageId) {
    try {
      await tg.edit(env.OWNER_TELEGRAM_ID, messageId, html, keyboard);
      return;
    } catch {
      /* the message is gone: send a new card */
    }
  }
  await tg.send(env.OWNER_TELEGRAM_ID, html, { keyboard });
}

// ---------------------------------------------------------------------------------------------------------------
// Card buttons

/** Google event ids allow [a-v0-9]; a stable id derived from the draft makes a repeated «Створити» harmless. */
export async function eventIdForDraft(draftId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`draft:${draftId}`)));
  return `ais${Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function insertOrGet(cal: Calendar, body: Record<string, unknown>): Promise<GEvent> {
  try {
    return await cal.insertEvent(body);
  } catch (err) {
    // 409: an earlier attempt (or a second tap) already created the event.
    if (err instanceof HttpError && err.status === 409) return cal.getEvent(body.id as string);
    throw err;
  }
}

export async function createFromDraft(env: Env, user: User, draftId: string, card: Card): Promise<GEvent> {
  const cal = new Calendar(env);
  const eventId = await eventIdForDraft(draftId);

  let zoomJoinUrl: string | undefined;
  if (card.format === "zoom") {
    const start = cardStart(card)!;
    const zoom = await createZoomMeeting(env, {
      topic: card.title ?? "Зустріч",
      startIso: start.toISOString(),
      durationMin: card.duration_min,
      agenda: card.purpose ?? undefined,
    });
    zoomJoinUrl = zoom.join_url;
  }
  return insertOrGet(cal, { id: eventId, ...buildEventBody(card, user, draftId, zoomJoinUrl) });
}

function createdHtml(card: Card, event: GEvent, now: Date): string {
  const start = cardStart(card)!;
  const lines = [`✅ <b>Зустріч створена</b>`, "", `<b>${esc(card.title)}</b>`, esc(formatRange(start, cardEnd(card)!, now))];
  if (card.format === "google_meet") lines.push(event.hangoutLink ? `Google Meet: ${esc(event.hangoutLink)}` : "Google Meet");
  // For Zoom the join link was set as the event's location (see buildEventBody).
  else if (card.format === "zoom") lines.push(event.location ? `Zoom: ${esc(event.location)}` : "Zoom");
  else if (card.location) lines.push(`📍 ${esc(card.location)}`);
  const invited = card.attendees.filter((a) => a.email);
  if (invited.length) lines.push("", `Запрошення надіслано на пошту: ${invited.map((a) => esc(a.name ?? a.email)).join(", ")}`);
  lines.push("", "Відповідайте на це повідомлення, щоб перенести, скасувати чи дізнатись учасників.");
  return hiddenData({ k: "ev", id: event.id } satisfies EventRef) + lines.join("\n");
}

/** Handles "d:<action>" buttons; the card comes from the message the button belongs to. Returns the toast text. */
export async function handleCardCallback(
  env: Env,
  user: User,
  message: TgMessage | undefined,
  action: string,
  now = new Date(),
): Promise<string | undefined> {
  const tg = new Telegram(env);
  const data = readHidden<CardData | ClarifyData>(message);
  if (!message || !data) return "Картка неактуальна";
  const messageId = message.message_id;

  if (action === "x") {
    clearAnswer(env.OWNER_TELEGRAM_ID);
    await tg.edit(env.OWNER_TELEGRAM_ID, messageId, "✖️ Скасовано. Подію не створено.");
    return "Скасовано";
  }
  if (data.k !== "card") return "Картка ще готується";
  const draftCard = data.card;

  if (action === "e") {
    const prompt: CardData = { ...data, msg: messageId };
    await tg.send(
      env.OWNER_TELEGRAM_ID,
      `${hiddenData(prompt)}✏️ Напишіть, що змінити — наприклад: «перенеси на 16:00, прибери Олега, зроби онлайн».`,
      { forceReply: "Що змінити?" },
    );
    expectAnswer(env.OWNER_TELEGRAM_ID, prompt);
    return undefined;
  }

  if (action.startsWith("s")) {
    const slot = draftCard.slots?.[Number(action.slice(1))];
    const date = slot ? parseIsoWithOffset(slot) : null;
    if (!date) return "Слот неактуальний";
    await presentCard(env, { ...data, card: { ...draftCard, start: slot!, date: null } }, messageId, now);
    return "Час обрано";
  }

  if (action === "c" || action === "w") {
    let card = draftCard;
    if (action === "w") {
      const dropped = new Set(attendeesWithoutEmail(card));
      card = {
        ...card,
        attendees: card.attendees.filter((a) => !dropped.has(a)),
        missing: card.missing.filter((m) => !/e-?mail|пошт/i.test(m)),
      };
    }
    if (!cardStart(card)) return "Спочатку оберіть час";
    // A second tap on the same instance while the first is still creating.
    if (!firstTime(`create:${data.id}`, 60_000)) return "Вже обробляється";
    if (!(await hasGoogleAuth(env))) {
      await tg.send(env.OWNER_TELEGRAM_ID, "Google не підключено.", {
        keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]],
      });
      return undefined;
    }
    try {
      const event = await createFromDraft(env, user, data.id, card);
      const keyboard: InlineKeyboard = event.htmlLink ? [[{ text: "📅 Відкрити в календарі", url: event.htmlLink }]] : [];
      await tg.edit(env.OWNER_TELEGRAM_ID, messageId, createdHtml(card, event, now), keyboard);
      return "Створено";
    } catch (err) {
      if (err instanceof GoogleAuthRevokedError) {
        await forgetGoogleAuth(env);
        await tg.send(env.OWNER_TELEGRAM_ID, "⚠️ Доступ до Google втрачено. Підключіть його знову і натисніть «Створити» ще раз.", {
          keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]],
        });
        return undefined;
      }
      throw err;
    }
  }
  return undefined;
}
