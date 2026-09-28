import type { Card } from "../bot/card";
import { randomId } from "../lib/crypto";
import { type Db, exec, one } from "./client";
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

export async function getDraft(db: Db, id: string): Promise<Draft | null> {
  return fromRow(await one<DraftRow>(db, "SELECT * FROM drafts WHERE id = $1", [id]));
}

export async function createDraft(
  db: Db,
  userId: number,
  sourceType: SourceType,
  sourceText: string,
  state: DraftState,
  cardMessageId: number | null = null,
): Promise<string> {
  const id = randomId(9);
  const now = Date.now();
  await exec(
    db,
    `INSERT INTO drafts (id, user_id, source_type, source_text, state, card_message_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [id, userId, sourceType, sourceText, state, cardMessageId, now],
  );
  return id;
}

/**
 * Appends a message to the user's collecting batch (created on first message). Returns the batch sequence
 * number; the batch is processed only by the job carrying the latest number (debounce).
 */
export async function appendToBatch(
  db: Db,
  userId: number,
  sourceType: SourceType,
  text: string,
): Promise<{ id: string; seq: number }> {
  const now = Date.now();
  const row = await one<{ id: string; batch_seq: number }>(
    db,
    `INSERT INTO drafts (id, user_id, source_type, source_text, state, batch_seq, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'collecting', 1, $5, $5)
     ON CONFLICT (user_id) WHERE state = 'collecting' DO UPDATE SET
       source_text = drafts.source_text || chr(10) || EXCLUDED.source_text,
       source_type = CASE WHEN drafts.source_type = 'forward' THEN 'forward' ELSE EXCLUDED.source_type END,
       batch_seq = drafts.batch_seq + 1,
       updated_at = EXCLUDED.updated_at
     RETURNING id, batch_seq`,
    [randomId(9), userId, sourceType, text, now],
  );
  return { id: row!.id, seq: row!.batch_seq };
}

/** Compare-and-set of the draft state; false when another request changed it first. */
export async function transition(
  db: Db,
  id: string,
  from: DraftState[],
  to: DraftState,
  extra: { batchSeq?: number } = {},
): Promise<boolean> {
  const binds: unknown[] = [to, Date.now(), id, from];
  let seqClause = "";
  if (extra.batchSeq !== undefined) {
    binds.push(extra.batchSeq);
    seqClause = ` AND batch_seq = $${binds.length}`;
  }
  const changed = await exec(
    db,
    `UPDATE drafts SET state = $1, updated_at = $2 WHERE id = $3 AND state = ANY($4::text[])${seqClause}`,
    binds,
  );
  return changed > 0;
}

export async function saveCard(
  db: Db,
  id: string,
  card: Card,
  state: DraftState,
  cardMessageId?: number,
): Promise<void> {
  await exec(
    db,
    "UPDATE drafts SET card_json = $1, state = $2, card_message_id = COALESCE($3, card_message_id), updated_at = $4 WHERE id = $5",
    [JSON.stringify(card), state, cardMessageId ?? null, Date.now(), id],
  );
}

export async function setCardMessage(db: Db, id: string, messageId: number): Promise<void> {
  await exec(db, "UPDATE drafts SET card_message_id = $1, updated_at = $2 WHERE id = $3", [messageId, Date.now(), id]);
}

/** Adds text to the draft's history (clarifications, edits). */
export async function appendSource(db: Db, id: string, text: string, isEdit: boolean): Promise<void> {
  await exec(
    db,
    "UPDATE drafts SET source_text = source_text || chr(10) || $1, edits_count = edits_count + $2, updated_at = $3 WHERE id = $4",
    [text, isEdit ? 1 : 0, Date.now(), id],
  );
}

export async function markCreated(db: Db, id: string, meetingId: string | null): Promise<void> {
  await exec(db, "UPDATE drafts SET state = 'created', meeting_id = $1, updated_at = $2 WHERE id = $3", [
    meetingId,
    Date.now(),
    id,
  ]);
}

/** The most recent draft waiting for the owner's text (after "Змінити" or a clarifying question). */
export async function findInputDraft(db: Db, userId: number): Promise<Draft | null> {
  return fromRow(
    await one<DraftRow>(
      db,
      `SELECT * FROM drafts WHERE user_id = $1 AND state IN ('editing', 'clarify') AND updated_at > $2
       ORDER BY updated_at DESC LIMIT 1`,
      [userId, Date.now() - INPUT_WINDOW_MS],
    ),
  );
}

/** A draft whose card the user replied to. */
export async function findDraftByMessage(db: Db, userId: number, messageId: number): Promise<Draft | null> {
  return fromRow(
    await one<DraftRow>(
      db,
      `SELECT * FROM drafts WHERE user_id = $1 AND card_message_id = $2 AND state IN ('pending', 'editing', 'clarify')
       ORDER BY updated_at DESC LIMIT 1`,
      [userId, messageId],
    ),
  );
}

/** Drops the waiting-for-input state (e.g. /cancel). */
export async function cancelInputDrafts(db: Db, userId: number): Promise<void> {
  await exec(
    db,
    "UPDATE drafts SET state = 'cancelled', updated_at = $1 WHERE user_id = $2 AND state IN ('editing', 'clarify', 'collecting')",
    [Date.now(), userId],
  );
}
