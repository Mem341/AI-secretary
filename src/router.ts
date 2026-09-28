import {
  dailyCron,
  gcalPush,
  gmailPush,
  healthCheck,
  oauthCallback,
  oauthStart,
  type Runtime,
  setupPage,
  telegramWebhook,
} from "./app";
import type { Env } from "./env";

type Handler = (req: Request, env: Env, runtime: Runtime) => Promise<Response>;

/**
 * Every HTTP endpoint of the app, for hosts that route in code (AWS Lambda, a plain Node server). On Vercel each
 * one is its own file under api/ with the same path, so URLs are identical everywhere.
 */
export const ROUTES: Record<string, { method: "GET" | "POST"; handler: Handler }> = {
  "/api/telegram": { method: "POST", handler: telegramWebhook },
  "/api/gcal-push": { method: "POST", handler: gcalPush },
  "/api/gmail-push": { method: "POST", handler: gmailPush },
  "/api/oauth/start": { method: "GET", handler: oauthStart },
  "/api/oauth/callback": { method: "GET", handler: oauthCallback },
  "/api/cron/daily": { method: "GET", handler: dailyCron },
  "/api/health": { method: "GET", handler: healthCheck },
  "/api/setup": { method: "GET", handler: setupPage },
};

export function routePath(req: Request): string {
  return new URL(req.url).pathname.replace(/\/+$/, "") || "/";
}

export async function route(req: Request, env: Env, runtime: Runtime): Promise<Response> {
  const path = routePath(req);
  if (path === "/") return Response.redirect(`${env.PUBLIC_URL}/api/setup`, 302);
  const r = ROUTES[path];
  if (!r) return new Response("not found", { status: 404 });
  if (req.method !== r.method) return new Response("method not allowed", { status: 405, headers: { allow: r.method } });
  return r.handler(req, env, runtime);
}
