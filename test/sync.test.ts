import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyCron, gcalPush } from "../src/app";
import type { GEvent } from "../src/google/calendar";
import { channelToken, eventToChange, invitationButtons, invitationNotice, markUpcoming, reportChange, startWatch, syncRecent } from "../src/google/sync";
import { readHidden } from "../src/telegram/hidden";
import { type Call, connectGoogle, lastBotMessage, mockFetch, resetInstance, testEnv, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const timed = (id: string, startIso: string, endIso: string, extra: Partial<GEvent> = {}): GEvent => ({
  id,
  status: "confirmed",
  summary: `Event ${id}`,
  start: { dateTime: startIso },
  end: { dateTime: endIso },
  ...extra,
});

describe("eventToChange", () => {
  it("ignores all-day, removes cancelled/declined, mirrors timed events", () => {
    expect(eventToChange({ id: "a", start: { date: "2026-10-01" }, end: { date: "2026-10-02" } }).kind).toBe("cancel");
    expect(eventToChange({ id: "b", status: "cancelled" }).kind).toBe("cancel");
    expect(
      eventToChange(
        timed("c", "2026-10-01T15:00:00+03:00", "2026-10-01T16:00:00+03:00", {
          attendees: [{ email: "me@x.ua", self: true, responseStatus: "declined" }],
        }),
      ).kind,
    ).toBe("cancel");
    const change = eventToChange(
      timed("d", "2026-10-01T15:00:00+03:00", "2026-10-01T16:00:00+03:00", {
        hangoutLink: "https://meet.google.com/abc",
        attendees: [
          { email: "me@x.ua", self: true, responseStatus: "accepted" },
          { email: "Ivan@Example.com", displayName: "Іван", responseStatus: "needsAction" },
        ],
      }),
    );
    expect(change.kind).toBe("upsert");
    if (change.kind === "upsert") {
      expect(change.meeting.meet_url).toBe("https://meet.google.com/abc");
      expect(change.meeting.attendees).toEqual([{ email: "ivan@example.com", name: "Іван", response: "needsAction" }]);
      expect(change.meeting.start_at).toBe(Date.parse("2026-10-01T12:00:00Z"));
    }
  });
});

const HOUR = 3600_000;
const iso = (t: number) => new Date(t).toISOString();

/** Records silent property writes (PATCH …?sendUpdates=none) on any event. */
function propWrites(log: { id: string; props: Record<string, string> }[]) {
  return (url: URL, init: RequestInit & { bodyText: string }) => {
    if (init.method !== "PATCH" || url.searchParams.get("sendUpdates") !== "none") return undefined;
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
    log.push({ id, props: JSON.parse(init.bodyText).extendedProperties.private });
    return Response.json({ id });
  };
}

const sentTexts = (calls: Call[]) => tgCalls(calls, "sendMessage").map((m) => String(m.text));

describe("instant notices, remembered by Google itself", () => {
  const now = Date.now();
  const soon = now + 2 * 86400_000;

  it("reports a fresh invitation once, with ✅ Прийняти / ❌ Відхилити, and remembers its start on the event", async () => {
    await connectGoogle();
    const writes: { id: string; props: Record<string, string> }[] = [];
    const calls = mockFetch([propWrites(writes)]);
    const { env } = testEnv();
    const ev = timed("e1", iso(soon), iso(soon + HOUR), { created: iso(now - 60_000), updated: iso(now), organizer: { email: "boss@partner.ua" } });
    expect(await reportChange(env, ev, now)).toBe(true);
    expect(await reportChange(env, ev, now)).toBe(false);
    expect(sentTexts(calls)).toHaveLength(1);
    expect(sentTexts(calls)[0]).toContain("📅 <b>Запрошення на зустріч</b>");
    expect(readHidden(lastBotMessage("Запрошення"))).toEqual({ k: "ev", id: "e1" });
    expect(tgCalls(calls, "sendMessage")[0]!.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Прийняти", callback_data: "accept:e1" },
          { text: "❌ Відхилити", callback_data: "decline:e1" },
        ],
      ],
    });
    expect(writes).toEqual([{ id: "e1", props: { aisStart: String(soon) } }]);
  });

  it("an event the owner organizes is not announced (n8n: organizer.self)", async () => {
    await connectGoogle();
    const writes: { id: string; props: Record<string, string> }[] = [];
    const calls = mockFetch([propWrites(writes)]);
    const { env } = testEnv();
    const ev = timed("e3", iso(soon), iso(soon + HOUR), { created: iso(now - 60_000), updated: iso(now), organizer: { self: true } });
    expect(await reportChange(env, ev, now)).toBe(false);
    expect(sentTexts(calls)).toEqual([]);
    expect(writes).toHaveLength(1);
  });

  it("stays silent for an RSVP or description change (same start) and for the bot's own events", async () => {
    await connectGoogle();
    const calls = mockFetch([]);
    const { env } = testEnv();
    const known = timed("e1", iso(soon), iso(soon + HOUR), { updated: iso(now), extendedProperties: { private: { aisStart: String(soon) } } });
    expect(await reportChange(env, known, now)).toBe(false);
    const bots = timed("e2", iso(soon), iso(soon + HOUR), {
      created: iso(now),
      updated: iso(now),
      extendedProperties: { private: { aisStart: String(soon), aiSecretaryDraft: "d1" } },
    });
    expect(await reportChange(env, bots, now)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reports a move as було → стало and remembers the new start", async () => {
    await connectGoogle();
    const writes: { id: string; props: Record<string, string> }[] = [];
    const calls = mockFetch([propWrites(writes)]);
    const { env } = testEnv();
    const moved = timed("e1", iso(soon + 86400_000), iso(soon + 86400_000 + HOUR), {
      updated: iso(now),
      extendedProperties: { private: { aisStart: String(soon), other: "x" } },
    });
    expect(await reportChange(env, moved, now)).toBe(true);
    const text = sentTexts(calls)[0]!;
    expect(text).toContain("Подію перенесено");
    expect(text).toContain("Було:");
    expect(text).toContain("Стало:");
    expect(writes).toEqual([{ id: "e1", props: { aisStart: String(soon + 86400_000), other: "x" } }]);
  });

  it("an old event seen for the first time is only remembered, not announced", async () => {
    await connectGoogle();
    const writes: { id: string; props: Record<string, string> }[] = [];
    const calls = mockFetch([propWrites(writes)]);
    const { env } = testEnv();
    const old = timed("e1", iso(soon), iso(soon + HOUR), { created: iso(now - 30 * 86400_000), updated: iso(now) });
    expect(await reportChange(env, old, now)).toBe(false);
    expect(sentTexts(calls)).toEqual([]);
    expect(writes).toHaveLength(1);
  });

  it("reports a cancellation of a known event, but not one the bot cancelled itself", async () => {
    await connectGoogle();
    const full = (props: Record<string, string>) =>
      timed("e1", iso(soon), iso(soon + HOUR), { status: "cancelled", extendedProperties: { private: props } });
    let props: Record<string, string> = { aisStart: String(soon) };
    const calls = mockFetch([(url) => (url.pathname.endsWith("/events/e1") ? Response.json(full(props)) : undefined)]);
    const { env } = testEnv();
    expect(await reportChange(env, { id: "e1", status: "cancelled", updated: iso(now) }, now)).toBe(true);
    expect(sentTexts(calls)[0]).toContain("Подію скасовано");
    expect(sentTexts(calls)[0]).toContain("Event e1");

    props = { aisStart: String(soon), aisBotCancel: "1" };
    expect(await reportChange(env, { id: "e1", status: "cancelled", updated: iso(now + 1) }, now)).toBe(false);
  });

  it("ignores recurring instances, past events and repeated pushes for the same change", async () => {
    await connectGoogle();
    const writes: { id: string; props: Record<string, string> }[] = [];
    const calls = mockFetch([propWrites(writes)]);
    const { env } = testEnv();
    const fresh = { created: iso(now), updated: iso(now) };
    expect(await reportChange(env, timed("r", iso(soon), iso(soon + HOUR), { ...fresh, recurringEventId: "series" }), now)).toBe(false);
    expect(await reportChange(env, timed("p", iso(now - 3 * HOUR), iso(now - 2 * HOUR), fresh), now)).toBe(false);
    const ev = timed("e1", iso(soon), iso(soon + HOUR), fresh);
    expect(await reportChange(env, ev, now)).toBe(true);
    expect(await reportChange(env, ev, now)).toBe(false);
    expect(sentTexts(calls)).toHaveLength(1);
  });

  it("a push lists recently updated events, deleted ones included", async () => {
    await connectGoogle();
    let params: URLSearchParams | undefined;
    mockFetch([
      (url, init) => {
        if (!url.pathname.endsWith("/calendars/primary/events") || init.method === "POST") return undefined;
        params = url.searchParams;
        return Response.json({ items: [] });
      },
    ]);
    const { env } = testEnv();
    await syncRecent(env, now);
    expect(params!.get("showDeleted")).toBe("true");
    expect(Date.parse(params!.get("updatedMin")!)).toBe(now - 10 * 60_000);
  });

  it("marks upcoming events once so later moves can be told", async () => {
    await connectGoogle();
    const writes: { id: string; props: Record<string, string> }[] = [];
    mockFetch([
      propWrites(writes),
      (url, init) =>
        url.pathname.endsWith("/calendars/primary/events") && init.method !== "PATCH"
          ? Response.json({
              items: [
                timed("new", iso(soon), iso(soon + HOUR)),
                timed("known", iso(soon), iso(soon + HOUR), { extendedProperties: { private: { aisStart: String(soon) } } }),
                timed("rec", iso(soon), iso(soon + HOUR), { recurringEventId: "s" }),
              ],
            })
          : undefined,
    ]);
    const { env } = testEnv();
    expect(await markUpcoming(env, now)).toBe(3);
    expect(writes.map((w) => w.id)).toEqual(["new"]);
  });
});

describe("push channel without stored state", () => {
  it("watches with a per-day channel id and a derived token, and stops the previous days' channels", async () => {
    await connectGoogle();
    let watch: any;
    const stopped: string[] = [];
    mockFetch([
      (url, init) => {
        if (url.pathname.endsWith("/events/watch")) {
          watch = JSON.parse(init.bodyText);
          return Response.json({ id: watch.id, resourceId: "res-1" });
        }
        if (url.pathname.endsWith("/channels/stop")) {
          const body = JSON.parse(init.bodyText);
          expect(body.resourceId).toBe("res-1");
          stopped.push(body.id);
          return new Response(null, { status: 204 });
        }
        return undefined;
      },
    ]);
    const { env } = testEnv();
    await startWatch(env, Date.parse("2026-09-28T12:00:00Z"));
    expect(watch.id).toBe("ais-20260928");
    expect(watch.token).toBe(channelToken(env));
    expect(watch.address).toBe("https://bot.test/api/gcal-push");
    expect(stopped).toEqual(["ais-20260927", "ais-20260926", "ais-20260925"]);
  });

  it("accepts pushes only with the derived token", async () => {
    mockFetch([]);
    const { env, jobs } = testEnv();
    const push = (token: string, state = "exists") =>
      gcalPush(
        new Request("https://bot.test/api/gcal-push", {
          method: "POST",
          headers: { "x-goog-channel-id": "ais-20260928", "x-goog-channel-token": token, "x-goog-resource-state": state },
        }),
        env,
      );
    expect((await push("wrong")).status).toBe(200);
    expect(jobs).toEqual([]);
    await push(channelToken(env), "sync");
    expect(jobs).toEqual([]);
    await push(channelToken(env));
    expect(jobs.map((j) => j.body)).toEqual([{ type: "sync" }]);
  });

  it("the daily cron is protected by CRON_SECRET and queues the daily job", async () => {
    mockFetch([]);
    const { env, jobs } = testEnv();
    expect((await dailyCron(new Request("https://bot.test/api/cron/daily"), env)).status).toBe(401);
    const res = await dailyCron(new Request("https://bot.test/api/cron/daily", { headers: { authorization: "Bearer cron-secret" } }), env);
    expect(res.status).toBe(200);
    expect(jobs.map((j) => j.body)).toEqual([{ type: "daily" }]);
  });
});

describe("invitation notice (n8n «Формат: нова зустріч»)", () => {
  it("shows date, weekday, time with duration, organizer, guests' answers, the video link, place and description", () => {
    const text = invitationNotice({
      id: "x",
      summary: "Демо <продукту>",
      start: { dateTime: "2026-10-01T14:00:00+03:00" },
      end: { dateTime: "2026-10-01T15:30:00+03:00" },
      organizer: { email: "boss@partner.ua", displayName: "Бос" },
      attendees: [
        { email: "me@acme.ua", self: true, responseStatus: "needsAction" },
        { email: "anna@partner.ua", displayName: "Анна", responseStatus: "accepted" },
        { email: "petro@partner.ua", responseStatus: "declined" },
        { email: "ivan@partner.ua", responseStatus: "tentative" },
        { email: "olga@partner.ua" },
      ],
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }], conferenceSolution: { name: "Google Meet" } },
      location: "Офіс, 3 поверх",
      description: "<p>Порядок денний</p>",
    });
    expect(text).toBe(
      [
        "📅 <b>Запрошення на зустріч</b>",
        "",
        "📌 <b>Демо &lt;продукту&gt;</b>",
        "📆 01.10.2026 (четвер)",
        "🕐 14:00 — 15:30 (1 год 30 хв)",
        "",
        "👤 <b>Організатор:</b> Бос",
        "",
        "👥 <b>Учасники (4):</b>",
        "  ✅ Анна",
        "  ❌ petro",
        "  ❓ ivan",
        "  ⏳ olga",
        "",
        '🎥 <b>Google Meet:</b> <a href="https://meet.google.com/abc-defg-hij">Приєднатися</a>',
        "",
        "📍 <b>Місце:</b> Офіс, 3 поверх",
        "",
        "📝 <b>Опис:</b>",
        "<i>Порядок денний</i>",
      ].join("\n"),
    );
  });

  it("finds a Zoom link in the description; an id too long for callback_data gets no buttons", () => {
    const text = invitationNotice({
      id: "z",
      summary: "Zoom",
      start: { dateTime: "2026-10-01T09:00:00+03:00" },
      end: { dateTime: "2026-10-01T09:30:00+03:00" },
      description: "Join https://us02web.zoom.us/j/123456?pwd=abc",
    });
    expect(text).toContain('🎥 <b>Zoom:</b> <a href="https://us02web.zoom.us/j/123456?pwd=abc">Приєднатися</a>');
    expect(text).toContain("(30 хв)");
    expect(text).not.toContain("Опис");
    expect(invitationButtons("a".repeat(60))).toBeUndefined();
  });
});
