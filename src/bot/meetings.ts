import type { Env } from "../env";
import {
  appendSource,
  appendToBatch,
  createDraft,
  type Draft,
  findDraftByMessage,
  findInputDraft,
  getDraft,
  markCreated,
  saveCard,
  setCardMessage,
  type SourceType,
  transition,
} from "../db/drafts";
import { listMeetingsBetween, markMeetingSource, upsertMeeting } from "../db/meetings";
import { getUserById, listContacts, saveContact, type User } from "../db/users";
import { Calendar, type GEvent } from "../google/calendar";
import { connectLink, forgetGoogleAuth, GoogleAuthRevokedError, hasGoogleAuth } from "../google/oauth";
import { eventToChange } from "../google/sync";
import { bytesToBase64 } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { DAY, formatRange, parseIsoWithOffset } from "../lib/time";
import { chatJson, type ContentPart } from "../llm/openrouter";
import { cardForEdit, cardSystemPrompt, editSystemPrompt } from "../llm/prompts";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
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

/** Spec 4.2: the bot waits 15 s after the last forwarded message and handles the series as one batch. */
export const FORWARD_DEBOUNCE_S = 15;
/** Photos sent as an album arrive as separate messages; a short debounce merges them. */
export const PHOTO_DEBOUNCE_S = 4;

const PHOTO_MARK = /^\[\[photo:([^\]]+)\]\]$/;

export function photoLine(fileId: string): string {
  return `[[photo:${fileId}]]`;
}

// ---------------------------------------------------------------------------------------------------------------
// Input routing

async function requireCalendar(env: Env, user: User, chatId: number): Promise<boolean> {
  if (await hasGoogleAuth(env, user.id)) return true;
  await new Telegram(env).send(chatId, "Спочатку підключіть Google Calendar — без нього я не зможу створити подію.", {
    keyboard: [[{ text: "🔗 Підключити Google Calendar", url: await connectLink(env, user.id) }]],
  });
  return false;
}

/**
 * Owner's free text (typed or transcribed): an edit of the card they replied to, an answer to the bot's
 * clarifying question / "Змінити" prompt, or a new meeting request.
 */
export async function handleOwnerText(
  env: Env,
  user: User,
  chatId: number,
  text: string,
  sourceType: SourceType,
  replyToMessageId: number | null,
): Promise<void> {
  const tg = new Telegram(env);
  const target =
    (replyToMessageId ? await findDraftByMessage(env.db, user.id, replyToMessageId) : null) ??
    (await findInputDraft(env.db, user.id));

  if (target?.state === "clarify") {
    await appendSource(env.db, target.id, `Уточнення: ${text}`, false);
    if (await transition(env.db, target.id, ["clarify"], "parsing")) {
      await tg.typing(chatId);
      await env.jobs.send({ type: "parse", draftId: target.id });
    }
    return;
  }
  if (target && (target.state === "editing" || target.state === "pending")) {
    await appendSource(env.db, target.id, `Правка: ${text}`, true);
    if (await transition(env.db, target.id, ["editing", "pending"], "parsing")) {
      await tg.typing(chatId);
      await env.jobs.send({ type: "edit", draftId: target.id, instruction: text });
    }
    return;
  }

  if (!(await requireCalendar(env, user, chatId))) return;
  const placeholder = await tg.send(chatId, "⏳ Готую картку зустрічі…");
  const draftId = await createDraft(env.db, user.id, sourceType, text, "parsing", placeholder.message_id);
  await env.jobs.send({ type: "parse", draftId });
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
  if (!(await requireCalendar(env, user, chatId))) return;
  const { id, seq } = await appendToBatch(env.db, user.id, sourceType, line);
  if (seq === 1) {
    const msg = await new Telegram(env).send(
      chatId,
      sourceType === "forward"
        ? `📥 Збираю переписку… Картку покажу через ${FORWARD_DEBOUNCE_S} с після останнього пересланого повідомлення.`
        : "📥 Отримав скріншот, розбираю…",
    );
    await setCardMessage(env.db, id, msg.message_id);
  }
  await env.jobs.send({ type: "batch", draftId: id, seq }, { delaySeconds });
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs

export async function processBatch(env: Env, draftId: string, seq: number): Promise<void> {
  // Only the job carrying the latest sequence number proceeds; earlier ones see a newer seq and stop.
  if (!(await transition(env.db, draftId, ["collecting"], "parsing", { batchSeq: seq }))) {
    // A retry of this same job after the state already moved on is still allowed to finish the parse.
    const draft = await getDraft(env.db, draftId);
    if (draft?.state !== "parsing" || draft.batch_seq !== seq) return;
  }
  await parseDraft(env, draftId);
}

async function buildUserContent(env: Env, draft: Draft): Promise<ContentPart[]> {
  const tg = new Telegram(env);
  const textLines: string[] = [];
  const images: ContentPart[] = [];
  for (const line of draft.source_text.split("\n")) {
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
  const parts: ContentPart[] = [{ type: "text", text: `${intro[draft.source_type]}\n${textLines.join("\n").trim()}` }];
  return parts.concat(images);
}

/** Builds the card from the draft's sources and shows it (or asks a clarifying question). */
export async function parseDraft(env: Env, draftId: string, now = new Date()): Promise<void> {
  const draft = await getDraft(env.db, draftId);
  if (!draft || draft.state !== "parsing") return;
  const user = await getUserById(env.db, draft.user_id);
  if (!user) return;
  const directory = await listContacts(env.db);
  const raw = await chatJson(env, env.LLM_MODEL, [
    { role: "system", content: cardSystemPrompt(user, directory, now) },
    { role: "user", content: await buildUserContent(env, draft) },
  ]);
  const card = normalizeCard(raw, user, directory);
  if (card.confidence < CONFIDENCE_THRESHOLD) {
    await askClarification(env, user, draft, card);
    return;
  }
  await presentCard(env, user, draft, card, now);
}

export async function editDraft(env: Env, draftId: string, instruction: string, now = new Date()): Promise<void> {
  const draft = await getDraft(env.db, draftId);
  if (!draft?.card || draft.state !== "parsing") return;
  const user = await getUserById(env.db, draft.user_id);
  if (!user) return;
  const directory = await listContacts(env.db);
  const raw = await chatJson(env, env.LLM_MODEL, [
    { role: "system", content: editSystemPrompt(user, directory, now) },
    { role: "user", content: `Картка:\n${cardForEdit(draft.card)}\n\nПравка: ${instruction}` },
  ]);
  const card = normalizeCard(raw, user, directory);
  // An edit never drops the card's confidence below the threshold; the question is still shown.
  if (card.clarify_question) {
    await new Telegram(env).send(user.tg_id, `❓ ${esc(card.clarify_question)}`, { replyTo: draft.card_message_id ?? undefined });
    card.clarify_question = null;
  }
  await presentCard(env, user, draft, card, now);
}

async function askClarification(env: Env, user: User, draft: Draft, card: Card): Promise<void> {
  const question = card.clarify_question ?? "Не зовсім зрозумів. Уточніть, будь ласка: з ким зустріч і коли?";
  await saveCard(env.db, draft.id, card, "clarify");
  const tg = new Telegram(env);
  const html = `❓ ${esc(question)}\n\n<i>Відповідайте звичайним повідомленням.</i>`;
  const keyboard: InlineKeyboard = [[{ text: "✖️ Скасувати", callback_data: `d:${draft.id}:x` }]];
  if (draft.card_message_id) await tg.edit(user.tg_id, draft.card_message_id, html, keyboard);
  else await setCardMessage(env.db, draft.id, (await tg.send(user.tg_id, html, { keyboard })).message_id);
}

function cardKeyboard(draftId: string, card: Card, now: Date): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (cardStart(card)) {
    rows.push([{ text: "✅ Створити", callback_data: `d:${draftId}:c` }]);
    const noEmail = attendeesWithoutEmail(card);
    if (noEmail.length) {
      const names = noEmail.map((a) => a.name ?? "?").join(", ");
      const label = `✅ Створити без: ${names}`;
      rows.push([{ text: label.length > 60 ? `${label.slice(0, 57)}…` : label, callback_data: `d:${draftId}:w` }]);
    }
  } else {
    (card.slots ?? []).forEach((iso, i) => {
      const slot = parseIsoWithOffset(iso);
      if (slot) rows.push([{ text: `🕒 ${slotLabel(slot, now)}`, callback_data: `d:${draftId}:s${i}` }]);
    });
  }
  rows.push([
    { text: "✏️ Змінити", callback_data: `d:${draftId}:e` },
    { text: "✖️ Скасувати", callback_data: `d:${draftId}:x` },
  ]);
  return rows;
}

/** Computes slots / conflicts, renders the card and shows it in place of the previous card message. */
export async function presentCard(env: Env, user: User, draft: Draft, card: Card, now = new Date()): Promise<void> {
  const start = cardStart(card);
  let conflicts: Awaited<ReturnType<typeof listMeetingsBetween>> = [];
  if (start) {
    card.slots = undefined;
    conflicts = await listMeetingsBetween(env.db, user.id, start.getTime(), cardEnd(card)!.getTime());
  } else {
    const busy = await listMeetingsBetween(env.db, user.id, now.getTime(), now.getTime() + 14 * DAY);
    card.slots = findFreeSlots({
      now,
      durationMin: card.duration_min,
      busy: busy.map((m) => ({ start: m.start_at, end: m.end_at })),
      date: card.date,
    }).map((d) => d.toISOString());
  }
  const html = renderCard(card, { now, conflicts });
  const keyboard = cardKeyboard(draft.id, card, now);
  const tg = new Telegram(env);
  let messageId = draft.card_message_id;
  if (messageId) {
    try {
      await tg.edit(user.tg_id, messageId, html, keyboard);
    } catch {
      messageId = null;
    }
  }
  if (!messageId) messageId = (await tg.send(user.tg_id, html, { keyboard })).message_id;
  await saveCard(env.db, draft.id, card, "pending", messageId);
}

// ---------------------------------------------------------------------------------------------------------------
// Card buttons

/** Google event ids allow [a-v0-9]; a stable id derived from the draft makes insert retries idempotent. */
export async function eventIdForDraft(draftId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`draft:${draftId}`)));
  return `ais${Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function insertOrGet(cal: Calendar, body: Record<string, unknown>): Promise<GEvent> {
  try {
    return await cal.insertEvent(body);
  } catch (err) {
    // 409: an earlier attempt already created the event.
    if (err instanceof HttpError && err.status === 409) return cal.getEvent(body.id as string);
    throw err;
  }
}

export async function createFromDraft(env: Env, user: User, draft: Draft, card: Card): Promise<GEvent> {
  const cal = new Calendar(env, user.id);
  const body = { id: await eventIdForDraft(draft.id), ...buildEventBody(card, user, draft.id) };
  const event = await insertOrGet(cal, body);
  const change = eventToChange(event);
  let meetingId: string | null = null;
  if (change.kind === "upsert") {
    meetingId = await upsertMeeting(env.db, user.id, event.id, change.meeting, "bot");
    // A push may have mirrored the event first, as "calendar".
    await markMeetingSource(env.db, meetingId, "bot");
  }
  await markCreated(env.db, draft.id, meetingId);
  // The address book learns names and emails from every created meeting.
  for (const a of card.attendees) if (a.name && a.email) await saveContact(env.db, a.name, a.email);
  return event;
}

function createdHtml(card: Card, event: GEvent, now: Date): string {
  const start = cardStart(card)!;
  const lines = [`✅ <b>Зустріч створена</b>`, "", `<b>${esc(card.title)}</b>`, esc(formatRange(start, cardEnd(card)!, now))];
  if (card.format === "google_meet") lines.push(event.hangoutLink ? `Google Meet: ${esc(event.hangoutLink)}` : "Google Meet");
  else if (card.location) lines.push(`📍 ${esc(card.location)}`);
  const invited = card.attendees.filter((a) => a.email);
  if (invited.length) lines.push("", `Запрошення надіслано на пошту: ${invited.map((a) => esc(a.name ?? a.email)).join(", ")}`);
  return lines.join("\n");
}

/** Handles "d:<draftId>:<action>" callback buttons of the card. Returns the toast text. */
export async function handleCardCallback(
  env: Env,
  user: User,
  draftId: string,
  action: string,
  now = new Date(),
): Promise<string | undefined> {
  const tg = new Telegram(env);
  const draft = await getDraft(env.db, draftId);
  if (!draft || draft.user_id !== user.id) return "Картка не знайдена";
  const messageId = draft.card_message_id;

  if (action === "x") {
    if (!(await transition(env.db, draft.id, ["pending", "editing", "clarify"], "cancelled"))) return "Картка вже неактуальна";
    if (messageId) await tg.edit(user.tg_id, messageId, "✖️ Скасовано. Подію не створено.");
    return "Скасовано";
  }

  if (!draft.card) return "Картка ще готується";

  if (action === "e") {
    if (!(await transition(env.db, draft.id, ["pending", "editing"], "editing"))) return "Картка вже неактуальна";
    await tg.send(user.tg_id, "✏️ Напишіть, що змінити — наприклад: «перенеси на 16:00, прибери Олега, зроби онлайн».", {
      replyTo: messageId ?? undefined,
    });
    return undefined;
  }

  if (action.startsWith("s")) {
    const slot = draft.card.slots?.[Number(action.slice(1))];
    const date = slot ? parseIsoWithOffset(slot) : null;
    if (!date || !["pending", "editing"].includes(draft.state)) return "Слот неактуальний";
    const card: Card = { ...draft.card, start: slot!, date: null };
    await presentCard(env, user, draft, card, now);
    return "Час обрано";
  }

  if (action === "c" || action === "w") {
    let card = draft.card;
    if (action === "w") {
      const dropped = new Set(attendeesWithoutEmail(card));
      card = {
        ...card,
        attendees: card.attendees.filter((a) => !dropped.has(a)),
        missing: card.missing.filter((m) => !/e-?mail|пошт/i.test(m)),
      };
    }
    if (!cardStart(card)) return "Спочатку оберіть час";
    if (!(await transition(env.db, draft.id, ["pending", "editing"], "creating"))) return "Вже обробляється";
    if (!(await hasGoogleAuth(env, user.id))) {
      await transition(env.db, draft.id, ["creating"], "pending");
      await tg.send(user.tg_id, "Календар не підключено.", {
        keyboard: [[{ text: "🔗 Підключити Google Calendar", url: await connectLink(env, user.id) }]],
      });
      return undefined;
    }
    try {
      const event = await createFromDraft(env, user, { ...draft, card }, card);
      const keyboard: InlineKeyboard = event.htmlLink ? [[{ text: "📅 Відкрити в календарі", url: event.htmlLink }]] : [];
      if (messageId) await tg.edit(user.tg_id, messageId, createdHtml(card, event, now), keyboard);
      else await tg.send(user.tg_id, createdHtml(card, event, now), { keyboard });
      return "Створено";
    } catch (err) {
      await transition(env.db, draft.id, ["creating"], "pending");
      if (err instanceof GoogleAuthRevokedError) {
        await forgetGoogleAuth(env, user.id);
        await tg.send(user.tg_id, "⚠️ Доступ до Google Calendar втрачено. Підключіть календар і натисніть «Створити» ще раз.", {
          keyboard: [[{ text: "🔗 Підключити Google Calendar", url: await connectLink(env, user.id) }]],
        });
        return undefined;
      }
      throw err;
    }
  }
  return undefined;
}
