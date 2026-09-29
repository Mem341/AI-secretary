import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reminderMinutes } from "../src/env";
import type { GEvent } from "../src/google/calendar";
import { dueReminder, sendReminders } from "../src/google/reminders";
import { readHidden } from "../src/telegram/hidden";
import { connectGoogle, lastBotMessage, mockFetch, resetInstance, testEnv, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const MIN = 60_000;

describe("reminder marks", () => {
  it("REMINDER_MINUTES: «30,10» by default, largest first, junk ignored", () => {
    expect(reminderMinutes("")).toEqual([30, 10]);
    expect(reminderMinutes("10, 30")).toEqual([30, 10]);
    expect(reminderMinutes("15")).toEqual([15]);
    expect(reminderMinutes("abc")).toEqual([30, 10]);
  });

  it("with a 5-minute pinger: 30 min mark at ≤32 min left, 10 min mark at ≤12, each once", () => {
    const marks = [30, 10];
    expect(dueReminder(marks, 35 * MIN, null)).toBeNull();
    expect(dueReminder(marks, 31 * MIN, null)).toBe(30);
    expect(dueReminder(marks, 26 * MIN, 30)).toBeNull();
    expect(dueReminder(marks, 11 * MIN, 30)).toBe(10);
    expect(dueReminder(marks, 6 * MIN, 10)).toBeNull();
    // Added 5 minutes before the start: only the 10-minute reminder.
    expect(dueReminder(marks, 5 * MIN, null)).toBe(10);
  });
});

describe("sendReminders (no AI: calendar → Telegram)", () => {
  function meeting(start: number, reminded?: string): GEvent {
    return {
      id: "m1",
      status: "confirmed",
      summary: "Стендап",
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(start + 30 * MIN).toISOString() },
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      extendedProperties: { private: { aisStart: String(start), ...(reminded ? { aisReminded: reminded } : {}) } },
    };
  }

  it("sends the 30-minute reminder, then the 10-minute one, and remembers each on the event", async () => {
    await connectGoogle();
    const now = Date.now();
    const start = now + 28 * MIN;
    let ev = meeting(start);
    const writes: Record<string, string>[] = [];
    const calls = mockFetch([
      (url, init) => {
        if (url.hostname !== "www.googleapis.com") return undefined;
        if (init.method === "PATCH") {
          const props = JSON.parse(init.bodyText).extendedProperties.private as Record<string, string>;
          writes.push(props);
          ev = { ...ev, extendedProperties: { private: props } };
          return Response.json(ev);
        }
        return Response.json({ items: [ev] });
      },
    ]);
    const { env } = testEnv();

    expect(await sendReminders(env, now)).toBe(1);
    expect(String(tgCalls(calls, "sendMessage")[0]!.text)).toContain("⏰ <b>Через 28 хв:</b> Стендап");
    expect(readHidden(lastBotMessage("Через 28 хв"))).toEqual({ k: "ev", id: "m1" });
    expect(writes.at(-1)!.aisReminded).toBe(`${start}:30`);

    // 5 minutes later: nothing new.
    resetInstance();
    await connectGoogle();
    expect(await sendReminders(env, now + 5 * MIN)).toBe(0);

    // 18 minutes later (10 min left): the second reminder.
    expect(await sendReminders(env, now + 18 * MIN)).toBe(1);
    expect(writes.at(-1)!.aisReminded).toBe(`${start}:10`);
    expect(await sendReminders(env, now + 23 * MIN)).toBe(0);
  });

  it("a moved meeting is reminded again for its new time", async () => {
    await connectGoogle();
    const now = Date.now();
    const start = now + 9 * MIN;
    mockFetch([
      (url, init) =>
        url.hostname !== "www.googleapis.com"
          ? undefined
          : init.method === "PATCH"
            ? Response.json({})
            : Response.json({ items: [meeting(start, `${start - 60 * MIN}:10`)] }),
    ]);
    const { env } = testEnv();
    expect(await sendReminders(env, now)).toBe(1);
  });
});

describe("the 5-minute pinger with the owner's four reminder times", () => {
  it("1 h, 30, 10 and 5 min: each sent once as the meeting approaches; the endpoint reports what it saw", async () => {
    await connectGoogle();
    const { saveOwnerSettings } = await import("../src/google/oauth");
    const { remindersCron } = await import("../src/app");
    const start = Date.now() + 70 * MIN;
    let ev: GEvent = {
      id: "m9",
      status: "confirmed",
      summary: "Планування",
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(start + 60 * MIN).toISOString() },
      extendedProperties: { private: { aisStart: String(start) } },
    };
    const calls = mockFetch([
      (url, init) => {
        if (url.hostname !== "www.googleapis.com") return undefined;
        if (init.method === "PATCH") {
          ev = { ...ev, extendedProperties: { private: JSON.parse(init.bodyText).extendedProperties.private } };
          return Response.json(ev);
        }
        const timeMax = Date.parse(url.searchParams.get("timeMax") ?? "");
        return Response.json({ items: start <= timeMax ? [ev] : [] });
      },
    ]);
    const { env } = testEnv();
    await saveOwnerSettings(env, { r: [60, 30, 10, 5] });

    const sentAt: number[] = [];
    let lastBody: Record<string, unknown> = {};
    for (let left = 70; left >= 0; left -= 5) {
      vi.setSystemTime(start - left * MIN);
      const before = tgCalls(calls, "sendMessage").length;
      const res = await remindersCron(new Request("https://bot.test/api/cron/reminders", { headers: { authorization: "Bearer cron-secret" } }), env);
      lastBody = (await res.json()) as Record<string, unknown>;
      if (tgCalls(calls, "sendMessage").length > before) sentAt.push(left);
    }
    vi.useRealTimers();
    expect(sentAt).toEqual([60, 30, 10, 5]);
    const texts = tgCalls(calls, "sendMessage").map((m) => String(m.text)).filter((t) => t.includes("⏰"));
    expect(texts.map((t) => /Через (\d+) хв/.exec(t)![1])).toEqual(["60", "30", "10", "5"]);
    expect(lastBody).toMatchObject({ ok: true, marks: [60, 30, 10, 5] });
  });
});
