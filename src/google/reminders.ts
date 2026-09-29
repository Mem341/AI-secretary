import { reminderMarks } from "../bot/settings";
import type { Env } from "../env";
import { DAY, formatRange, kyivLocalToDate, kyivParts, MINUTE } from "../lib/time";
import { firstTime } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData } from "../telegram/hidden";
import { Calendar } from "./calendar";
import { type EventRef, eventToChange, listMeetings, type Meeting } from "./sync";

export function formatAgenda(meetings: Meeting[], now: Date): string {
  return meetings
    .map((m) => {
      const where = m.meet_url ? " · онлайн" : m.location ? ` · ${esc(m.location)}` : "";
      return `• <b>${esc(formatRange(new Date(m.start_at), new Date(m.end_at), now))}</b> — ${esc(m.title ?? "без назви")}${where}`;
    })
    .join("\n");
}

/**
 * Private event property: "start:minutes" of the last reminder sent (e.g. "1790000000000:10"). A moved meeting has
 * another start, so it is reminded again.
 */
export const PROP_REMINDED = "aisReminded";

/** A pinger every 5 minutes rarely hits the exact minute: a reminder may go out this much early. */
const EARLY = 2 * MINUTE;

/**
 * Which reminder is due now: the nearest REMINDER_MINUTES mark already reached, if it was not sent yet. With
 * [30, 10]: 27 min left → 30; 8 min left → 10; a meeting added 5 min before its start gets just the 10-minute one.
 */
export function dueReminder(marks: number[], left: number, lastSent: number | null): number | null {
  const reached = marks.filter((m) => left <= m * MINUTE + EARLY);
  if (!reached.length) return null;
  const mark = Math.min(...reached);
  return lastSent !== null && lastSent <= mark ? null : mark;
}

/**
 * Telegram reminders REMINDER_MINUTES (30 and 10 by default) before each meeting — plain code, no AI. Called by
 * /api/cron/reminders every 5 minutes (any free pinger such as cron-job.org, or a Vercel Pro cron). Nothing is
 * stored: a reminded event gets a private property.
 */
export interface ReminderCheck {
  marks: number[];
  sent: number;
  /** Meetings in the reminder window, for the check's answer: title, minutes left, what was sent. */
  upcoming: { title: string; minutesLeft: number; sentNow: number | null }[];
}

export async function sendReminders(env: Env, now = Date.now()): Promise<number> {
  return (await checkReminders(env, now)).sent;
}

/** Sends the due reminders and says what it saw — /api/cron/reminders shows this, so a pinger's log explains itself. */
export async function checkReminders(env: Env, now = Date.now()): Promise<ReminderCheck> {
  // The owner's choice from /settings, else REMINDER_MINUTES.
  const marks = await reminderMarks(env);
  const check: ReminderCheck = { marks, sent: 0, upcoming: [] };
  if (!marks.length) return check;
  const cal = new Calendar(env);
  const window = Math.max(...marks) * MINUTE + EARLY;
  const page = await cal.listEvents({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + window).toISOString(),
    maxResults: "50",
  });
  const tg = new Telegram(env);
  for (const ev of page.items) {
    const change = eventToChange(ev);
    if (change.kind !== "upsert") continue;
    const m = change.meeting;
    if (m.start_at < now || m.start_at > now + window) continue;
    const props = ev.extendedProperties?.private ?? {};
    const [sentFor, sentMark] = (props[PROP_REMINDED] ?? "").split(":");
    // Before marks existed the property held the start only: that reminder counts as the first (largest) mark.
    const lastSent = sentFor === String(m.start_at) ? Number(sentMark ?? Math.max(...marks)) : null;
    const mark = dueReminder(marks, m.start_at - now, lastSent);
    const seen = { title: m.title ?? "зустріч", minutesLeft: Math.round((m.start_at - now) / MINUTE), sentNow: null as number | null };
    check.upcoming.push(seen);
    if (mark === null || !firstTime(`remind:${ev.id}:${m.start_at}:${mark}`, DAY)) continue;
    const minutes = Math.max(1, Math.round((m.start_at - now) / MINUTE));
    const lines = [`⏰ <b>Через ${minutes} хв:</b> ${esc(m.title ?? "зустріч")}`, esc(formatRange(new Date(m.start_at), new Date(m.end_at)))];
    if (m.meet_url) lines.push(`🔗 ${esc(m.meet_url)}`);
    else if (m.location) lines.push(`📍 ${esc(m.location)}`);
    if (m.attendees.length) lines.push(`👥 ${m.attendees.map((a) => esc(a.name ?? a.email)).join(", ")}`);
    // Marked first, as a claim on this version of the event: two checks running at once send it only once.
    // Recurring instances are not marked (that would turn each into an exception); the instance memory covers them.
    if (!ev.recurringEventId && !(await cal.claimPrivate(ev, { ...props, [PROP_REMINDED]: `${m.start_at}:${mark}` }))) continue;
    await tg.send(env.OWNER_TELEGRAM_ID, hiddenData({ k: "ev", id: ev.id } satisfies EventRef) + lines.join("\n"));
    check.sent++;
    seen.sentNow = mark;
  }
  return check;
}

/** Morning digest from the daily cron: today's remaining meetings. Nothing is sent on an empty day. */
export async function sendDigest(env: Env, now = Date.now()): Promise<boolean> {
  const p = kyivParts(new Date(now));
  const endOfDay = kyivLocalToDate(p.year, p.month, p.day).getTime() + DAY;
  const meetings = await listMeetings(env, now, endOfDay);
  if (!meetings.length) return false;
  await new Telegram(env).send(env.OWNER_TELEGRAM_ID, `☀️ <b>Сьогодні у вас ${meetings.length} ${meetings.length === 1 ? "зустріч" : meetings.length < 5 ? "зустрічі" : "зустрічей"}:</b>\n\n${formatAgenda(meetings, new Date(now))}`);
  return true;
}
