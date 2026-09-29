import { createHash } from "node:crypto";
import type { Env } from "../env";
import { safeEqual } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { DAY, formatRange, formatTime, kyivParts, MINUTE, toKyivDate } from "../lib/time";
import { firstTime, isMarked } from "../session";
import { esc, Telegram } from "../telegram/api";
import { hiddenData } from "../telegram/hidden";
import type { InlineKeyboard } from "../telegram/types";
import { Calendar, type GAttendee, type GEvent } from "./calendar";
import { applyEmailReminders } from "./reminders";

/**
 * Calendar → Telegram, without a database. Google calls /api/gcal-push when the calendar changes; the bot lists
 * the events changed in the last minutes and reports new, moved and cancelled ones, and guests' answers to the
 * owner's own meetings. What it already reported is remembered by Google itself: private properties on the owner's
 * copy of each event hold the start time and the guests' answers the bot last saw, so a description edit stays
 * silent, a move is shown as "було → стало" and each answer is reported once.
 */

/** Private event properties the bot uses (invisible to guests). */
export const PROP_START = "aisStart";
export const PROP_DRAFT = "aiSecretaryDraft";
export const PROP_BOT_CANCEL = "aisBotCancel";
/** Guests' answers the bot last saw, as "hash:letter,…" (short email hashes keep it under Google's 1024 chars). */
export const PROP_RSVP = "aisRsvp";

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

/** Hidden in a notice about an event, so a reply to it acts on that event (the agents get its id as reply context). */
export interface EventRef {
  k: "ev";
  id: string;
}

const REPLY_HINT = "Відповідайте на це повідомлення, щоб перенести, скасувати чи дізнатись учасників.";

async function notify(env: Env, html: string, eventId: string | null, keyboard?: InlineKeyboard): Promise<void> {
  const hidden = eventId ? hiddenData({ k: "ev", id: eventId } satisfies EventRef) : "";
  await new Telegram(env).send(env.OWNER_TELEGRAM_ID, hidden + html, keyboard ? { keyboard } : {});
}

const WEEKDAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];

function durationText(minutes: number): string {
  if (minutes < 60) return `${minutes} хв`;
  if (minutes === 60) return "1 година";
  return `${Math.floor(minutes / 60)} год${minutes % 60 ? ` ${minutes % 60} хв` : ""}`;
}

/** The n8n "Формат: нова зустріч" notice: an invitation with its organizer, guests' answers and the video link. */
export function invitationNotice(ev: GEvent): string {
  return eventNotice(ev, "📅 <b>Запрошення на зустріч</b>");
}

/**
 * An event in the n8n notice format under `header`: title, date, time and length, organizer, guests with their
 * answers, the video link, place and description. `note` (trusted HTML) goes right under the time.
 */
export function eventNotice(ev: GEvent, header: string, note = ""): string {
  const description = (ev.description ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 500);
  const location = ev.location ?? "";
  const organizer = ev.organizer?.displayName || ev.organizer?.email || "";
  const allDay = !ev.start?.dateTime;
  const start = new Date(ev.start?.dateTime ?? `${ev.start?.date}T00:00:00Z`);
  const endRaw = ev.end?.dateTime;
  const end = endRaw ? new Date(endRaw) : null;
  const [y, mo, d] = (ev.start?.date ?? toKyivDate(start)).split("-");

  let video = ev.hangoutLink ?? "";
  let platform = "";
  if (ev.conferenceData) {
    const ep = (ev.conferenceData.entryPoints ?? []).find((x) => x.entryPointType === "video");
    if (ep) video = ep.uri;
    platform = ev.conferenceData.conferenceSolution?.name ?? "";
  }
  if (!video) {
    const text = `${description} ${location}`;
    const zoom = text.match(/https:\/\/[\w.-]*zoom\.us\/j\/[\w?=&-]+/);
    const meet = text.match(/https:\/\/meet\.google\.com\/[\w-]+/);
    if (zoom) [video, platform] = [zoom[0], "Zoom"];
    else if (meet) [video, platform] = [meet[0], "Google Meet"];
  }

  const guests = (ev.attendees ?? [])
    .filter((a) => !a.self && !a.resource)
    .map((a) => {
      const mark = a.responseStatus === "accepted" ? "✅" : a.responseStatus === "declined" ? "❌" : a.responseStatus === "tentative" ? "❓" : "⏳";
      return `  ${mark} ${esc(a.displayName || a.email.split("@")[0]!)}`;
    });

  let msg = `${header}\n\n`;
  msg += `📌 <b>${esc(ev.summary || "Без назви")}</b>\n📆 ${d}.${mo}.${y} (${WEEKDAYS[kyivParts(start).weekday]})\n`;
  if (allDay) msg += "🕐 Весь день\n";
  else {
    const minutes = end ? Math.round((end.getTime() - start.getTime()) / MINUTE) : 0;
    msg += `🕐 ${formatTime(start)} — ${end ? formatTime(end) : ""}${minutes ? ` (${durationText(minutes)})` : ""}\n`;
  }
  if (note) msg += `\n${note}\n`;
  if (organizer) msg += `\n👤 <b>Організатор:</b> ${esc(organizer)}${ev.organizer?.self ? " (ви)" : ""}\n`;
  if (guests.length) msg += `\n👥 <b>Учасники (${guests.length}):</b>\n${guests.join("\n")}\n`;
  if (video) {
    const name = platform || (video.includes("zoom") ? "Zoom" : "Google Meet");
    msg += `\n🎥 <b>${esc(name)}:</b> <a href="${esc(video)}">Приєднатися</a>\n`;
  }
  if (location && !location.includes("zoom") && !location.includes("meet.google")) msg += `\n📍 <b>Місце:</b> ${esc(location)}\n`;
  if (description && !description.includes("zoom.us") && !description.includes("meet.google")) msg += `\n📝 <b>Опис:</b>\n<i>${esc(description)}</i>\n`;
  return msg.trimEnd();
}

/**
 * Who cancelled. Google does not say who deleted an event, but only its organizer (or someone they let edit it)
 * can cancel it for everyone; the reason, if any, is only in the organizer's email to the guests.
 */
function cancelledBy(ev: GEvent): string {
  if (ev.organizer?.self) return "🗑 <b>Скасовано:</b> у вашому Google Calendar (ви організатор)";
  const who = ev.organizer?.displayName || ev.organizer?.email;
  return who ? `🗑 <b>Скасував організатор:</b> ${esc(who)}` : "🗑 <b>Скасовано організатором</b>";
}

/** ✅ Прийняти / ❌ Відхилити; Telegram limits callback_data to 64 bytes, so an unusually long id gets no buttons. */
export function invitationButtons(eventId: string): InlineKeyboard | undefined {
  if (Buffer.byteLength(`decline:${eventId}`) > 64) return undefined;
  return [[{ text: "✅ Прийняти", callback_data: `accept:${eventId}` }, { text: "❌ Відхилити", callback_data: `decline:${eventId}` }]];
}

type Answer = "accepted" | "declined" | "tentative" | "needsAction";
const LETTER: Record<Answer, string> = { accepted: "a", declined: "d", tentative: "t", needsAction: "n" };

const emailHash = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 7);

/** The guests (not the owner, not rooms) and their answers. */
function guests(ev: GEvent): GAttendee[] {
  return (ev.attendees ?? []).filter((a) => !a.self && !a.resource && a.email);
}

export function rsvpSnapshot(ev: GEvent): string {
  return guests(ev)
    .map((a) => `${emailHash(a.email)}:${LETTER[(a.responseStatus ?? "needsAction") as Answer] ?? "n"}`)
    .join(",")
    .slice(0, 1000);
}

function parseSnapshot(value: string): Map<string, string> {
  return new Map(value.split(",").filter(Boolean).map((x) => x.split(":") as [string, string]));
}

/** Guests whose answer changed since `snapshot` (only real answers: accepted, declined, maybe). */
export function rsvpChanges(ev: GEvent, snapshot: string): GAttendee[] {
  const seen = parseSnapshot(snapshot);
  return guests(ev).filter((a) => {
    const status = (a.responseStatus ?? "needsAction") as Answer;
    return status !== "needsAction" && seen.get(emailHash(a.email)) !== LETTER[status];
  });
}

/** "👥 Відповідь на запрошення": who is coming to the owner's meeting and who is not. */
export function rsvpNotice(ev: GEvent, changed: GAttendee[]): string {
  const start = new Date(ev.start?.dateTime ?? "");
  const end = new Date(ev.end?.dateTime ?? "");
  const [y, mo, d] = toKyivDate(start).split("-");
  const lines = changed.map((a) => {
    const name = esc(a.displayName || a.email);
    if (a.responseStatus === "accepted") return `✅ ${name} — буде`;
    if (a.responseStatus === "declined") return `❌ ${name} — не буде`;
    return `❓ ${name} — можливо`;
  });
  const all = guests(ev);
  const count = (s: string) => all.filter((a) => (a.responseStatus ?? "needsAction") === s).length;
  const summary = [`✅ ${count("accepted")}`, `❌ ${count("declined")}`, `❓ ${count("tentative")}`, `⏳ ${count("needsAction")}`].join(" · ");
  return [
    "👥 <b>Відповідь на запрошення</b>",
    "",
    `📌 <b>${esc(ev.summary || "Без назви")}</b>`,
    `📆 ${d}.${mo}.${y} (${WEEKDAYS[kyivParts(start).weekday]}), 🕐 ${formatTime(start)} — ${formatTime(end)}`,
    "",
    ...lines,
    "",
    `Усього: ${summary}`,
  ].join("\n");
}

/**
 * Remembers on the event (silently) the start time and the guests' answers the bot has seen — as a claim on this
 * version of the event: false when another copy of the bot already handled the same change (then it stays silent).
 */
async function remember(env: Env, ev: GEvent, start: number): Promise<boolean> {
  return new Calendar(env).claimPrivate(ev, { ...(ev.extendedProperties?.private ?? {}), [PROP_START]: String(start), [PROP_RSVP]: rsvpSnapshot(ev) });
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
    const end = full.end?.dateTime ? Date.parse(full.end.dateTime) : NaN;
    if (!Number.isNaN(end) && end < now) return false;
    // Only events the bot knew about: an unknown id may be an event that never concerned the owner.
    if (!fullProps[PROP_START] && !fullProps[PROP_DRAFT]) return false;
    await notify(env, eventNotice(full, "❌ <b>Зустріч скасовано</b>", cancelledBy(full)), null);
    return true;
  }

  const change = eventToChange(ev);
  if (change.kind !== "upsert") return false;
  const m = change.meeting;
  if (m.end_at < now) return false;
  const known = props[PROP_START];
  if (known === String(m.start_at)) {
    // Same time: maybe a guest answered the owner's invitation.
    if (!ev.organizer?.self) return false;
    // An event the bot created starts with nobody answered; an older one is just remembered the first time.
    const snapshot = props[PROP_RSVP] ?? (props[PROP_DRAFT] ? "" : null);
    const changed = snapshot === null ? [] : rsvpChanges(ev, snapshot);
    if (snapshot !== null && (props[PROP_RSVP] ?? "") === rsvpSnapshot(ev)) return false;
    if (!(await remember(env, ev, m.start_at)) || !changed.length) return false;
    await notify(env, rsvpNotice(ev, changed), ev.id);
    return true;
  }

  if (!known) {
    // Not seen before. Only a freshly created event is news; an old one is just remembered.
    const created = ev.created ? Date.parse(ev.created) : NaN;
    const updated = ev.updated ? Date.parse(ev.updated) : now;
    const fresh = !Number.isNaN(created) && updated - created < 5 * MINUTE && !props[PROP_DRAFT];
    if (!(await remember(env, ev, m.start_at))) return false;
    // n8n: an event the owner created is not announced.
    if (!fresh || ev.organizer?.self) return false;
    await notify(env, invitationNotice(ev), ev.id, invitationButtons(ev.id));
    return true;
  }

  const before = Number(known);
  const duration = m.end_at - m.start_at;
  if (!(await remember(env, ev, m.start_at))) return false;
  const was = `⏪ <b>Було:</b> ${esc(formatRange(new Date(before), new Date(before + duration)))}`;
  await notify(env, `${eventNotice(ev, "🔄 <b>Зустріч перенесено</b>", was)}\n\n<i>${REPLY_HINT}</i>`, ev.id);
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
  // A new or moved meeting gets the owner's reminder emails right away (Google then wakes the bot at those minutes).
  await applyEmailReminders(env, page.items, now).catch(() => 0);
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
