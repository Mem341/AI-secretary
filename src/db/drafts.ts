import type { Card } from "../bot/card";
import { randomId } from "../lib/crypto";
import { HOUR } from "../lib/time";

export type SourceType = "text" | "voice" | "forward" | "screenshot";
export type DraftState =
  | "collecting"
  | "parsing"
  | "clarify"
  | "pending"
  | "editing"
  | "creating"
  | "created"
  | "cancelled"
  | "failed";

export interface Draft {
  id: string;
  user_id: number;
  card: Card | null;
  source_type: SourceType;
  source_text: string;
  state: DraftState;
  batch_seq: number;
  card_message_id: number | null;
  edits_count: number;
  meeting_id: string | null;
}

interface DraftRow extends Omit<Draft, "card"> {
  card_json: string | null;
}

/** Drafts waiting for the owner's free-text input stay active for this long. */
export const INPUT_WINDOW_MS = 2 * HOUR;

function fromRow(row: DraftRow | null): Draft | null {
  if (!row) return null;
  const { card_json, ...rest } = row;
  return { ...rest, card: card_json ? (JSON.parse(card_json) as Card) : null };
}

export async function getDraft(db: D1Database, id: string): Promise<Draft | null> {
  return fromRow(await db.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first<DraftRow>());
}

export async function createDraft(
  db: D1Database,
  userId: number,
  sourceType: SourceType,
  sourceText: string,
  state: DraftState,
  cardMessageId: number | null = null,
): Promise<string> {
  const id = randomId(9);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO drafts (id, user_id, source_type, source_text, state, card_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, sourceType, sourceText, state, cardMessageId, now, now)
    .run();
  return id;
}

/**
 * Appends a message to the user's collecting batch (created on first message). Returns the batch sequence
 * number; the batch is processed only by the job carrying the latest number (debounce).
 */
export async function appendToBatch(
  db: D1Database,
  userId: number,
  sourceType: SourceType,
  text: string,
): Promise<{ id: string; seq: number }> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO drafts (id, user_id, source_type, source_text, state, batch_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'collecting', 1, ?, ?)
       ON CONFLICT (user_id) WHERE state = 'collecting' DO UPDATE SET
         source_text = drafts.source_text || char(10) || excluded.source_text,
         source_type = CASE WHEN drafts.source_type = 'forward' THEN 'forward' ELSE excluded.source_type END,
         batch_seq = drafts.batch_seq + 1,
         updated_at = excluded.updated_at
       RETURNING id, batch_seq`,
    )
    .bind(randomId(9), userId, sourceType, text, now, now)
    .first<{ id: string; batch_seq: number }>();
  return { id: row!.id, seq: row!.batch_seq };
}

/** Compare-and-set of the draft state; false when another request changed it first. */
export async function transition(
  db: D1Database,
  id: string,
  from: DraftState[],
  to: DraftState,
  extra: { batchSeq?: number } = {},
): Promise<boolean> {
  const placeholders = from.map(() => "?").join(", ");
  const seqClause = extra.batchSeq === undefined ? "" : " AND batch_seq = ?";
  const binds: unknown[] = [to, Date.now(), id, ...from];
  if (extra.batchSeq !== undefined) binds.push(extra.batchSeq);
  const res = await db
    .prepare(`UPDATE drafts SET state = ?, updated_at = ? WHERE id = ? AND state IN (${placeholders})${seqClause}`)
    .bind(...binds)
    .run();
  return res.meta.changes > 0;
}

export async function saveCard(
  db: D1Database,
  id: string,
  card: Card,
  state: DraftState,
  cardMessageId?: number,
): Promise<void> {
  await db
    .prepare("UPDATE drafts SET card_json = ?, state = ?, card_message_id = COALESCE(?, card_message_id), updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(card), state, cardMessageId ?? null, Date.now(), id)
    .run();
}

export async function setCardMessage(db: D1Database, id: string, messageId: number): Promise<void> {
  await db.prepare("UPDATE drafts SET card_message_id = ?, updated_at = ? WHERE id = ?").bind(messageId, Date.now(), id).run();
}

/** Adds text to the draft's history (clarifications, edits). */
export async function appendSource(db: D1Database, id: string, text: string, isEdit: boolean): Promise<void> {
  await db
    .prepare(
      "UPDATE drafts SET source_text = source_text || char(10) || ?, edits_count = edits_count + ?, updated_at = ? WHERE id = ?",
    )
    .bind(text, isEdit ? 1 : 0, Date.now(), id)
    .run();
}

export async function markCreated(db: D1Database, id: string, meetingId: string | null): Promise<void> {
  await db
    .prepare("UPDATE drafts SET state = 'created', meeting_id = ?, updated_at = ? WHERE id = ?")
    .bind(meetingId, Date.now(), id)
    .run();
}

/** The most recent draft waiting for the owner's text (after "Змінити" or a clarifying question). */
export async function findInputDraft(db: D1Database, userId: number): Promise<Draft | null> {
  return fromRow(
    await db
      .prepare(
        `SELECT * FROM drafts WHERE user_id = ? AND state IN ('editing', 'clarify') AND updated_at > ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(userId, Date.now() - INPUT_WINDOW_MS)
      .first<DraftRow>(),
  );
}

/** A draft whose card the user replied to. */
export async function findDraftByMessage(db: D1Database, userId: number, messageId: number): Promise<Draft | null> {
  return fromRow(
    await db
      .prepare(
        `SELECT * FROM drafts WHERE user_id = ? AND card_message_id = ? AND state IN ('pending', 'editing', 'clarify')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(userId, messageId)
      .first<DraftRow>(),
  );
}

/** Drops the waiting-for-input state (e.g. /cancel). */
export async function cancelInputDrafts(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare("UPDATE drafts SET state = 'cancelled', updated_at = ? WHERE user_id = ? AND state IN ('editing', 'clarify', 'collecting')")
    .bind(Date.now(), userId)
    .run();
}
