import { env } from "cloudflare:test";
import { vi } from "vitest";
import type { User } from "../src/db/users";
import type { Env } from "../src/env";
import type { Job } from "../src/jobs";

export function makeOwner(over: Partial<User> = {}): User {
  return {
    id: 1,
    tg_id: 1000,
    tg_username: "oleksandr_k",
    email: "o.kovalenko@ribas.ua",
    full_name: "Олександр Коваленко",
    position: "Директор з розвитку",
    phone: "+380671234567",
    role: "owner",
    defaults: { duration_min: 60, format: "offline", address: "вул. Хрещатик, 1, Київ" },
    dialog_state: null,
    active: true,
    ...over,
  };
}

/** Env whose queue collects jobs instead of delivering them, so tests run jobs explicitly. */
export function testEnv(): { env: Env; jobs: { body: Job; delaySeconds?: number }[] } {
  const jobs: { body: Job; delaySeconds?: number }[] = [];
  const queue = {
    async send(body: Job, opts?: { delaySeconds?: number }) {
      jobs.push({ body, delaySeconds: opts?.delaySeconds });
    },
    async sendBatch(msgs: { body: Job }[]) {
      for (const m of msgs) jobs.push({ body: m.body });
    },
  } as unknown as Queue<Job>;
  return { env: { ...(env as unknown as Env), JOBS: queue }, jobs };
}

export interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Route = (url: URL, init: RequestInit & { bodyText: string }) => Response | Promise<Response> | undefined;

/**
 * Replaces global fetch with a router over outbound calls (Telegram, Google, OpenRouter, ElevenLabs).
 * Unrouted calls fail the test loudly.
 */
export function mockFetch(routes: Route[]): Call[] {
  const calls: Call[] = [];
  let messageId = 500;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let body: unknown = bodyText;
    try {
      body = JSON.parse(bodyText);
    } catch {
      /* not JSON */
    }
    calls.push({ url: url.href, method: init?.method ?? "GET", body });
    for (const route of routes) {
      const res = await route(url, { ...init, bodyText });
      if (res) return res;
    }
    if (url.hostname === "api.telegram.org") {
      return Response.json({ ok: true, result: { message_id: ++messageId, date: 0, chat: { id: 0, type: "private" } } });
    }
    throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url.href}`);
  });
  return calls;
}

export function tgCalls(calls: Call[], method: string): Record<string, unknown>[] {
  return calls
    .filter((c) => c.url.includes("api.telegram.org") && c.url.endsWith(`/${method}`))
    .map((c) => c.body as Record<string, unknown>);
}

export function llmReply(json: unknown): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify(json) } }] });
}

const TABLES = ["errors", "summaries", "recordings", "reminders", "drafts", "meetings", "watch_channels", "google_auth", "users"];

export async function resetDb(): Promise<void> {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}
