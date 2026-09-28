import { createEnv, dailyCron, realSleep, type Runtime, setupBootErrorPage } from "./app";
import { type Db, neonDb } from "./db/client";
import { migrate } from "./db/schema";
import { getSetting, setSetting } from "./db/settings";
import { ConfigError, databaseUrl, type Env, loadConfig } from "./env";
import { route, routePath } from "./router";

/**
 * AWS Lambda entry points (see aws/template.yaml):
 * - `handler` serves every HTTP endpoint through a Lambda Function URL in RESPONSE_STREAM mode: the answer is sent
 *   first and the background work (LLM, sync, Gmail) finishes afterwards — AWS's equivalent of Vercel's waitUntil;
 * - `cronHandler` is invoked daily by an EventBridge schedule (renews Google push channels, safety-net sync).
 */

/** Lambda Function URL event, payload format 2.0 (the fields the adapter uses). */
export interface FunctionUrlEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { domainName?: string; http?: { method?: string } };
}

export function eventToRequest(event: FunctionUrlEvent): Request {
  const host = event.requestContext?.domainName ?? event.headers?.host ?? "localhost";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const method = (event.requestContext?.http?.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
  const hasBody = event.body !== undefined && method !== "GET" && method !== "HEAD";
  const body = hasBody ? (event.isBase64Encoded ? Buffer.from(event.body!, "base64") : event.body) : undefined;
  return new Request(`https://${host}${event.rawPath ?? "/"}${query}`, { method, headers, body });
}

// Background work of the current invocation (a Lambda instance handles one request at a time).
let pending: Promise<unknown>[] = [];
const runtime: Runtime = {
  defer: (p) => void pending.push(p.catch((err) => console.error("background task failed", err))),
  sleep: realSleep,
};

/** Waits for all background work, including jobs that queue further jobs while running. */
async function drain(): Promise<void> {
  while (pending.length) {
    const batch = pending;
    pending = [];
    await Promise.allSettled(batch);
  }
}

let db: Db | null = null;
let migrated: Promise<unknown> | null = null;
let cachedEnv: Env | null = null;

const PUBLIC_URL_KEY = "public_url";

/** Tests (and alternative hosts) supply their own database instead of Neon. */
export function setDatabase(d: Db): void {
  db = d;
  migrated = migrate(d);
  cachedEnv = null;
}

/**
 * Builds the environment. Without PUBLIC_URL, the Function URL a request arrived on is used and remembered, so the
 * scheduled cron — which has no request — knows the address too. Exported for tests.
 */
export async function boot(host: string | undefined, source: Record<string, string | undefined> = process.env): Promise<Env> {
  const url = databaseUrl(source);
  if (!url) throw new ConfigError("Missing environment variables: DATABASE_URL (a Postgres connection string, e.g. from neon.tech)");
  db ??= neonDb(url);
  migrated ??= migrate(db).catch((err) => {
    migrated = null;
    throw err;
  });
  await migrated;

  let fallback = "";
  if (!source.PUBLIC_URL?.trim()) {
    const fromRequest = host ? `https://${host}` : "";
    const stored = await getSetting(db, PUBLIC_URL_KEY);
    if (fromRequest && fromRequest !== stored) await setSetting(db, PUBLIC_URL_KEY, fromRequest);
    fallback = fromRequest || stored || "";
  }
  const config = loadConfig(source, fallback);
  if (cachedEnv?.PUBLIC_URL === config.PUBLIC_URL) return cachedEnv;
  cachedEnv = createEnv(config, db, runtime);
  return cachedEnv;
}

/** Answers the request and returns the background work separately, so the caller can send the answer first. */
export async function handleHttp(
  event: FunctionUrlEvent,
  source: Record<string, string | undefined> = process.env,
): Promise<{ response: Response; background: Promise<void> }> {
  pending = [];
  const req = eventToRequest(event);
  let response: Response;
  try {
    const env = await boot(event.requestContext?.domainName, source);
    response = await route(req, env, runtime);
  } catch (err) {
    console.error("request failed", err);
    const message = err instanceof Error ? err.message : String(err);
    if (routePath(req) === "/api/setup" || routePath(req) === "/") {
      response = setupBootErrorPage(source, databaseUrl(source), message);
    } else {
      response = Response.json({ ok: false, error: err instanceof ConfigError ? message : "Startup failed, see logs" }, { status: 500 });
    }
  }
  return { response, background: drain() };
}

export async function cronHandler(_event?: unknown, source: Record<string, string | undefined> = process.env): Promise<{ statusCode: number }> {
  pending = [];
  const env = await boot(undefined, source);
  const headers: Record<string, string> = env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : {};
  const res = await dailyCron(new Request(`${env.PUBLIC_URL}/api/cron/daily`, { headers }), env);
  await drain();
  return { statusCode: res.status };
}

/** Buffered Function URL response (INVOKE_MODE BUFFERED): used when streaming is unavailable. */
export async function bufferedHandler(event: FunctionUrlEvent) {
  const { response, background } = await handleHttp(event);
  await background;
  const body = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  return { statusCode: response.status, headers, body: body.toString("base64"), isBase64Encoded: true };
}

// The Node.js Lambda runtime provides `awslambda` as a global for response streaming.
declare const awslambda:
  | {
      streamifyResponse: (fn: (event: FunctionUrlEvent, stream: NodeJS.WritableStream) => Promise<void>) => unknown;
      HttpResponseStream: { from: (stream: NodeJS.WritableStream, meta: { statusCode: number; headers: Record<string, string> }) => NodeJS.WritableStream };
    }
  | undefined;

async function streamingHandler(event: FunctionUrlEvent, stream: NodeJS.WritableStream): Promise<void> {
  const { response, background } = await handleHttp(event);
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  const out = awslambda!.HttpResponseStream.from(stream, { statusCode: response.status, headers });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length) out.write(body);
  out.end();
  // The client already has the answer; the invocation stays alive until the background work is done.
  await background;
}

export const handler = typeof awslambda !== "undefined" ? awslambda.streamifyResponse(streamingHandler) : bufferedHandler;
