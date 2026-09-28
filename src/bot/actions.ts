import { createDraft, getDraft, saveCard, transition } from "../db/drafts";
import { getMeetingById, type Meeting, updateMeetingFields } from "../db/meetings";
import { markSelfWrite } from "../db/selfWrites";
import { getUserById, getUserByTgId, modelOf } from "../db/users";
import type { Env } from "../env";
import { Calendar } from "../google/calendar";
import { connectLink, forgetGoogleAuth, GoogleAuthRevokedError, hasGoogleAuth } from "../google/oauth";
import { formatRange, parseIsoWithOffset } from "../lib/time";
import { chatJson } from "../llm/openrouter";
import { actionSystemPrompt } from "../llm/prompts";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";

/** What the owner wants to do with a specific, already-existing meeting (spec 4.7), extended with a reply-driven note. */
export interface MeetingAction {
  action: "reschedule" | "cancel" | "note" | "unclear";
  new_start: string | null;
  new_duration_min: number | null;
  note_text: string | null;
  clarify_question: string | null;
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

/** True and already answered — a factual lookup from the stored record, never guessed by an LLM. */
async function tryAnswerAttendees(env: Env, user: { tg_id: number }, meeting: Meeting, text: string): Promise<boolean> {
  if (!ATTENDEES_RE.test(text)) return false;
  const lines = meeting.attendees.map((a) => {
    const status = { accepted: "прийде", declined: "не прийде", tentative: "можливо", needsAction: "не відповів(ла)" }[
      a.response ?? ""
    ];
    return `• ${esc(a.name ?? a.email)}${status ? ` — ${status}` : ""}`;
  });
  await new Telegram(env).send(
    user.tg_id,
    lines.length ? `👥 <b>Учасники «${esc(meeting.title ?? "зустрічі")}»</b>\n${lines.join("\n")}` : "На цю зустріч ніхто, крім вас, не запрошений.",
  );
  return true;
}

/**
 * Entry point from the router: the owner replied to a message about `meetingId`. Answers "who's attending"
 * immediately; anything else becomes an "action" draft (single-shot — always re-classified from the full text).
 */
export async function startActionDraft(env: Env, user: { id: number; tg_id: number }, chatId: number, meetingId: string, text: string): Promise<void> {
  const meeting = await getMeetingById(env.db, meetingId);
  if (!meeting || meeting.status === "cancelled") {
    await new Telegram(env).send(chatId, "Цю зустріч уже скасовано або видалено з календаря.");
    return;
  }
  if (await tryAnswerAttendees(env, user, meeting, text)) return;
  const draftId = await createDraft(env.db, user.id, "text", text, "parsing", null, { kind: "action", meetingId });
  await new Telegram(env).typing(chatId);
  await env.jobs.send({ type: "action_parse", draftId });
}

function actionKeyboard(draftId: string, hasChoice: boolean): InlineKeyboard {
  const rows: InlineKeyboard = [];
  if (hasChoice) rows.push([{ text: "✅ Так", callback_data: `a:${draftId}:y` }]);
  rows.push([{ text: "✖️ Скасувати", callback_data: `a:${draftId}:x` }]);
  return rows;
}

function renderAction(action: MeetingAction, meeting: Meeting, now: Date): { html: string; hasChoice: boolean } {
  if (action.action === "unclear") {
    return {
      html: `❓ ${esc(action.clarify_question ?? "Уточніть, будь ласка, що зробити із зустріччю.")}\n\n<i>Відповідайте на це повідомлення.</i>`,
      hasChoice: false,
    };
  }
  if (action.action === "reschedule" && action.new_start) {
    const newStart = parseIsoWithOffset(action.new_start)!;
    const duration = action.new_duration_min ?? Math.round((meeting.end_at - meeting.start_at) / 60_000);
    const newEnd = new Date(newStart.getTime() + duration * 60_000);
    return {
      html: [
        `🔄 <b>Перенести «${esc(meeting.title ?? "зустріч")}»?</b>`,
        "",
        `Було: ${esc(formatRange(new Date(meeting.start_at), new Date(meeting.end_at), now))}`,
        `Стане: ${esc(formatRange(newStart, newEnd, now))}`,
      ].join("\n"),
      hasChoice: true,
    };
  }
  if (action.action === "cancel") {
    return {
      html: [
        `❌ <b>Скасувати «${esc(meeting.title ?? "зустріч")}»?</b>`,
        esc(formatRange(new Date(meeting.start_at), new Date(meeting.end_at), now)),
        "",
        "Учасники отримають сповіщення від Google.",
      ].join("\n"),
      hasChoice: true,
    };
  }
  if (action.action === "note" && action.note_text) {
    return { html: `📝 <b>Додати до опису «${esc(meeting.title ?? "зустрічі")}»?</b>\n\n«${esc(action.note_text)}»`, hasChoice: true };
  }
  return { html: "❓ Не вдалося розпізнати, що зробити. Уточніть, будь ласка, звичайним повідомленням.", hasChoice: false };
}

export async function parseActionDraft(env: Env, draftId: string, now = new Date()): Promise<void> {
  const draft = await getDraft(env.db, draftId);
  if (!draft || draft.state !== "parsing" || !draft.meeting_id) return;
  const meeting = await getMeetingById(env.db, draft.meeting_id);
  const owner = { tg_id: env.OWNER_TELEGRAM_ID };
  if (!meeting) {
    await new Telegram(env).send(owner.tg_id, "Цю зустріч уже не знайти в календарі.");
    await transition(env.db, draftId, ["parsing"], "cancelled");
    return;
  }
  const ownerUser = await getUserById(env.db, draft.user_id);
  const raw = await chatJson(env, modelOf(ownerUser!, env.LLM_MODEL), [
    { role: "system", content: actionSystemPrompt(meeting, now) },
    { role: "user", content: draft.source_text },
  ]);
  const action = normalizeAction(raw);
  const { html, hasChoice } = renderAction(action, meeting, now);
  const tg = new Telegram(env);
  const keyboard = actionKeyboard(draftId, hasChoice);
  let messageId = draft.card_message_id;
  if (messageId) {
    try {
      await tg.edit(owner.tg_id, messageId, html, keyboard);
    } catch {
      messageId = null;
    }
  }
  if (!messageId) messageId = (await tg.send(owner.tg_id, html, { keyboard })).message_id;
  await saveCard(env.db, draftId, action, "pending", messageId);
}

async function requireCalendar(env: Env, tgId: number): Promise<boolean> {
  const owner = await getUserByTgId(env.db, tgId);
  return !!owner && (await hasGoogleAuth(env, owner.id));
}

/** Handles "a:<draftId>:<y|x>" callback buttons. Returns the toast text. */
export async function handleActionCallback(env: Env, user: { id: number; tg_id: number }, draftId: string, button: string): Promise<string | undefined> {
  const tg = new Telegram(env);
  const draft = await getDraft(env.db, draftId);
  if (!draft || draft.user_id !== user.id) return "Дію не знайдено";
  const messageId = draft.card_message_id;

  if (button === "x") {
    if (!(await transition(env.db, draft.id, ["pending"], "cancelled"))) return "Уже неактуально";
    if (messageId) await tg.edit(user.tg_id, messageId, "✖️ Скасовано.");
    return "Скасовано";
  }
  if (button !== "y" || !draft.card || !draft.meeting_id) return undefined;
  const action = draft.card as MeetingAction;
  if (!(await transition(env.db, draft.id, ["pending"], "creating"))) return "Вже обробляється";

  const meeting = await getMeetingById(env.db, draft.meeting_id);
  if (!meeting) {
    await transition(env.db, draft.id, ["creating"], "failed");
    if (messageId) await tg.edit(user.tg_id, messageId, "Цю зустріч уже не знайти в календарі.");
    return undefined;
  }
  if (!(await requireCalendar(env, user.tg_id))) {
    await transition(env.db, draft.id, ["creating"], "pending");
    await tg.send(user.tg_id, "Календар не підключено.", { keyboard: [[{ text: "🔗 Підключити Google Calendar", url: await connectLink(env, user.id) }]] });
    return undefined;
  }

  try {
    const cal = new Calendar(env, user.id);
    await markSelfWrite(env.db, meeting.gcal_event_id);
    let resultText = "";
    if (action.action === "reschedule" && action.new_start) {
      const start = parseIsoWithOffset(action.new_start)!;
      const duration = action.new_duration_min ?? Math.round((meeting.end_at - meeting.start_at) / 60_000);
      const end = new Date(start.getTime() + duration * 60_000);
      await cal.patchEvent(meeting.gcal_event_id, {
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      });
      await updateMeetingFields(env.db, meeting.id, { start_at: start.getTime(), end_at: end.getTime() });
      resultText = `✅ Перенесено на ${esc(formatRange(start, end, new Date()))}`;
    } else if (action.action === "cancel") {
      await cal.deleteEvent(meeting.gcal_event_id);
      resultText = "✅ Скасовано. Учасники отримають сповіщення.";
    } else if (action.action === "note" && action.note_text) {
      const description = [meeting.description, action.note_text].filter(Boolean).join("\n\n");
      await cal.patchEvent(meeting.gcal_event_id, { description });
      await updateMeetingFields(env.db, meeting.id, { description });
      resultText = "✅ Додано до опису.";
    } else {
      await transition(env.db, draft.id, ["creating"], "pending");
      return "Немає що підтвердити";
    }
    await transition(env.db, draft.id, ["creating"], "created");
    if (messageId) await tg.edit(user.tg_id, messageId, resultText);
    else await tg.send(user.tg_id, resultText);
    return "Готово";
  } catch (err) {
    await transition(env.db, draft.id, ["creating"], "pending");
    if (err instanceof GoogleAuthRevokedError) {
      await forgetGoogleAuth(env, user.id);
      await tg.send(user.tg_id, "⚠️ Доступ до Google Calendar втрачено. Підключіть календар і спробуйте ще раз.", {
        keyboard: [[{ text: "🔗 Підключити Google Calendar", url: await connectLink(env, user.id) }]],
      });
      return undefined;
    }
    throw err;
  }
}
