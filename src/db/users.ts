import { type Db, all, exec, one } from "./client";

export type MeetingFormat = "offline" | "google_meet" | "zoom";

export interface UserDefaults {
  duration_min?: number;
  format?: MeetingFormat;
  address?: string;
  /** OpenRouter model id for meeting cards, e.g. "openai/gpt-4o"; unset uses the deployment's LLM_MODEL. */
  llm_model?: string;
}

/** The bot's owner (a single user, OWNER_TELEGRAM_ID). */
export interface User {
  id: number;
  tg_id: number;
  tg_username: string | null;
  email: string | null;
  full_name: string | null;
  position: string | null;
  phone: string | null;
  defaults: UserDefaults;
  dialog_state: string | null;
}

interface UserRow extends Omit<User, "defaults"> {
  defaults_json: string;
}

function fromRow(row: UserRow | null): User | null {
  if (!row) return null;
  const { defaults_json, ...rest } = row;
  let defaults: UserDefaults = {};
  try {
    defaults = JSON.parse(defaults_json) as UserDefaults;
  } catch {
    /* keep empty */
  }
  return {
    id: rest.id,
    tg_id: rest.tg_id,
    tg_username: rest.tg_username,
    email: rest.email,
    full_name: rest.full_name,
    position: rest.position,
    phone: rest.phone,
    dialog_state: rest.dialog_state,
    defaults,
  };
}

export const DEFAULT_DURATION_MIN = 60;

export function durationOf(user: User): number {
  return user.defaults.duration_min ?? DEFAULT_DURATION_MIN;
}

export function formatOf(user: User): MeetingFormat {
  return user.defaults.format ?? "offline";
}

/** The OpenRouter model to use for this owner's meeting cards: their override, or the deployment's default. */
export function modelOf(user: User, fallback: string): string {
  return user.defaults.llm_model?.trim() || fallback;
}

export function firstName(user: User): string {
  return (user.full_name ?? "").trim().split(/\s+/)[0] ?? "";
}

export async function getUserByTgId(db: Db, tgId: number): Promise<User | null> {
  return fromRow(await one<UserRow>(db, "SELECT * FROM users WHERE tg_id = $1", [tgId]));
}

export async function getUserById(db: Db, id: number): Promise<User | null> {
  return fromRow(await one<UserRow>(db, "SELECT * FROM users WHERE id = $1", [id]));
}

/** Returns the owner's row, creating it on first contact. */
export async function ensureUser(db: Db, tgId: number, username: string | null): Promise<User> {
  const now = Date.now();
  await exec(
    db,
    `INSERT INTO users (tg_id, tg_username, created_at, updated_at) VALUES ($1, $2, $3, $3)
     ON CONFLICT (tg_id) DO UPDATE SET tg_username = EXCLUDED.tg_username,
       updated_at = CASE WHEN users.tg_username IS DISTINCT FROM EXCLUDED.tg_username THEN EXCLUDED.updated_at ELSE users.updated_at END`,
    [tgId, username, now],
  );
  return (await getUserByTgId(db, tgId))!;
}

type Patch = Partial<Pick<User, "tg_username" | "email" | "full_name" | "position" | "phone" | "dialog_state">> & {
  defaults?: UserDefaults;
};

const PATCHABLE = new Set(["tg_username", "email", "full_name", "position", "phone", "dialog_state", "defaults"]);

export async function updateUser(db: Db, id: number, patch: Patch): Promise<void> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !PATCHABLE.has(key)) continue;
    vals.push(key === "defaults" ? JSON.stringify(value) : value);
    cols.push(`${key === "defaults" ? "defaults_json" : key} = $${vals.length}`);
  }
  if (!cols.length) return;
  vals.push(Date.now(), id);
  await exec(db, `UPDATE users SET ${cols.join(", ")}, updated_at = $${vals.length - 1} WHERE id = $${vals.length}`, vals);
}

// ---------------------------------------------------------------------------------------------------------------
// Address book

export interface Contact {
  name: string;
  email: string;
}

/** Known contacts for the LLM and for resolving emails by name. */
export async function listContacts(db: Db, limit = 300): Promise<Contact[]> {
  return all<Contact>(db, "SELECT name, email FROM contacts ORDER BY updated_at DESC LIMIT $1", [limit]);
}

export async function saveContact(db: Db, name: string, email: string): Promise<void> {
  await exec(
    db,
    `INSERT INTO contacts (name, email, updated_at) VALUES ($1, lower($2), $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
    [name.trim(), email.trim(), Date.now()],
  );
}

export async function deleteContact(db: Db, email: string): Promise<boolean> {
  return (await exec(db, "DELETE FROM contacts WHERE email = lower($1)", [email.trim()])) > 0;
}
