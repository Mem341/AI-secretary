import { neon, types } from "@neondatabase/serverless";

/** Minimal Postgres access used by the app: `$1, $2…` placeholders, rows as objects. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export async function all<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  return (await db.query<T>(sql, params)).rows[0] ?? null;
}

/** Runs a statement and returns the number of affected rows. */
export async function exec(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  return (await db.query(sql, params)).rowCount;
}

const INT8_OID = 20;

/** Neon serverless driver over HTTP — works in Vercel Functions without a connection pool. */
export function neonDb(connectionString: string): Db {
  const sql = neon(connectionString);
  // Epoch-millisecond timestamps and Telegram IDs are BIGINT; they fit in a JS number.
  // Type parsers are only honored as per-query options, not as neon() options.
  const queryOpts = {
    fullResults: true as const,
    types: {
      getTypeParser: (id: number, format?: "text" | "binary") =>
        id === INT8_OID ? (v: string) => Number(v) : types.getTypeParser(id, format as "text"),
    },
  };
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const res = await sql.query(text, params, queryOpts);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
  };
}
