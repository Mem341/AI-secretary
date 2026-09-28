import { exec, one } from "../db/client";
import type { Env } from "../env";
import {
  cancelMeetingByEvent,
  cancelMissingInWindow,
  getMeetingByEvent,
  type Meeting,
  type MeetingInput,
  upsertMeeting,
} from "../db/meetings";
import { linkMessage } from "../db/messageLinks";
import { isSelfWrite } from "../db/selfWrites";
import { randomId, safeEqual } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { DAY, formatRange } from "../lib/time";
import { esc, Telegram } from "../telegram/api";
import { Calendar, type GEvent } from "./calendar";

/** Initial / safety-net sync window (spec 4.1: 30 days ahead). */
export const SYNC_PAST_MS = DAY;
export const SYNC_AHEAD_MS = 30 * DAY;
/** Requested channel lifetime; Google may cap it and returns the real one in `expiration`. */
const CHANNEL_TTL_SECONDS = 7 * 24 * 3600;
/** Channels expiring sooner than this are renewed by the daily cron (spec section 3, step 5). */
export const RENEW_BEFORE_MS = 2 * DAY;

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

const REPLY_HINT = "Відповідайте на це повідомлення, щоб перенести, скасувати чи дізнатись учасників.";

/** Sends an instant notice about a calendar change made outside the bot and links it to the meeting for replies. */
async function notifyOwner(env: Env, meetingId: string | null, html: string): Promise<void> {
  const msg = await new Telegram(env).send(env.OWNER_TELEGRAM_ID, html);
  if (meetingId) await linkMessage(env.db, msg.message_id, "meeting", meetingId);
}

function whereLine(m: Pick<Meeting, "meet_url" | "location">): string | null {
  if (m.meet_url) return `🔗 ${esc(m.meet_url)}`;
  if (m.location) return `📍 ${esc(m.location)}`;
  return null;
}

/**
 * Mirrors one event. With `notify`, a change made OUTSIDE the bot — by the owner in Google Calendar or by a
 * guest (guests may edit) — a new event, a new time or a cancellation, is reported to the owner at once — the "calendar → Telegram" flow. Changes
 * the bot made itself are recognized by their self-write marker and stay silent, as do description/attendee-only
 * edits, to keep the notices meaningful.
 */
export async function applyEvent(env: Env, userId: number, ev: GEvent, notify = false): Promise<void> {
  const change = eventToChange(ev);
  if (change.kind === "skip") return;
  const quiet = !notify || (await isSelfWrite(env.db, ev.id));
  const prior = quiet ? null : await getMeetingByEvent(env.db, userId, ev.id);

  if (change.kind === "cancel") {
    const cancelled = await cancelMeetingByEvent(env.db, userId, ev.id);
    if (cancelled && prior) {
      await notifyOwner(
        env,
        null,
        `❌ <b>Подію скасовано в календарі</b>\n\n<b>${esc(prior.title ?? "без назви")}</b>\n${esc(
          formatRange(new Date(prior.start_at), new Date(prior.end_at)),
        )}`,
      );
    }
    return;
  }

  const { id, inserted } = await upsertMeeting(env.db, userId, ev.id, change.meeting);
  if (quiet) return;
  const m = change.meeting;
  if (inserted) {
    const lines = [`🆕 <b>Нова подія в календарі</b>`, "", `<b>${esc(m.title ?? "без назви")}</b>`, esc(formatRange(new Date(m.start_at), new Date(m.end_at)))];
    const where = whereLine(m);
    if (where) lines.push(where);
    if (m.attendees.length) lines.push(`👥 ${m.attendees.map((a) => esc(a.name ?? a.email)).join(", ")}`);
    lines.push("", REPLY_HINT);
    await notifyOwner(env, id, lines.join("\n"));
    return;
  }
  if (prior && (prior.start_at !== m.start_at || prior.end_at !== m.end_at)) {
    await notifyOwner(
      env,
      id,
      [
        `🔄 <b>Подію перенесено в календарі</b>`,
        "",
        `<b>${esc(m.title ?? "без назви")}</b>`,
        `Було: ${esc(formatRange(new Date(prior.start_at), new Date(prior.end_at)))}`,
        `Стало: ${esc(formatRange(new Date(m.start_at), new Date(m.end_at)))}`,
        "",
        REPLY_HINT,
      ].join("\n"),
    );
  }
}

async function saveSyncToken(env: Env, userId: number, token: string | null): Promise<void> {
  await exec(env.db, "UPDATE watch_channels SET sync_token = $1, last_sync_at = $2, updated_at = $2 WHERE user_id = $3", [
    token,
    Date.now(),
    userId,
  ]);
}

/**
 * Full sync of the [now − 1 day, now + 30 days] window. Used after OAuth and daily as a safety net
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
  await cancelMissingInWindow(env.db, userId, from, to, seen);
  await saveSyncToken(env, userId, syncToken ?? null);
  return seen.size;
}

/** Incremental sync with syncToken after a push (spec section 3, step 3). Falls back to a full sync. */
export async function incrementalSync(env: Env, userId: number): Promise<number> {
  const row = await one<{ sync_token: string | null }>(env.db, "SELECT sync_token FROM watch_channels WHERE user_id = $1", [
    userId,
  ]);
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
        // A push-driven sync: changes made outside the bot are reported to the owner at once.
        await applyEvent(env, userId, ev, true);
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
  const old = await one<{ channel_id: string; resource_id: string }>(
    env.db,
    "SELECT channel_id, resource_id FROM watch_channels WHERE user_id = $1",
    [userId],
  );
  const channelId = crypto.randomUUID();
  const token = randomId(24);
  const channel = await cal.watch(channelId, token, `${env.PUBLIC_URL}/api/gcal-push`, CHANNEL_TTL_SECONDS);
  const expiration = channel.expiration ? Number(channel.expiration) : Date.now() + CHANNEL_TTL_SECONDS * 1000;
  const now = Date.now();
  await exec(
    env.db,
    `INSERT INTO watch_channels (user_id, channel_id, resource_id, token, expiration, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, resource_id = EXCLUDED.resource_id,
       token = EXCLUDED.token, expiration = EXCLUDED.expiration, updated_at = EXCLUDED.updated_at`,
    [userId, channelId, channel.resourceId, token, expiration, now],
  );
  if (old) await cal.stopChannel(old.channel_id, old.resource_id);
}

/** Stops the push channel and drops the sync state (on disconnect). */
export async function stopWatch(env: Env, userId: number): Promise<void> {
  const row = await one<{ channel_id: string; resource_id: string }>(
    env.db,
    "SELECT channel_id, resource_id FROM watch_channels WHERE user_id = $1",
    [userId],
  );
  if (row) await new Calendar(env, userId).stopChannel(row.channel_id, row.resource_id).catch(() => undefined);
  await exec(env.db, "DELETE FROM watch_channels WHERE user_id = $1", [userId]);
}

/** Resolves a push notification to its owner; null for unknown channels or a wrong token. */
export async function channelOwner(env: Env, channelId: string, token: string | null): Promise<number | null> {
  const row = await one<{ user_id: number; token: string }>(env.db, "SELECT user_id, token FROM watch_channels WHERE channel_id = $1", [
    channelId,
  ]);
  if (!row || !token) return null;
  return safeEqual(row.token, token) ? row.user_id : null;
}
