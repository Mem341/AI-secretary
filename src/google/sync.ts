import type { Env } from "../env";
import { cancelMeetingByEvent, cancelMissingInWindow, type MeetingInput, upsertMeeting } from "../db/meetings";
import { randomId, safeEqual } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { DAY } from "../lib/time";
import { Calendar, type GEvent } from "./calendar";

/** Initial / safety-net sync window (spec 4.1: 30 days ahead). */
export const SYNC_PAST_MS = DAY;
export const SYNC_AHEAD_MS = 30 * DAY;
/** Requested channel lifetime; Google may cap it and returns the real one in `expiration`. */
const CHANNEL_TTL_SECONDS = 7 * 24 * 3600;
/** Channels expiring sooner than this are renewed by the daily cron (spec section 3, step 5). */
export const RENEW_BEFORE_MS = DAY;

export type EventChange = { kind: "skip" } | { kind: "cancel" } | { kind: "upsert"; meeting: MeetingInput };

/**
 * Maps a Google event to a mirror change (spec 4.3): all-day events are ignored, cancelled events and events
 * the owner declined are removed, everything else where the owner is organizer or attendee is mirrored.
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
      gcal_created_at: ev.created ? Date.parse(ev.created) : null,
    },
  };
}

export async function applyEvent(env: Env, userId: number, ev: GEvent): Promise<void> {
  const change = eventToChange(ev);
  if (change.kind === "cancel") await cancelMeetingByEvent(env.DB, userId, ev.id);
  else if (change.kind === "upsert") await upsertMeeting(env.DB, userId, ev.id, change.meeting);
}

async function saveSyncToken(env: Env, userId: number, token: string | null): Promise<void> {
  await env.DB.prepare("UPDATE watch_channels SET sync_token = ?, last_sync_at = ?, updated_at = ? WHERE user_id = ?")
    .bind(token, Date.now(), Date.now(), userId)
    .run();
}

/**
 * Full sync of the [now − 1 day, now + 30 days] window. Used after OAuth and every 6 hours as a safety net
 * for lost pushes; also brings recurring instances that enter the window into the mirror.
 */
export async function fullSync(env: Env, userId: number, now = Date.now()): Promise<number> {
  const cal = new Calendar(env, userId);
  const from = now - SYNC_PAST_MS;
  const to = now + SYNC_AHEAD_MS;
  const seen = new Set<string>();
  let pageToken: string | undefined;
  let syncToken: string | undefined;
  do {
    const page = await cal.listEvents({
      singleEvents: "true",
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const ev of page.items) {
      seen.add(ev.id);
      await applyEvent(env, userId, ev);
    }
    pageToken = page.nextPageToken;
    syncToken = page.nextSyncToken;
  } while (pageToken);
  await cancelMissingInWindow(env.DB, userId, from, to, seen);
  await saveSyncToken(env, userId, syncToken ?? null);
  return seen.size;
}

/** Incremental sync with syncToken after a push (spec section 3, step 3). Falls back to a full sync. */
export async function incrementalSync(env: Env, userId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT sync_token FROM watch_channels WHERE user_id = ?")
    .bind(userId)
    .first<{ sync_token: string | null }>();
  if (!row?.sync_token) return fullSync(env, userId);

  const cal = new Calendar(env, userId);
  let pageToken: string | undefined;
  let syncToken: string | undefined;
  let changed = 0;
  try {
    do {
      const page = await cal.listEvents({
        singleEvents: "true",
        syncToken: row.sync_token,
        maxResults: "250",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const ev of page.items) {
        await applyEvent(env, userId, ev);
        changed++;
      }
      pageToken = page.nextPageToken;
      syncToken = page.nextSyncToken;
    } while (pageToken);
  } catch (err) {
    // 410 Gone: the sync token is invalid, a full sync is required.
    if (err instanceof HttpError && err.status === 410) return fullSync(env, userId);
    throw err;
  }
  if (syncToken) await saveSyncToken(env, userId, syncToken);
  return changed;
}

/**
 * Subscribes to push notifications for the owner's primary calendar (events.watch) and replaces the previous
 * channel, keeping the sync token. Called after OAuth and by the daily renewal cron.
 */
export async function startWatch(env: Env, userId: number): Promise<void> {
  const cal = new Calendar(env, userId);
  const old = await env.DB.prepare("SELECT channel_id, resource_id FROM watch_channels WHERE user_id = ?")
    .bind(userId)
    .first<{ channel_id: string; resource_id: string }>();
  const channelId = crypto.randomUUID();
  const token = randomId(24);
  const channel = await cal.watch(channelId, token, `${env.PUBLIC_URL}/gcal/push`, CHANNEL_TTL_SECONDS);
  const expiration = channel.expiration ? Number(channel.expiration) : Date.now() + CHANNEL_TTL_SECONDS * 1000;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO watch_channels (user_id, channel_id, resource_id, token, expiration, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET channel_id = excluded.channel_id, resource_id = excluded.resource_id,
       token = excluded.token, expiration = excluded.expiration, updated_at = excluded.updated_at`,
  )
    .bind(userId, channelId, channel.resourceId, token, expiration, now)
    .run();
  if (old) await cal.stopChannel(old.channel_id, old.resource_id);
}

/** Stops the push channel and drops the sync state (on disconnect). */
export async function stopWatch(env: Env, userId: number): Promise<void> {
  const row = await env.DB.prepare("SELECT channel_id, resource_id FROM watch_channels WHERE user_id = ?")
    .bind(userId)
    .first<{ channel_id: string; resource_id: string }>();
  if (row) await new Calendar(env, userId).stopChannel(row.channel_id, row.resource_id).catch(() => undefined);
  await env.DB.prepare("DELETE FROM watch_channels WHERE user_id = ?").bind(userId).run();
}

/** Resolves a push notification to its owner; null for unknown channels or a wrong token. */
export async function channelOwner(env: Env, channelId: string, token: string | null): Promise<number | null> {
  const row = await env.DB.prepare("SELECT user_id, token FROM watch_channels WHERE channel_id = ?")
    .bind(channelId)
    .first<{ user_id: number; token: string }>();
  if (!row || !token) return null;
  return safeEqual(row.token, token) ? row.user_id : null;
}
