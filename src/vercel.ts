import { waitUntil } from "@vercel/functions";
import { createEnv, realSleep, type Runtime } from "./app";
import { ConfigError, type Env, loadConfig } from "./env";

const runtime: Runtime = { defer: waitUntil, sleep: realSleep };

let booting: Promise<Env> | null = null;

/** Builds the environment once per instance. */
function boot(): Promise<Env> {
  booting ??= (async () => createEnv(loadConfig(), runtime))().catch((err) => {
    booting = null;
    throw err;
  });
  return booting;
}

type Handler = (req: Request, env: Env, runtime: Runtime) => Promise<Response>;

/**
 * Wraps an app handler as a Vercel Function. When the deployment cannot start (missing variables),
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
