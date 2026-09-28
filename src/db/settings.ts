import { type Db, exec, one } from "./client";

export async function getSetting(db: Db, key: string): Promise<string | null> {
  return (await one<{ value: string }>(db, "SELECT value FROM app_settings WHERE key = $1", [key]))?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await exec(
    db,
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, value, Date.now()],
  );
}
