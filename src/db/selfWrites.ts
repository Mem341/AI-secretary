import { type Db, exec, one } from "./client";

/** How long a self-write marker suppresses the echoing push notification. Comfortably longer than Google's push latency. */
const SELF_WRITE_TTL_MS = 2 * 60_000;

/**
 * Marks a Google Calendar event the bot is about to write (create/reschedule/cancel), so the push notification
 * Google sends back for that very write is not mistaken for a change made outside the bot. Call this BEFORE the
 * Calendar API request, so the marker is in place no matter how fast the push arrives.
 */
export async function markSelfWrite(db: Db, gcalEventId: string): Promise<void> {
  await exec(
    db,
    `INSERT INTO recent_writes (gcal_event_id, until) VALUES ($1, $2)
     ON CONFLICT (gcal_event_id) DO UPDATE SET until = EXCLUDED.until`,
    [gcalEventId, Date.now() + SELF_WRITE_TTL_MS],
  );
}

export async function isSelfWrite(db: Db, gcalEventId: string): Promise<boolean> {
  return !!(await one(db, "SELECT 1 FROM recent_writes WHERE gcal_event_id = $1 AND until > $2", [gcalEventId, Date.now()]));
}

/** Drops expired markers; called from the daily cron so the table does not grow without bound. */
export async function pruneSelfWrites(db: Db): Promise<void> {
  await exec(db, "DELETE FROM recent_writes WHERE until < $1", [Date.now()]);
}
