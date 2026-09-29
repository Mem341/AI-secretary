import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remindersCron } from "../src/app";
import { classify } from "../src/bot/assistant";
import type { GEvent } from "../src/google/calendar";
import { sendDigest, sendReminders } from "../src/google/reminders";
import { handleUpdate } from "../src/telegram/handler";
import { readHidden } from "../src/telegram/hidden";
import type { TgUpdate } from "../src/telegram/types";
import { connectGoogle, lastBotMessage, llmReply, mockFetch, OWNER, resetInstance, routerRoute, runJobs, testEnv, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

let updateId = 1;
const text = (t: string): TgUpdate => ({
  update_id: updateId++,
  message: { message_id: 100 + updateId, date: 0, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "O" }, text: t },
});

const HOUR = 3600_000;
const ev = (id: string, start: number, extra: Partial<GEvent> = {}): GEvent => ({
  id,
  status: "confirmed",
  summary: `Зустріч ${id}`,
  start: { dateTime: new Date(start).toISOString() },
  end: { dateTime: new Date(start + HOUR).toISOString() },
  ...extra,
});

describe("router: free text without commands", () => {
  it("the cheap router model decides; bad answers fall back to keywords", async () => {
    mockFetch([routerRoute("agenda", { from: "2026-10-01", to: "2026-10-02" })]);
    const { env } = testEnv();
    expect(await classify(env, "що в мене в четвер?")).toEqual({ intent: "agenda", from: "2026-10-01", to: "2026-10-02" });

    vi.restoreAllMocks();
    mockFetch([(url) => (url.hostname === "openrouter.ai" ? llmReply({ nonsense: true }) : undefined)]);
    expect((await classify(env, "перевір пошту")).intent).toBe("mail");
    expect((await classify(env, "зустріч з Іваном")).intent).toBe("meeting");
  });

  it("«що в мене завтра?» lists the day from the live calendar", async () => {
    await connectGoogle();
    const now = Date.now();
    let range: URLSearchParams | undefined;
    const calls = mockFetch([
      routerRoute("agenda"),
      (url) => {
        if (!url.pathname.endsWith("/calendars/primary/events")) return undefined;
        range = url.searchParams;
        return Response.json({ items: [ev("a", now + 2 * HOUR, { location: "Офіс" })] });
      },
      (url) => (url.hostname === "openrouter.ai" ? Response.json({ choices: [{ message: { content: "Сьогодні одна зустріч." } }] }) : undefined),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, text("що в мене сьогодні?"));
    await runJobs(env, jobs);
    const answer = String(tgCalls(calls, "sendMessage").at(-1)!.text);
    expect(answer).toContain("Сьогодні одна зустріч.");
    expect(answer).toContain("Зустріч a");
    expect(answer).toContain("Офіс");
    expect(range!.get("singleEvents")).toBe("true");
  });

  it("anything else is a conversation, answered by the main model", async () => {
    let model = "";
    const calls = mockFetch([
      routerRoute("chat"),
      (url, init) => {
        if (url.hostname !== "openrouter.ai") return undefined;
        model = JSON.parse(init.bodyText).model;
        return Response.json({ choices: [{ message: { content: "Привіт! Я ваш секретар." } }] });
      },
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, text("привіт, що ти вмієш?"));
    await runJobs(env, jobs);
    expect(model).toBe("test/card-model");
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toBe("Привіт! Я ваш секретар.");
  });

  it("the default models are OpenAI (voice stays on a model that accepts Telegram's OGG)", async () => {
    const { loadConfig } = await import("../src/env");
    const c = loadConfig({ OWNER_TELEGRAM_ID: "1", TELEGRAM_BOT_TOKEN: "1:A", OPENROUTER_API_KEY: "k", PUBLIC_URL: "https://b.test" });
    expect(c.LLM_MODEL).toMatch(/^openai\//);
    expect(c.ROUTER_MODEL).toMatch(/^openai\//);
    expect(c.STT_MODEL).toBe("google/gemini-2.5-flash");
  });
});

describe("reminders", () => {
  it("reminds once before a meeting and remembers it on the event", async () => {
    await connectGoogle();
    const now = Date.now();
    const writes: { id: string; props: Record<string, string> }[] = [];
    const calls = mockFetch([
      (url, init) => {
        if (init.method === "PATCH") {
          writes.push({ id: url.pathname.split("/").at(-1)!, props: JSON.parse(init.bodyText).extendedProperties.private });
          return Response.json({});
        }
        return url.pathname.endsWith("/calendars/primary/events")
          ? Response.json({
              items: [
                ev("soon", now + 20 * 60_000, { hangoutLink: "https://meet.google.com/x" }),
                ev("done", now + 25 * 60_000, { extendedProperties: { private: { aisReminded: String(now + 25 * 60_000) } } }),
              ],
            })
          : undefined;
      },
    ]);
    const { env } = testEnv();
    expect(await sendReminders(env, now)).toBe(1);
    const msg = lastBotMessage("Через 20 хв");
    expect(msg.text).toContain("meet.google.com");
    expect(readHidden(msg)).toEqual({ k: "ev", id: "soon" });
    expect(writes).toEqual([{ id: "soon", props: { aisReminded: String(now + 20 * 60_000) } }]);
    expect(await sendReminders(env, now)).toBe(0);
    expect(tgCalls(calls, "sendMessage")).toHaveLength(1);
  });

  it("the reminders endpoint is protected like the daily cron", async () => {
    mockFetch([]);
    const { env, jobs } = testEnv();
    expect((await remindersCron(new Request("https://bot.test/api/cron/reminders"), env)).status).toBe(401);
    await remindersCron(new Request("https://bot.test/api/cron/reminders", { headers: { authorization: "Bearer cron-secret" } }), env);
    expect(jobs.map((j) => j.body)).toEqual([{ type: "reminders" }]);
  });

  it("the morning digest lists today's meetings and stays quiet on an empty day", async () => {
    await connectGoogle();
    const now = Date.now();
    let items: GEvent[] = [];
    const calls = mockFetch([(url) => (url.pathname.endsWith("/calendars/primary/events") ? Response.json({ items }) : undefined)]);
    const { env } = testEnv();
    expect(await sendDigest(env, now)).toBe(false);
    items = [ev("a", now + HOUR), ev("b", now + 2 * HOUR)];
    expect(await sendDigest(env, now)).toBe(true);
    expect(String(tgCalls(calls, "sendMessage")[0]!.text)).toContain("Сьогодні у вас 2 зустрічі");
  });
});
