import type { Env } from "../env";
import { Calendar, type GEvent } from "../google/calendar";
import { connectLink, forgetGoogleAuth, GoogleAuthRevokedError } from "../google/oauth";
import { type EventRef, eventToChange, type Meeting, PROP_BOT_CANCEL, PROP_START } from "../google/sync";
import { HttpError } from "../lib/http";
import { formatRange, parseIsoWithOffset } from "../lib/time";
import { chatJson } from "../llm/openrouter";
import { actionSystemPrompt } from "../llm/prompts";
import { expectAnswer, mark } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData, readHidden } from "../telegram/hidden";
import type { InlineKeyboard, TgMessage } from "../telegram/types";

/** What the owner wants to do with a specific, already-existing meeting (spec 4.7), extended with a reply-driven note. */
export interface MeetingAction {
  action: "reschedule" | "cancel" | "note" | "unclear";
  new_start: string | null;
  new_duration_min: number | null;
  note_text: string | null;
  clarify_question: string | null;
}

/** Hidden in a clarifying question about an event: the request so far. */
export interface ActionQuestion {
  k: "evq";
  id: string;
  src: string;
}

/** Hidden in a confirmation: the event and what to do with it. */
interface ActionData {
  k: "act";
  id: string;
  a: MeetingAction;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function normalizeAction(raw: unknown): MeetingAction {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const action = r.action === "reschedule" || r.action === "cancel" || r.action === "note" ? r.action : "unclear";
  const newStart = parseIsoWithOffset(r.new_start);
  const duration = Number(r.new_duration_min);
  return {
    action,
    new_start: newStart ? newStart.toISOString() : null,
    new_duration_min: Number.isFinite(duration) && duration >= 5 && duration <= 12 * 60 ? Math.round(duration) : null,
    note_text: str(r.note_text),
    clarify_question: str(r.clarify_question),
  };
}

const ATTENDEES_RE = /хто\s+(буде|прийде|прийдуть|учасник|бере участь)|учасники\s+зустріч/i;

/** The event as a meeting, or null (with the owner told why) when it is gone. */
async function loadMeeting(env: Env, eventId: string): Promise<{ ev: GEvent; meeting: Meeting } | null> {
  const tg = new Telegram(env);
  let ev: GEvent;
  try {
    ev = await new Calendar(env).getEvent(eventId);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) {
      await tg.send(env.OWNER_TELEGRAM_ID, "Цю зустріч уже не знайти в календарі.");
      return null;
    }
    throw err;
  }
  const change = eventToChange(ev);
  if (change.kind !== "upsert") {
    await tg.send(env.OWNER_TELEGRAM_ID, "Цю зустріч уже скасовано або видалено з календаря.");
    return null;
  }
  return { ev, meeting: change.meeting };
}

/** "Хто буде?" — a factual answer from the calendar, never guessed by an LLM. */
async function answerAttendees(env: Env, meeting: Meeting): Promise<void> {
  const lines = meeting.attendees.map((a) => {
    const status = { accepted: "прийде", declined: "не прийде", tentative: "можливо", needsAction: "не відповів(ла)" }[
      a.response ?? ""
    ];
    return `• ${esc(a.name ?? a.email)}${status ? ` — ${status}` : ""}`;
  });
  await new Telegram(env).send(
    env.OWNER_TELEGRAM_ID,
    lines.length ? `👥 <b>Учасники «${esc(meeting.title ?? "зустрічі")}»</b>\n${lines.join("\n")}` : "На цю зустріч ніхто, крім вас, не запрошений.",
  );
}

/**
 * The owner replied to a message about an event. Answers "who's attending" at once; anything else is classified
 * in the background (reschedule / cancel / note) and shown for confirmation.
 */
export async function startAction(env: Env, chatId: number, eventId: string, text: string): Promise<void> {
  if (ATTENDEES_RE.test(text)) {
    const loaded = await loadMeeting(env, eventId);
    if (loaded) await answerAttendees(env, loaded.meeting);
    return;
  }
  await new Telegram(env).typing(chatId);
  await env.jobs.send({ type: "action", eventId, text });
}

function renderAction(action: MeetingAction, meeting: Meeting, now: Date): string | null {
  if (action.action === "reschedule" && action.new_start) {
    const newStart = parseIsoWithOffset(action.new_start)!;
    const duration = action.new_duration_min ?? Math.round((meeting.end_at - meeting.start_at) / 60_000);
    const newEnd = new Date(newStart.getTime() + duration * 60_000);
    return [
      `🔄 <b>Перенести «${esc(meeting.title ?? "зустріч")}»?</b>`,
      "",
      `Було: ${esc(formatRange(new Date(meeting.start_at), new Date(meeting.end_at), now))}`,
      `Стане: ${esc(formatRange(newStart, newEnd, now))}`,
    ].join("\n");
  }
  if (action.action === "cancel") {
    return [
      `❌ <b>Скасувати «${esc(meeting.title ?? "зустріч")}»?</b>`,
      esc(formatRange(new Date(meeting.start_at), new Date(meeting.end_at), now)),
      "",
      "Учасники отримають сповіщення від Google.",
    ].join("\n");
  }
  if (action.action === "note" && action.note_text) {
    return `📝 <b>Додати до опису «${esc(meeting.title ?? "зустрічі")}»?</b>\n\n«${esc(action.note_text)}»`;
  }
  return null;
}

/** Job: classifies the request about the event and asks for confirmation (or a clarification). */
export async function parseAction(env: Env, eventId: string, text: string, now = new Date()): Promise<void> {
  const loaded = await loadMeeting(env, eventId);
  if (!loaded) return;
  const raw = await chatJson(env, env.LLM_MODEL, [
    { role: "system", content: actionSystemPrompt(loaded.meeting, now) },
    { role: "user", content: text },
  ]);
  const action = normalizeAction(raw);
  const tg = new Telegram(env);
  const html = renderAction(action, loaded.meeting, now);
  if (!html) {
    const question: ActionQuestion = { k: "evq", id: eventId, src: text.slice(-1000) };
    await tg.send(
      env.OWNER_TELEGRAM_ID,
      `${hiddenData(question)}❓ ${esc(action.clarify_question ?? "Уточніть, будь ласка, що зробити із зустріччю.")}`,
      { forceReply: "Відповідь" },
    );
    expectAnswer(env.OWNER_TELEGRAM_ID, question);
    return;
  }
  const keyboard: InlineKeyboard = [[{ text: "✅ Так", callback_data: "a:y" }, { text: "✖️ Скасувати", callback_data: "a:x" }]];
  await tg.send(env.OWNER_TELEGRAM_ID, hiddenData({ k: "act", id: eventId, a: action } satisfies ActionData) + html, { keyboard });
}

/** Handles "a:<y|x>" buttons; the action comes from the message they belong to. Returns the toast text. */
export async function handleActionCallback(env: Env, message: TgMessage | undefined, button: string): Promise<string | undefined> {
  const tg = new Telegram(env);
  const data = readHidden<ActionData>(message);
  if (!message || data?.k !== "act") return "Дію не знайдено";
  const chat = env.OWNER_TELEGRAM_ID;

  if (button === "x") {
    await tg.edit(chat, message.message_id, "✖️ Скасовано.");
    return "Скасовано";
  }
  if (button !== "y") return undefined;
  const action = data.a;

  try {
    const loaded = await loadMeeting(env, data.id);
    if (!loaded) {
      await tg.edit(chat, message.message_id, "Цю зустріч уже не знайти в календарі.");
      return undefined;
    }
    const { ev, meeting } = loaded;
    const cal = new Calendar(env);
    const props = ev.extendedProperties?.private ?? {};
    const ref = hiddenData({ k: "ev", id: data.id } satisfies EventRef);
    let resultText: string;
    if (action.action === "reschedule" && action.new_start) {
      const start = parseIsoWithOffset(action.new_start)!;
      const duration = action.new_duration_min ?? Math.round((meeting.end_at - meeting.start_at) / 60_000);
      const end = new Date(start.getTime() + duration * 60_000);
      // The new start is remembered on the event in the same write, so its push is not reported as a change.
      await cal.patchEvent(data.id, {
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        extendedProperties: { private: { ...props, [PROP_START]: String(start.getTime()) } },
      });
      resultText = `${ref}✅ Перенесено на ${esc(formatRange(start, end, new Date()))}`;
    } else if (action.action === "cancel") {
      mark(`bot-cancel:${data.id}`, 10 * 60_000);
      await cal.setPrivate(data.id, { ...props, [PROP_BOT_CANCEL]: "1" }).catch(() => undefined);
      await cal.deleteEvent(data.id);
      resultText = "✅ Скасовано. Учасники отримають сповіщення.";
    } else if (action.action === "note" && action.note_text) {
      const description = [meeting.description, action.note_text].filter(Boolean).join("\n\n");
      await cal.patchEvent(data.id, { description });
      resultText = `${ref}✅ Додано до опису.`;
    } else {
      return "Немає що підтвердити";
    }
    await tg.edit(chat, message.message_id, resultText);
    return "Готово";
  } catch (err) {
    if (err instanceof HttpError && err.status === 410) {
      await tg.edit(chat, message.message_id, "Цю зустріч уже скасовано.");
      return undefined;
    }
    if (err instanceof GoogleAuthRevokedError) {
      await forgetGoogleAuth(env);
      await tg.send(chat, "⚠️ Доступ до Google втрачено. Підключіть його знову і спробуйте ще раз.", {
        keyboard: [[{ text: "🔗 Підключити Google", url: await connectLink(env) }]],
      });
      return undefined;
    }
    throw err;
  }
}
