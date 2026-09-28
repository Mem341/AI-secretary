import { randomId } from "../lib/crypto";

export interface MeetingAttendee {
  email: string;
  name: string | null;
  response: string | null;
}

export interface Meeting {
  id: string;
  user_id: number;
  gcal_event_id: string;
  title: string | null;
  description: string | null;
  start_at: number;
  end_at: number;
  location: string | null;
  meet_url: string | null;
  html_link: string | null;
  attendees: MeetingAttendee[];
  organizer_email: string | null;
  status: "confirmed" | "cancelled";
  source: "bot" | "calendar";
  gcal_created_at: number | null;
}

export type MeetingInput = Omit<Meeting, "id" | "user_id" | "gcal_event_id" | "status" | "source">;

interface MeetingRow extends Omit<Meeting, "attendees"> {
  attendees_json: string;
}

function fromRow(row: MeetingRow): Meeting {
  const { attendees_json, ...rest } = row;
  return { ...rest, attendees: JSON.parse(attendees_json) as MeetingAttendee[] };
}

/** Inserts or updates the mirror of a calendar event; returns the meeting id. */
export async function upsertMeeting(
  db: D1Database,
  userId: number,
  eventId: string,
  m: MeetingInput,
  source: "bot" | "calendar" = "calendar",
): Promise<string> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO meetings (id, user_id, gcal_event_id, title, description, start_at, end_at, location, meet_url, html_link,
         attendees_json, organizer_email, status, source, gcal_created_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)
       ON CONFLICT (user_id, gcal_event_id) DO UPDATE SET
         title = excluded.title, description = excluded.description, start_at = excluded.start_at, end_at = excluded.end_at,
         location = excluded.location, meet_url = excluded.meet_url, html_link = excluded.html_link,
         attendees_json = excluded.attendees_json, organizer_email = excluded.organizer_email, status = 'confirmed',
         gcal_created_at = COALESCE(meetings.gcal_created_at, excluded.gcal_created_at), updated_at = excluded.updated_at
       RETURNING id`,
    )
    .bind(
      randomId(),
      userId,
      eventId,
      m.title,
      m.description,
      m.start_at,
      m.end_at,
      m.location,
      m.meet_url,
      m.html_link,
      JSON.stringify(m.attendees),
      m.organizer_email,
      source,
      m.gcal_created_at,
      now,
      now,
    )
    .first<{ id: string }>();
  return row!.id;
}

export async function cancelMeetingByEvent(db: D1Database, userId: number, eventId: string): Promise<void> {
  await db
    .prepare("UPDATE meetings SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND gcal_event_id = ? AND status != 'cancelled'")
    .bind(Date.now(), userId, eventId)
    .run();
}

/** After a full window sync: meetings in the window that Google no longer returns are cancelled. */
export async function cancelMissingInWindow(
  db: D1Database,
  userId: number,
  from: number,
  to: number,
  seenEventIds: Set<string>,
): Promise<number> {
  const { results } = await db
    .prepare("SELECT gcal_event_id FROM meetings WHERE user_id = ? AND status = 'confirmed' AND start_at >= ? AND start_at < ?")
    .bind(userId, from, to)
    .all<{ gcal_event_id: string }>();
  const missing = results.map((r) => r.gcal_event_id).filter((id) => !seenEventIds.has(id));
  for (const id of missing) await cancelMeetingByEvent(db, userId, id);
  return missing.length;
}

/** Confirmed meetings overlapping [from, to). */
export async function listMeetingsBetween(db: D1Database, userId: number, from: number, to: number): Promise<Meeting[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM meetings WHERE user_id = ? AND status = 'confirmed' AND start_at < ? AND end_at > ? ORDER BY start_at",
    )
    .bind(userId, to, from)
    .all<MeetingRow>();
  return results.map(fromRow);
}

export async function markMeetingSource(db: D1Database, meetingId: string, source: "bot" | "calendar"): Promise<void> {
  await db.prepare("UPDATE meetings SET source = ? WHERE id = ?").bind(source, meetingId).run();
}
