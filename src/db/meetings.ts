import { randomId } from "../lib/crypto";
import { type Db, all, exec, one } from "./client";

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
  db: Db,
  userId: number,
  eventId: string,
  m: MeetingInput,
  source: "bot" | "calendar" = "calendar",
): Promise<string> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO meetings (id, user_id, gcal_event_id, title, description, start_at, end_at, location, meet_url, html_link,
       attendees_json, organizer_email, status, source, gcal_created_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'confirmed', $13, $14, $15, $15)
     ON CONFLICT (user_id, gcal_event_id) DO UPDATE SET
       title = EXCLUDED.title, description = EXCLUDED.description, start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at,
       location = EXCLUDED.location, meet_url = EXCLUDED.meet_url, html_link = EXCLUDED.html_link,
       attendees_json = EXCLUDED.attendees_json, organizer_email = EXCLUDED.organizer_email, status = 'confirmed',
       gcal_created_at = COALESCE(meetings.gcal_created_at, EXCLUDED.gcal_created_at), updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
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
      Date.now(),
    ],
  );
  return row!.id;
}

export async function cancelMeetingByEvent(db: Db, userId: number, eventId: string): Promise<void> {
  await exec(
    db,
    "UPDATE meetings SET status = 'cancelled', updated_at = $1 WHERE user_id = $2 AND gcal_event_id = $3 AND status <> 'cancelled'",
    [Date.now(), userId, eventId],
  );
}

/** After a full window sync: meetings in the window that Google no longer returns are cancelled. */
export async function cancelMissingInWindow(
  db: Db,
  userId: number,
  from: number,
  to: number,
  seenEventIds: Set<string>,
): Promise<number> {
  return exec(
    db,
    `UPDATE meetings SET status = 'cancelled', updated_at = $1
     WHERE user_id = $2 AND status = 'confirmed' AND start_at >= $3 AND start_at < $4 AND NOT (gcal_event_id = ANY($5::text[]))`,
    [Date.now(), userId, from, to, [...seenEventIds]],
  );
}

/** Confirmed meetings overlapping [from, to). */
export async function listMeetingsBetween(db: Db, userId: number, from: number, to: number): Promise<Meeting[]> {
  const rows = await all<MeetingRow>(
    db,
    "SELECT * FROM meetings WHERE user_id = $1 AND status = 'confirmed' AND start_at < $2 AND end_at > $3 ORDER BY start_at",
    [userId, to, from],
  );
  return rows.map(fromRow);
}

export async function markMeetingSource(db: Db, meetingId: string, source: "bot" | "calendar"): Promise<void> {
  await exec(db, "UPDATE meetings SET source = $1 WHERE id = $2", [source, meetingId]);
}
