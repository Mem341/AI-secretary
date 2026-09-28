import { type Db, exec, one } from "./client";

export type RefType = "meeting" | "mail";

export interface MessageLink {
  ref_type: RefType;
  ref_id: string;
}

/**
 * Remembers what a sent Telegram message was about (a meeting or a Gmail message), so a reply to it — "перенеси
 * на завтра", "відповідай: добре" — can act on the right thing without the owner repeating themselves.
 */
export async function linkMessage(db: Db, messageId: number, refType: RefType, refId: string): Promise<void> {
  await exec(
    db,
    `INSERT INTO message_links (message_id, ref_type, ref_id, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id) DO UPDATE SET ref_type = EXCLUDED.ref_type, ref_id = EXCLUDED.ref_id`,
    [messageId, refType, refId, Date.now()],
  );
}

export async function findMessageLink(db: Db, messageId: number): Promise<MessageLink | null> {
  return one<MessageLink>(db, "SELECT ref_type, ref_id FROM message_links WHERE message_id = $1", [messageId]);
}
