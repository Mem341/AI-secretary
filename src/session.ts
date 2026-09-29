export type SourceType = "text" | "voice" | "forward" | "screenshot";

/**
 * Short-lived, in-memory state of the current server instance — nothing is persisted, everything expires by
 * itself. Serverless instances are reused between requests that follow each other closely, which is exactly
 * what this is for: gluing a burst of forwarded messages into one card, remembering which card the owner was
 * asked to edit, not reporting the same calendar change twice. Losing it costs a duplicate, never data.
 */

const marks = new Map<string, number>();

function sweep(now = Date.now()): void {
  for (const [key, until] of marks) if (until <= now) marks.delete(key);
  for (const [chat, batch] of batches) if (batch.at < now - BATCH_TTL_MS) batches.delete(chat);
  for (const [chat, p] of pending) if (p.until <= now) pending.delete(chat);
}

/** True the first time `key` is seen within `ttlMs` (then remembers it). */
export function firstTime(key: string, ttlMs: number): boolean {
  sweep();
  if (marks.has(key)) return false;
  marks.set(key, Date.now() + ttlMs);
  return true;
}

export function mark(key: string, ttlMs: number): void {
  marks.set(key, Date.now() + ttlMs);
}

export function isMarked(key: string): boolean {
  sweep();
  return marks.has(key);
}

// ---------------------------------------------------------------------------------------------------------------
// A burst of forwarded messages / screenshots

export interface Batch {
  lines: string[];
  sourceType: SourceType;
  seq: number;
  messageId: number | null;
  at: number;
}

const BATCH_TTL_MS = 5 * 60_000;
const batches = new Map<number, Batch>();

/** Adds a message to the chat's batch; `seq` identifies the latest message (debounce). */
export function appendBatch(chatId: number, line: string, sourceType: SourceType): Batch {
  sweep();
  const batch = batches.get(chatId) ?? { lines: [], sourceType, seq: 0, messageId: null, at: Date.now() };
  batch.lines.push(line);
  if (batch.sourceType !== "forward") batch.sourceType = sourceType;
  batch.seq++;
  batch.at = Date.now();
  batches.set(chatId, batch);
  return batch;
}

/** The batch, if `seq` is still its latest message (no newer message arrived); removes it. */
export function takeBatch(chatId: number, seq: number): Batch | null {
  const batch = batches.get(chatId);
  if (!batch || batch.seq !== seq) return null;
  batches.delete(chatId);
  return batch;
}

// ---------------------------------------------------------------------------------------------------------------
// What the bot just asked the owner to answer (when the answer does not come as a reply)

const pending = new Map<number, { data: unknown; until: number }>();
const PENDING_TTL_MS = 30 * 60_000;

export function expectAnswer(chatId: number, data: unknown): void {
  pending.set(chatId, { data, until: Date.now() + PENDING_TTL_MS });
}

export function takeAnswer<T>(chatId: number): T | null {
  sweep();
  const p = pending.get(chatId);
  if (!p) return null;
  pending.delete(chatId);
  return p.data as T;
}

export function clearAnswer(chatId: number): void {
  pending.delete(chatId);
}

/** Tests: start from a clean instance. */
export function resetSession(): void {
  marks.clear();
  batches.clear();
  pending.clear();
}
