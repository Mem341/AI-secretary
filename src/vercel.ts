import { waitUntil } from "@vercel/functions";
import { createEnv, realSleep, type Runtime } from "./app";
import { neonDb } from "./db/client";
import { migrate } from "./db/schema";
import { ConfigError, type Env, loadConfig } from "./env";

const runtime: Runtime = { defer: waitUntil, sleep: realSleep };

let booting: Promise<Env> | null = null;

export function databaseUrl(source: Record<string, string | undefined> = process.env): string | undefined {
  return source.DATABASE_URL || source.POSTGRES_URL;
}

/** Builds the environment once per instance; the schema is migrated on the first request. */
function boot(): Promise<Env> {
  booting ??= (async () => {
    const config = loadConfig();
    const url = databaseUrl();
    if (!url) throw new ConfigError("Missing environment variables: DATABASE_URL (connect Neon Postgres to the project)");
    const db = neonDb(url);
    await migrate(db);
    return createEnv(config, db, runtime);
  })().catch((err) => {
    booting = null;
    throw err;
  });
  return booting;
}

type Handler = (req: Request, env: Env, runtime: Runtime) => Promise<Response>;

/**
 * Wraps an app handler as a Vercel Function. When the deployment cannot start (missing variables, no database),
 * `onBootError` renders the answer; by default a 500 with the missing variable names.
 */
export function vercelHandler(
  handler: Handler,
  onBootError?: (message: string) => Response,
): (req: Request) => Promise<Response> {
  return async (req) => {
    let env: Env;
    try {
      env = await boot();
    } catch (err) {
      console.error("boot failed", err);
      const message = err instanceof ConfigError ? err.message : "Startup failed, see function logs";
      if (onBootError) return onBootError(err instanceof Error ? err.message : String(err));
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
    return handler(req, env, runtime);
  };
}
