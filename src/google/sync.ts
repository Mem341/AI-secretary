import { createHash } from "node:crypto";
import type { Env } from "../env";
import { safeEqual } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { DAY, formatRange, MINUTE, toKyivDate } from "../lib/time";
import { firstTime, isMarked } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData } from "../telegram/hidden";
import { Calendar, type GEvent } from "./calendar";

/**
 * Calendar → Telegram, without a database. Google calls /api/gcal-push when the calendar changes; the bot lists
 * the events changed in the last minutes and reports new, moved and cancelled ones. What it already reported is
 * remembered by Google itself: a private property on the owner's copy of each event holds the start time the bot
 * last saw, so a guest's RSVP or a description edit stays silent and a move is shown as "було → стало".
 */

/** Private event properties the bot uses (invisible to guests). */
export const PROP_START = "aisStart";
export const PROP_DRAFT = "aiSecretaryDraft";
export const PROP_BOT_CANCEL = "aisBotCancel";

/** How far back a push looks for changed events; pushes usually arrive within seconds. */
const RECENT_MS = 10 * MINUTE;
/** A push channel lives three days and is renewed daily, so one missed cron changes nothing. */
const CHANNEL_TTL_SECONDS = 3 * 24 * 3600;
export const MARK_AHEAD_MS = 30 * DAY;

export interface Meeting {
  title: string | null;
  description: string | null;
  start_at: number;
  end_at: number;
  location: string | null;
  meet_url: string | null;
  html_link: string | null;
  attendees: { email: string; name: string | null; response: string | null }[];
  organizer_email: string | null;
}

export type EventChange = { kind: "skip" } | { kind: "cancel" } | { kind: "upsert"; meeting: Meeting };

/**
 * Reads a Google event (spec 4.3): all-day events are ignored, cancelled events and events the owner declined
 * count as cancelled, everything else where the owner is organizer or attendee is a meeting.
 */
export function eventToChange(ev: GEvent): EventChange {
  if (ev.status === "cancelled") return { kind: "cancel" };
  if (!ev.start?.dateTime || !ev.end?.dateTime) return ev.start?.date ? { kind: "cancel" } : { kind: "skip" };
  const self = ev.attendees?.find((a) => a.self);
  if (self?.responseStatus === "declined") return { kind: "cancel" };
  if (ev.eventType && !["default", "fromGmail"].includes(ev.eventType)) return { kind: "cancel" };

  const start = Date.parse(ev.start.dateTime);
  const end = Date.parse(ev.end.dateTime);
  if (Number.isNaN(start) || Number.isNaN(end)) return { kind: "skip" };

  const meetUrl =
    ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ?? null;
  return {
    kind: "upsert",
    meeting: {
      title: ev.summary ?? null,
      description: ev.description ?? null,
      start_at: start,
      end_at: end,
      location: ev.location ?? null,
      meet_url: meetUrl,
      html_link: ev.htmlLink ?? null,
      attendees: (ev.attendees ?? [])
        .filter((a) => !a.self)
        .map((a) => ({ email: a.email.toLowerCase(), name: a.displayName ?? null, response: a.responseStatus ?? null })),
      organizer_email: ev.organizer?.email?.toLowerCase() ?? null,
    },
  };
}

/** The owner's meetings overlapping [from, to), straight from Google (free slots, conflicts). */
export async function listMeetings(env: Env, from: number, to: number): Promise<Meeting[]> {
  const cal = new Calendar(env);
  const out: Meeting[] = [];
  let pageToken: string | undefined;
  do {
    const page = await cal.listEvents({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const ev of page.items) {
      const change = eventToChange(ev);
      if (change.kind === "upsert") out.push(change.meeting);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Instant notices

/** Hidden in a notice about an event, so a reply to it acts on that event (bot/actions.ts). */
export interface EventRef {
  k: "ev";
  id: string;
}

const REPLY_HINT = "Відповідайте на це повідомлення, щоб перенести, скасувати чи дізнатись учасників.";

async function notify(env: Env, html: string, eventId: string | null): Promise<void> {
  await new Telegram(env).send(env.OWNER_TELEGRAM_ID, (eventId ? hiddenData({ k: "ev", id: eventId } satisfies EventRef) : "") + html);
}

function whereLine(m: Pick<Meeting, "meet_url" | "location">): string | null {
  if (m.meet_url) return `🔗 ${esc(m.meet_url)}`;
  if (m.location) return `📍 ${esc(m.location)}`;
  return null;
}

/** Remembers on the event (silently) the start time the bot has seen. Failures only cost a repeated notice. */
async function remember(env: Env, ev: GEvent, start: number): Promise<void> {
  await new Calendar(env)
    .setPrivate(ev.id, { ...(ev.extendedProperties?.private ?? {}), [PROP_START]: String(start) })
    .catch((err) => console.warn("gcal: cannot mark event", ev.id, err instanceof Error ? err.message : err));
}

/**
 * Reports one changed event if the change was made outside the bot: a new event, a new time, a cancellation.
 * Recurring instances and past events stay silent. Returns true when a notice was sent.
 */
export async function reportChange(env: Env, ev: GEvent, now = Date.now()): Promise<boolean> {
  if (ev.recurringEventId) return false;
  if (!firstTime(`ev:${ev.id}:${ev.updated ?? ""}`, 30 * MINUTE)) return false;
  const props = ev.extendedProperties?.private ?? {};

  if (ev.status === "cancelled") {
    if (props[PROP_BOT_CANCEL] || isMarked(`bot-cancel:${ev.id}`)) return false;
    // A deleted event is listed with its id only; Google still returns its details on request.
    const full = ev.summary ? ev : await new Calendar(env).getEvent(ev.id).catch(() => ev);
    const fullProps = full.extendedProperties?.private ?? {};
    if (fullProps[PROP_BOT_CANCEL]) return false;
    const start = full.start?.dateTime ? Date.parse(full.start.dateTime) : NaN;
    const end = full.end?.dateTime ? Date.parse(full.end.dateTime) : NaN;
    if (!Number.isNaN(end) && end < now) return false;
    // Only events the bot knew about: an unknown id may be an event that never concerned the owner.
    if (!fullProps[PROP_START] && !fullProps[PROP_DRAFT]) return false;
    const when = Number.isNaN(start) ? "" : `\n${esc(formatRange(new Date(start), new Date(end)))}`;
    await notify(env, `❌ <b>Подію скасовано в календарі</b>\n\n<b>${esc(full.summary ?? "без назви")}</b>${when}`, null);
    return true;
  }

  const change = eventToChange(ev);
  if (change.kind !== "upsert") return false;
  const m = change.meeting;
  if (m.end_at < now) return false;
  const known = props[PROP_START];
  if (known === String(m.start_at)) return false;

  if (!known) {
    // Not seen before. Only a freshly created event is news; an old one is just remembered.
    const created = ev.created ? Date.parse(ev.created) : NaN;
    const updated = ev.updated ? Date.parse(ev.updated) : now;
    const fresh = !Number.isNaN(created) && updated - created < 5 * MINUTE && !props[PROP_DRAFT];
    await remember(env, ev, m.start_at);
    if (!fresh) return false;
    const lines = [`🆕 <b>Нова подія в календарі</b>`, "", `<b>${esc(m.title ?? "без назви")}</b>`, esc(formatRange(new Date(m.start_at), new Date(m.end_at)))];
    const where = whereLine(m);
    if (where) lines.push(where);
    if (m.attendees.length) lines.push(`👥 ${m.attendees.map((a) => esc(a.name ?? a.email)).join(", ")}`);
    lines.push("", REPLY_HINT);
    await notify(env, lines.join("\n"), ev.id);
    return true;
  }

  const before = Number(known);
  const duration = m.end_at - m.start_at;
  await remember(env, ev, m.start_at);
  await notify(
    env,
    [
      `🔄 <b>Подію перенесено в календарі</b>`,
      "",
      `<b>${esc(m.title ?? "без назви")}</b>`,
      `Було: ${esc(formatRange(new Date(before), new Date(before + duration)))}`,
      `Стало: ${esc(formatRange(new Date(m.start_at), new Date(m.end_at)))}`,
      "",
      REPLY_HINT,
    ].join("\n"),
    ev.id,
  );
  return true;
}

/** After a push: reports the events changed in the last minutes. Returns how many notices were sent. */
export async function syncRecent(env: Env, now = Date.now()): Promise<number> {
  const page = await new Calendar(env).listEvents({
    updatedMin: new Date(now - RECENT_MS).toISOString(),
    showDeleted: "true",
    singleEvents: "true",
    maxResults: "50",
  });
  let sent = 0;
  for (const ev of page.items) if (await reportChange(env, ev, now)) sent++;
  return sent;
}

/**
 * Remembers the start time of every upcoming event that the bot has not seen yet, silently (after connecting
 * Google and daily), so that later moves are reported as "було → стало". Returns the number of upcoming events.
 */
export async function markUpcoming(env: Env, now = Date.now()): Promise<number> {
  const cal = new Calendar(env);
  let pageToken: string | undefined;
  let count = 0;
  do {
    const page = await cal.listEvents({
      singleEvents: "true",
      timeMin: new Date(now).toISOString(),
      timeMax: new Date(now + MARK_AHEAD_MS).toISOString(),
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const ev of page.items) {
      const change = eventToChange(ev);
      if (change.kind !== "upsert") continue;
      count++;
      if (ev.recurringEventId || ev.extendedProperties?.private?.[PROP_START] === String(change.meeting.start_at)) continue;
      await remember(env, ev, change.meeting.start_at);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return count;
}

// ---------------------------------------------------------------------------------------------------------------
// Push channel

/** Token Google sends back with every push; derived, so nothing is stored. */
export function channelToken(env: Env): string {
  return createHash("sha256").update(`gcal-push:${env.ENCRYPTION_KEY}`).digest("hex").slice(0, 40);
}

export function isOurChannel(env: Env, channelId: string, token: string | null): boolean {
  return channelId.startsWith("ais-") && safeEqual(token, channelToken(env));
}

function channelIdFor(day: number): string {
  return `ais-${toKyivDate(new Date(day)).replace(/-/g, "")}`;
}

/**
 * Subscribes to push notifications for the owner's primary calendar (events.watch). Channel ids are one per day,
 * so the previous days' channels are stopped by id without remembering them.
 */
export async function startWatch(env: Env, now = Date.now()): Promise<void> {
  const cal = new Calendar(env);
  let resourceId: string | null = null;
  try {
    const channel = await cal.watch(channelIdFor(now), channelToken(env), `${env.PUBLIC_URL}/api/gcal-push`, CHANNEL_TTL_SECONDS);
    resourceId = channel.resourceId;
  } catch (err) {
    // Today's channel already exists (connected twice in a day): it keeps working.
    if (err instanceof HttpError && err.status === 400 && /not unique|already exists/i.test(err.body)) return;
    throw err;
  }
  for (let d = 1; d <= 3; d++) await cal.stopChannel(channelIdFor(now - d * DAY), resourceId);
}
