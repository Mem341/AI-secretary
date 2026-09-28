import { createEnv, dailyCron, realSleep, type Runtime, setupBootErrorPage } from "./app";
import { ConfigError, type Env, loadConfig } from "./env";
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

let cachedEnv: Env | null = null;

/**
 * Builds the environment. Without PUBLIC_URL, the Function URL a request arrived on is used; the scheduled cron —
 * which has no request — gets PUBLIC_URL from the stack (aws/template.yaml). Exported for tests.
 */
export function boot(host: string | undefined, source: Record<string, string | undefined> = process.env): Env {
  const config = loadConfig(source, host ? `https://${host}` : "");
  if (cachedEnv?.PUBLIC_URL === config.PUBLIC_URL) return cachedEnv;
  cachedEnv = createEnv(config, runtime);
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
    const env = boot(event.requestContext?.domainName, source);
    response = await route(req, env, runtime);
  } catch (err) {
    console.error("request failed", err);
    const message = err instanceof Error ? err.message : String(err);
    if (routePath(req) === "/api/setup" || routePath(req) === "/") {
      response = setupBootErrorPage(source, message);
    } else {
      response = Response.json({ ok: false, error: err instanceof ConfigError ? message : "Startup failed, see logs" }, { status: 500 });
    }
  }
  return { response, background: drain() };
}

export async function cronHandler(_event?: unknown, source: Record<string, string | undefined> = process.env): Promise<{ statusCode: number }> {
  pending = [];
  const env = boot(undefined, source);
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
