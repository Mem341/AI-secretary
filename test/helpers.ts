import { vi } from "vitest";
import { resetMemory } from "../src/agent/memory";
import { createEnv } from "../src/app";
import { resetDirectory } from "../src/bot/contacts";
import { resetOwnerCache, type User } from "../src/bot/owner";
import type { Config, Env } from "../src/env";
import { type GoogleGrant, resetGoogleCache } from "../src/google/oauth";
import { type Job, runWithRetry } from "../src/jobs";
import { encrypt } from "../src/lib/crypto";
import { resetSession } from "../src/session";
import { hiddenData, hiddenEntity } from "../src/telegram/hidden";
import type { TgMessage } from "../src/telegram/types";

export const OWNER = 1000;

export const testConfig: Config = {
  OWNER_TELEGRAM_ID: OWNER,
  PUBLIC_URL: "https://bot.test",
  LLM_MODEL: "test/strong-model",
  AGENT_MODEL: "test/agent-model",
  VISION_MODEL: "test/vision-model",
  LLM_MODEL_SUMMARY: "test/summary-model",
  STT_MODEL: "test/audio-model",
  REMINDER_MINUTES: [30, 10],
  TELEGRAM_BOT_TOKEN: "tg-token",
  TELEGRAM_WEBHOOK_SECRET: "tg-secret",
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsecret",
  GOOGLE_OAUTH_MODE: "web",
  OPENROUTER_API_KEY: "or-key",
  ENCRYPTION_KEY: "test-encryption-key",
  CRON_SECRET: "cron-secret",
  ZOOM_ACCOUNT_ID: "",
  ZOOM_CLIENT_ID: "",
  ZOOM_CLIENT_SECRET: "",
  BITRIX_WEBHOOK_URL: "",
  GMAIL_PUBSUB_TOPIC: "",
  GOOGLE_PROJECT_ID: "",
  OWNER_NAME: "",
  OWNER_POSITION: "Директор з розвитку",
  OWNER_PHONE: "+380671234567",
  DEFAULT_DURATION_MIN: 60,
  DEFAULT_FORMAT: "offline",
  DEFAULT_ADDRESS: "вул. Хрещатик, 1, Київ",
};

/** Every test starts from a fresh instance: nothing survives between tests, as between cold starts. */
export function resetInstance(): void {
  resetGoogleCache();
  resetSession();
  resetDirectory();
  resetOwnerCache();
  resetMemory();
  tg.reset();
}

export interface QueuedJob {
  body: Job;
  delaySeconds?: number;
}

/**
 * Env whose job queue collects jobs instead of running them, so tests run them explicitly with `runJobs`.
 * `deferred` collects background promises (webhook handling) to await.
 */
export function testEnv(over: Partial<Config> = {}): { env: Env; jobs: QueuedJob[]; deferred: Promise<unknown>[] } {
  const jobs: QueuedJob[] = [];
  const deferred: Promise<unknown>[] = [];
  const env = createEnv({ ...testConfig, ...over }, { defer: (p) => void deferred.push(p), sleep: async () => undefined });
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
    tg_id: OWNER,
    tg_username: "oleksandr_k",
    email: "o.kovalenko@acme.ua",
    full_name: "Олександр Коваленко",
    position: "Директор з розвитку",
    phone: "+380671234567",
    defaults: { duration_min: 60, format: "offline", address: "вул. Хрещатик, 1, Київ" },
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Fake Telegram: remembers the messages the bot sent (with the entities Telegram would parse from its HTML) and
// the pinned message, so hidden data and the Google grant behave as in production.

class FakeTelegram {
  messages = new Map<number, TgMessage>();
  pinned: TgMessage | null = null;
  nextId = 500;
  started = true;

  reset(): void {
    this.messages.clear();
    this.pinned = null;
    this.nextId = 500;
    this.started = true;
  }

  message(text: string, id = ++this.nextId): TgMessage {
    const entity = hiddenEntity(text);
    const msg: TgMessage = {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER, type: "private" },
      from: { id: 1, is_bot: true, first_name: "Bot" },
      text,
      entities: entity ? [entity] : [],
    };
    this.messages.set(id, msg);
    return msg;
  }

  handle(method: string, body: Record<string, unknown>): unknown {
    switch (method) {
      case "sendMessage":
        return this.message(String(body.text));
      case "editMessageText": {
        const edited = this.message(String(body.text), Number(body.message_id));
        // Telegram returns the edited text in getChat.pinned_message too.
        if (this.pinned?.message_id === edited.message_id) this.pinned = edited;
        return edited;
      }
      case "pinChatMessage":
        this.pinned = this.messages.get(Number(body.message_id)) ?? null;
        return true;
      case "deleteMessage":
      case "unpinChatMessage":
        if (this.pinned?.message_id === Number(body.message_id)) this.pinned = null;
        this.messages.delete(Number(body.message_id));
        return true;
      case "getChat":
        if (!this.started) throw new Error("chat not found");
        return { id: OWNER, type: "private", first_name: "Олександр", last_name: "Коваленко", username: "oleksandr_k", pinned_message: this.pinned ?? undefined };
      case "getFile":
        return { file_id: body.file_id, file_unique_id: "u", file_path: "photos/file.jpg" };
      default:
        return { message_id: ++this.nextId, date: 0, chat: { id: OWNER, type: "private" } };
    }
  }
}

export const tg = new FakeTelegram();

/** A message from the bot as Telegram would return it in `reply_to_message` / `callback_query.message`. */
export function botMessage(id: number): TgMessage {
  const msg = tg.messages.get(id);
  if (!msg) throw new Error(`No bot message ${id}`);
  return msg;
}

/** The latest bot message whose text contains `needle`. */
export function lastBotMessage(needle = ""): TgMessage {
  const found = [...tg.messages.values()].filter((m) => m.text?.includes(needle)).at(-1);
  if (!found) throw new Error(`No bot message with "${needle}"`);
  return found;
}

export const GMAIL_SCOPE = "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.modify";

/** Google connected: the grant sits in the chat's pinned message, as after the OAuth callback. */
export async function connectGoogle(grant: Partial<GoogleGrant> = {}): Promise<void> {
  const full: GoogleGrant = { email: "o.kovalenko@acme.ua", refresh_token: "refresh", scope: GMAIL_SCOPE, ...grant };
  const msg = tg.message(hiddenData({ k: "google", t: await encrypt(testConfig.ENCRYPTION_KEY, JSON.stringify(full)) }) + "🔐 Google підключено");
  tg.pinned = msg;
}

export interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Route = (url: URL, init: RequestInit & { bodyText: string }) => Response | Promise<Response> | undefined;

/**
 * Replaces global fetch with a router over outbound calls (Telegram, Google, OpenRouter). Telegram is served by the
 * fake above; Google token refresh succeeds; any other unrouted call fails the test loudly.
 */
export function mockFetch(routes: Route[]): Call[] {
  const calls: Call[] = [];
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
      if (url.pathname.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
      const method = url.pathname.split("/").at(-1)!;
      try {
        return Response.json({ ok: true, result: tg.handle(method, (body as Record<string, unknown>) ?? {}) });
      } catch (err) {
        return Response.json({ ok: false, description: String(err) }, { status: 400 });
      }
    }
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "access", expires_in: 3600 });
    throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${url.href}`);
  });
  return calls;
}

export function tgCalls(calls: Call[], method: string): Record<string, unknown>[] {
  return calls
    .filter((c) => c.url.includes("api.telegram.org") && c.url.endsWith(`/${method}`))
    .map((c) => c.body as Record<string, unknown>);
}

/** An OpenRouter answer with plain text (the agent is done). */
export function llmText(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

/** An OpenRouter answer calling tools: [name, args] pairs. */
export function llmTools(...calls: [string, Record<string, unknown>][]): Response {
  return Response.json({
    choices: [
      {
        message: {
          content: null,
          tool_calls: calls.map(([name, args], i) => ({ id: `call${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })),
        },
      },
    ],
  });
}

/** The Supervisor's request: its tools are the two agents. */
export const isSupervisor = (req: LlmRequest) => !!req.tools?.some((t) => t.function.name === "calendar_agent");

export interface LlmRequest {
  model: string;
  messages: { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
}

/**
 * Route: OpenRouter chat completions answered by `script` (per request, with the parsed body). Returns the list of
 * requests it saw.
 */
export function openRouter(script: (req: LlmRequest, n: number) => Response, seen: LlmRequest[] = []): Route {
  return (url, init) => {
    if (url.hostname !== "openrouter.ai") return undefined;
    const req = JSON.parse(init.bodyText) as LlmRequest;
    seen.push(req);
    return script(req, seen.length);
  };
}

/** The text of the last message of a request (the latest user turn or tool result). */
export function lastContent(req: LlmRequest): string {
  const c = req.messages.at(-1)!.content;
  return typeof c === "string" ? c : Array.isArray(c) ? String((c[0] as { text?: string }).text ?? "") : "";
}

export function llmReply(json: unknown): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify(json) } }] });
}

/** Route: Google Calendar events.list returning `items` (for any listing). */
export function calendarList(items: unknown[] = []): Route {
  return (url, init) =>
    url.hostname === "www.googleapis.com" && url.pathname === "/calendar/v3/calendars/primary/events" && (init.method ?? "GET") === "GET"
      ? Response.json({ items })
      : undefined;
}
