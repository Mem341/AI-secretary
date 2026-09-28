export type Role = "owner" | "member";
export type MeetingFormat = "offline" | "google_meet";

export interface UserDefaults {
  duration_min?: number;
  format?: MeetingFormat;
  address?: string;
}

export interface User {
  id: number;
  tg_id: number;
  tg_username: string | null;
  email: string | null;
  full_name: string | null;
  position: string | null;
  phone: string | null;
  role: Role;
  defaults: UserDefaults;
  dialog_state: string | null;
  active: boolean;
}

interface UserRow extends Omit<User, "defaults" | "active"> {
  defaults_json: string;
  active: number;
}

function fromRow(row: UserRow | null): User | null {
  if (!row) return null;
  const { defaults_json, active, ...rest } = row;
  let defaults: UserDefaults = {};
  try {
    defaults = JSON.parse(defaults_json) as UserDefaults;
  } catch {
    /* keep empty */
  }
  return { ...rest, defaults, active: active === 1 };
}

export const DEFAULT_DURATION_MIN = 60;

export function durationOf(user: User): number {
  return user.defaults.duration_min ?? DEFAULT_DURATION_MIN;
}

export function formatOf(user: User): MeetingFormat {
  return user.defaults.format ?? "offline";
}

export function firstName(user: User): string {
  return (user.full_name ?? "").trim().split(/\s+/)[0] ?? "";
}

export async function getUserByTgId(db: D1Database, tgId: number): Promise<User | null> {
  return fromRow(await db.prepare("SELECT * FROM users WHERE tg_id = ?").bind(tgId).first<UserRow>());
}

export async function getUserById(db: D1Database, id: number): Promise<User | null> {
  return fromRow(await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>());
}

export async function listUsers(db: D1Database): Promise<User[]> {
  const { results } = await db.prepare("SELECT * FROM users ORDER BY role, full_name").all<UserRow>();
  return results.map((r) => fromRow(r)!);
}

/** Staff directory for the LLM and for email resolution: active users with a known email. */
export async function listDirectory(db: D1Database): Promise<{ name: string; email: string; tg_id: number }[]> {
  const { results } = await db
    .prepare("SELECT full_name AS name, email, tg_id FROM users WHERE active = 1 AND email IS NOT NULL AND full_name IS NOT NULL")
    .all<{ name: string; email: string; tg_id: number }>();
  return results;
}

/** Whitelist entry created by an administrator (/allow). Re-activates an existing user. */
export async function allowUser(db: D1Database, tgId: number, role: Role): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO users (tg_id, role, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (tg_id) DO UPDATE SET role = excluded.role, active = 1, updated_at = excluded.updated_at`,
    )
    .bind(tgId, role, now, now)
    .run();
}

export async function deactivateUser(db: D1Database, tgId: number): Promise<boolean> {
  const res = await db.prepare("UPDATE users SET active = 0, updated_at = ? WHERE tg_id = ?").bind(Date.now(), tgId).run();
  return res.meta.changes > 0;
}

type Patch = Partial<Pick<User, "tg_username" | "email" | "full_name" | "position" | "phone" | "dialog_state">> & {
  defaults?: UserDefaults;
};

export async function updateUser(db: D1Database, id: number, patch: Patch): Promise<void> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "defaults") {
      cols.push("defaults_json = ?");
      vals.push(JSON.stringify(value));
    } else {
      cols.push(`${key} = ?`);
      vals.push(value);
    }
  }
  if (!cols.length) return;
  cols.push("updated_at = ?");
  vals.push(Date.now(), id);
  await db.prepare(`UPDATE users SET ${cols.join(", ")} WHERE id = ?`).bind(...vals).run();
}
