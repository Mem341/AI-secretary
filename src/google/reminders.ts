import { reminderMarks } from "../bot/settings";
import type { Env } from "../env";
import { DAY, formatRange, kyivLocalToDate, kyivParts, MINUTE } from "../lib/time";
import { firstTime } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData } from "../telegram/hidden";
import { Calendar, type GEvent } from "./calendar";
import { loadOwnerSettings, type OwnerSettings } from "./oauth";
import { wakeReady } from "./pubsub";
import { signalCalendar, signalTarget, syncSignals } from "./signals";
import { type GMessage, Gmail, toMailMessage } from "./gmail";
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
    if (mark === null) continue;
    if (await sendReminder(env, cal, tg, ev, m, mark, now)) {
      check.sent++;
      seen.sentNow = mark;
    }
  }
  return check;
}

/** One reminder, claimed first on the event so it goes out once whatever woke the bot (a reminder email, a check). */
async function sendReminder(env: Env, cal: Calendar, tg: Telegram, ev: GEvent, m: Meeting, mark: number, now: number): Promise<boolean> {
  if (!firstTime(`remind:${ev.id}:${m.start_at}:${mark}`, DAY)) return false;
  const props = ev.extendedProperties?.private ?? {};
  // Recurring instances are not marked (that would turn each into an exception); the instance memory covers them.
  if (!ev.recurringEventId && !(await cal.claimPrivate(ev, { ...props, [PROP_REMINDED]: `${m.start_at}:${mark}` }))) return false;
  const minutes = Math.max(1, Math.round((m.start_at - now) / MINUTE));
  const lines = [`⏰ <b>Через ${minutes} хв:</b> ${esc(m.title ?? "зустріч")}`, esc(formatRange(new Date(m.start_at), new Date(m.end_at)))];
  if (m.meet_url) lines.push(`🔗 ${esc(m.meet_url)}`);
  else if (m.location) lines.push(`📍 ${esc(m.location)}`);
  if (m.attendees.length) lines.push(`👥 ${m.attendees.map((a) => esc(a.name ?? a.email)).join(", ")}`);
  await tg.send(env.OWNER_TELEGRAM_ID, hiddenData({ k: "ev", id: ev.id } satisfies EventRef) + lines.join("\n"));
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Google itself as the clock: no cron, no outside service.
//
// Every upcoming meeting gets the owner's own Google reminders "by email" at the chosen minutes. At that minute
// Google sends the email; Gmail pushes the bot at once (google/pubsub.ts); the bot recognises the calendar's reminder
// email, sends the Telegram reminder and moves the email to Trash.

/** Where reminders go: Telegram (t) and Google Calendar's own notifications (c). Both by default. */
export interface Channels {
  t: boolean;
  c: boolean;
}

export async function reminderChannels(env: Env): Promise<Channels> {
  const s = await loadOwnerSettings(env).catch((): OwnerSettings => ({}));
  return { t: s.n?.t ?? true, c: s.n?.c ?? true };
}

const emails = (marks: number[]) => marks.slice(0, 5).map((minutes) => ({ method: "email", minutes }));
const popups = (marks: number[]) => marks.slice(0, 5).map((minutes) => ({ method: "popup", minutes }));

/**
 * The owner's reminders on a meeting itself. With the signal calendar the meeting carries only Calendar notifications
 * (popups) and the Telegram signals live on its shadow. Without it (no permission yet) the 5 places Google allows are
 * shared: an email signal per mark for Telegram first, then popups for the marks nearest to the start.
 */
export function desiredReminders(marks: number[], ch: Channels = { t: true, c: true }, signalCalendar = false): NonNullable<GEvent["reminders"]> {
  if (!marks.length) return { useDefault: true };
  if (signalCalendar) return { useDefault: false, overrides: ch.c ? popups(marks) : [] };
  const overrides = ch.t ? emails(marks) : [];
  if (ch.c) for (const m of [...marks].sort((x, y) => x - y)) if (overrides.length < 5) overrides.push({ method: "popup", minutes: m });
  return { useDefault: false, overrides };
}

const reminderKey = (r: GEvent["reminders"]) =>
  r?.useDefault ? "default" : JSON.stringify([...(r?.overrides ?? [])].map((o) => `${o.method}:${o.minutes}`).sort());

/**
 * Puts the owner's reminders on the upcoming meetings (next 8 days; a recurring series once, on its master) and keeps
 * their Telegram signals in the bot's signal calendar in step: new or moved meetings get a shadow, cancelled ones lose
 * it. `events` = only these (a calendar push); none = the whole coming week (also removes stale shadows). Only
 * changes what differs. Returns how many writes were made.
 */
export async function applyEmailReminders(env: Env, events?: GEvent[], now = Date.now()): Promise<number> {
  const marks = await reminderMarks(env);
  const ch = await reminderChannels(env);
  const cal = new Calendar(env);
  const list =
    events ??
    (
      await cal.listEvents({
        singleEvents: "true",
        orderBy: "startTime",
        timeMin: new Date(now).toISOString(),
        timeMax: new Date(now + 8 * DAY).toISOString(),
        maxResults: "250",
      })
    ).items;
  // Telegram signals need Google to wake the bot; Calendar notifications work without it.
  const telegram = ch.t && marks.length > 0 && (await wakeReady(env));
  const signals = telegram ? await signalCalendar(env) : null;
  const want = desiredReminders(marks, { t: telegram, c: ch.c }, !!signals);
  const done = new Set<string>();
  const upcoming: { ev: GEvent; start: number; end: number }[] = [];
  let changed = 0;
  for (const ev of list) {
    const change = eventToChange(ev);
    if (change.kind !== "upsert" || change.meeting.end_at < now) continue;
    upcoming.push({ ev, start: change.meeting.start_at, end: change.meeting.end_at });
    const target = ev.recurringEventId ?? ev.id;
    if (done.has(target)) continue;
    done.add(target);
    if (reminderKey(ev.reminders) === reminderKey(want)) continue;
    await cal
      .setReminders(target, want)
      .then(() => changed++)
      .catch((err) => console.warn("gcal: cannot set reminders", target, err instanceof Error ? err.message : err));
  }
  if (signals) {
    const gone = list.filter((ev) => eventToChange(ev).kind !== "upsert").map((ev) => ev.id);
    changed += await syncSignals(env, signals, upcoming, gone, marks, !events, now).catch((err) => {
      console.warn("signals:", err instanceof Error ? err.message : err);
      return 0;
    });
  }
  return changed;
}

/** All text of an email, every part decoded (the calendar's link with the event id is in there). */
function allText(part: GMessage["payload"]): string {
  if (!part) return "";
  const own = part.body?.data ? Buffer.from(part.body.data, "base64url").toString("utf8") : "";
  return [own, ...(part.parts ?? []).map(allText)].join("\n");
}

const REMINDER_SUBJECT = /^(notification|reminder|уведомление|напоминание|сповіщення|нагадування|powiadomienie|benachrichtigung)(?=$|[\s:])/i;

/** The event id from a Google Calendar email: its links carry eid = base64("<event id> <calendar>"). */
export function eventIdFromEmail(m: GMessage): string | null {
  for (const eid of allText(m.payload).matchAll(/[?&]eid=([A-Za-z0-9_-]+)/g)) {
    const decoded = Buffer.from(eid[1]!, "base64url").toString("utf8");
    const id = decoded.split(" ")[0];
    if (id && /^[a-z0-9_]+$/i.test(id)) return id;
  }
  return null;
}

/**
 * A new email that is the calendar's own reminder: sends the Telegram reminder instead of a "new mail" notice and
 * moves the email to Trash. False when it is any other email.
 */
export async function handleReminderEmail(env: Env, m: GMessage, now = Date.now()): Promise<boolean> {
  const mail = toMailMessage(m);
  if (!/calendar-notification@google\.com/i.test(mail.from) || !REMINDER_SUBJECT.test(mail.subject.trim())) return false;
  const id = eventIdFromEmail(m);
  if (!id) return false;
  const cal = new Calendar(env);
  // A signal (the shadow in the bot's signal calendar) stands for the owner's meeting.
  const ev = await cal.getEvent((await signalTarget(env, id)) ?? id).catch(() => null);
  const change = ev ? eventToChange(ev) : null;
  if (ev && change?.kind === "upsert" && change.meeting.start_at > now - 5 * MINUTE) {
    const marks = await reminderMarks(env);
    const left = change.meeting.start_at - now;
    // The mark this email stands for: the smallest chosen one not below the time left.
    const mark = marks.filter((x) => left <= x * MINUTE + EARLY).sort((a, b) => a - b)[0] ?? Math.max(1, Math.round(left / MINUTE));
    await sendReminder(env, cal, new Telegram(env), ev, change.meeting, mark, now);
  }
  await new Gmail(env).trash(m.id).catch(() => undefined);
  return true;
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
