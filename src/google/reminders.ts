import { formatAgenda } from "../bot/agenda";
import type { Env } from "../env";
import { DAY, formatRange, kyivLocalToDate, kyivParts, MINUTE } from "../lib/time";
import { firstTime } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData } from "../telegram/hidden";
import { Calendar } from "./calendar";
import { type EventRef, eventToChange, listMeetings } from "./sync";

/** Private event property: the start time the bot already sent a reminder for (a moved meeting is reminded again). */
export const PROP_REMINDED = "aisReminded";

/**
 * Telegram reminders REMINDER_MINUTES before each meeting. Called by /api/cron/reminders every few minutes (a
 * frequent cron: Vercel Pro, or any free pinger). Nothing is stored: a reminded event gets a private property.
 */
export async function sendReminders(env: Env, now = Date.now()): Promise<number> {
  const cal = new Calendar(env);
  const window = env.REMINDER_MINUTES * MINUTE;
  const page = await cal.listEvents({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + window).toISOString(),
    maxResults: "50",
  });
  const tg = new Telegram(env);
  let sent = 0;
  for (const ev of page.items) {
    const change = eventToChange(ev);
    if (change.kind !== "upsert") continue;
    const m = change.meeting;
    if (m.start_at < now || m.start_at > now + window) continue;
    const props = ev.extendedProperties?.private ?? {};
    if (props[PROP_REMINDED] === String(m.start_at) || !firstTime(`remind:${ev.id}:${m.start_at}`, DAY)) continue;
    const minutes = Math.max(1, Math.round((m.start_at - now) / MINUTE));
    const lines = [`⏰ <b>Через ${minutes} хв:</b> ${esc(m.title ?? "зустріч")}`, esc(formatRange(new Date(m.start_at), new Date(m.end_at)))];
    if (m.meet_url) lines.push(`🔗 ${esc(m.meet_url)}`);
    else if (m.location) lines.push(`📍 ${esc(m.location)}`);
    if (m.attendees.length) lines.push(`👥 ${m.attendees.map((a) => esc(a.name ?? a.email)).join(", ")}`);
    await tg.send(env.OWNER_TELEGRAM_ID, hiddenData({ k: "ev", id: ev.id } satisfies EventRef) + lines.join("\n"));
    sent++;
    // Recurring instances are not marked (that would turn each into an exception); the instance memory covers them.
    if (!ev.recurringEventId) await cal.setPrivate(ev.id, { ...props, [PROP_REMINDED]: String(m.start_at) }).catch(() => undefined);
  }
  return sent;
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
