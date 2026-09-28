import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import { createEnv } from "../src/app";
import type { Db } from "../src/db/client";
import { migrate } from "../src/db/schema";
import type { User } from "../src/db/users";
import type { Config, Env } from "../src/env";
import { type Job, runWithRetry } from "../src/jobs";

export const OWNER = 1000;

export const testConfig: Config = {
  OWNER_TELEGRAM_ID: OWNER,
  PUBLIC_URL: "https://bot.test",
  LLM_MODEL: "test/card-model",
  LLM_MODEL_SUMMARY: "test/summary-model",
  STT_MODEL: "scribe_v1",
  TELEGRAM_BOT_TOKEN: "tg-token",
  TELEGRAM_WEBHOOK_SECRET: "tg-secret",
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsecret",
  OPENROUTER_API_KEY: "or-key",
  ELEVENLABS_API_KEY: "el-key",
  ENCRYPTION_KEY: "test-encryption-key",
  CRON_SECRET: "cron-secret",
};

/** Postgres in memory (PGlite) behind the app's Db interface; BIGINT parsed to number as in production. */
export async function pgliteDb(): Promise<Db> {
  const pg = new PGlite({ parsers: { 20: (v: string) => Number(v) } });
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T>(sql, params);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    },
  };
  await migrate(db);
  return db;
}

const TABLES = ["errors", "summaries", "recordings", "reminders", "drafts", "meetings", "watch_channels", "google_auth", "contacts", "users"];

export async function resetDb(db: Db): Promise<void> {
  await db.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

export interface QueuedJob {
  body: Job;
  delaySeconds?: number;
}

/**
 * Env whose job queue collects jobs instead of running them, so tests run them explicitly with `runJobs`.
 * `deferred` collects background promises (webhook handling) to await.
 */
export function testEnv(db: Db): { env: Env; jobs: QueuedJob[]; deferred: Promise<unknown>[] } {
  const jobs: QueuedJob[] = [];
  const deferred: Promise<unknown>[] = [];
  const env = createEnv(testConfig, db, { defer: (p) => void deferred.push(p), sleep: async () => undefined });
  env.jobs = {
    async send(body: Job, opts?: { delaySeconds?: number }) {
      jobs.push({ body, delaySeconds: opts?.delaySeconds });
    },
  };
  return { env, jobs, deferred };
}

export async function runJobs(env: Env, jobs: QueuedJob[]): Promise<void> {
  while (jobs.length) {
    const { body } = jobs.shift()!;
    await runWithRetry(env, body, async () => undefined, 1);
  }
}

export function makeOwner(over: Partial<User> = {}): User {
  return {
    id: 1,
    tg_id: OWNER,
    tg_username: "oleksandr_k",
    email: "o.kovalenko@ribas.ua",
    full_name: "Олександр Коваленко",
    position: "Директор з розвитку",
    phone: "+380671234567",
    defaults: { duration_min: 60, format: "offline", address: "вул. Хрещатик, 1, Київ" },
    dialog_state: null,
    ...over,
  };
}

export interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Route = (url: URL, init: RequestInit & { bodyText: string }) => Response | Promise<Response> | undefined;

/**
 * Replaces global fetch with a router over outbound calls (Telegram, Google, OpenRouter, ElevenLabs).
 * Telegram calls succeed by default; any other unrouted call fails the test loudly.
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
