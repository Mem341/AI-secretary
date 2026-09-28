import { env as baseEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { GEvent } from "../src/google/calendar";
import { eventToChange, fullSync, incrementalSync, startWatch } from "../src/google/sync";
import { encrypt } from "../src/lib/crypto";
import type { Env } from "../src/env";
import { mockFetch, resetDb, testEnv } from "./helpers";

const env = baseEnv as unknown as Env;

async function seedOwner(): Promise<number> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "INSERT INTO users (tg_id, full_name, role, created_at, updated_at) VALUES (1000, 'Олександр Коваленко', 'owner', ?, ?) RETURNING id",
  )
    .bind(now, now)
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO google_auth (user_id, refresh_token_enc, access_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(row!.id, await encrypt(env.ENCRYPTION_KEY, "refresh"), await encrypt(env.ENCRYPTION_KEY, "access"), now + 3600_000, now)
    .run();
  return row!.id;
}

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

describe("push sync", () => {
  let userId: number;
  beforeEach(async () => {
    await resetDb();
    userId = await seedOwner();
  });
  afterEach(() => vi.restoreAllMocks());

  it("subscribes with events.watch, syncs the window, then applies incremental changes", async () => {
    const soon = Date.now() + 2 * 86400_000;
    const iso = (t: number) => new Date(t).toISOString();
    let listCall = 0;
    const calls = mockFetch([
      (url) =>
        url.pathname.endsWith("/events/watch")
          ? Response.json({ id: "ch", resourceId: "res-1", expiration: String(Date.now() + 7 * 86400_000) })
          : undefined,
      (url) => {
        if (!url.pathname.endsWith("/calendars/primary/events")) return undefined;
        listCall++;
        if (listCall === 1) {
          expect(url.searchParams.get("timeMin")).toBeTruthy();
          return Response.json({
            items: [timed("e1", iso(soon), iso(soon + 3600_000)), timed("e2", iso(soon + 7200_000), iso(soon + 10800_000))],
            nextSyncToken: "sync-1",
          });
        }
        expect(url.searchParams.get("syncToken")).toBe("sync-1");
        return Response.json({
          items: [
            timed("e1", iso(soon + 86400_000), iso(soon + 86400_000 + 3600_000)),
            { id: "e2", status: "cancelled" },
          ],
          nextSyncToken: "sync-2",
        });
      },
    ]);

    await startWatch(env, userId);
    const watch = calls.find((c) => c.url.endsWith("/events/watch"))!.body as Record<string, string>;
    expect(watch.address).toBe("https://bot.test/gcal/push");
    expect(watch.type).toBe("web_hook");
    expect(watch.token).toHaveLength(32);

    expect(await fullSync(env, userId)).toBe(2);
    expect(await incrementalSync(env, userId)).toBe(2);

    const { results } = await env.DB.prepare("SELECT gcal_event_id, status, start_at FROM meetings ORDER BY gcal_event_id").all();
    expect(results).toEqual([
      { gcal_event_id: "e1", status: "confirmed", start_at: soon + 86400_000 },
      { gcal_event_id: "e2", status: "cancelled", start_at: soon + 7200_000 },
    ]);
    const ch = await env.DB.prepare("SELECT sync_token FROM watch_channels").first<{ sync_token: string }>();
    expect(ch!.sync_token).toBe("sync-2");
  });

  it("falls back to a full sync when Google answers 410 for the sync token", async () => {
    await env.DB.prepare(
      "INSERT INTO watch_channels (user_id, channel_id, resource_id, token, expiration, sync_token, updated_at) VALUES (?, 'c', 'r', 't', 0, 'stale', 0)",
    )
      .bind(userId)
      .run();
    mockFetch([
      (url) =>
        url.searchParams.get("syncToken")
          ? new Response("gone", { status: 410 })
          : Response.json({ items: [], nextSyncToken: "fresh" }),
    ]);
    await incrementalSync(env, userId);
    const ch = await env.DB.prepare("SELECT sync_token FROM watch_channels").first<{ sync_token: string }>();
    expect(ch!.sync_token).toBe("fresh");
  });

  it("accepts pushes only with the channel's secret token and queues a sync", async () => {
    await env.DB.prepare(
      "INSERT INTO watch_channels (user_id, channel_id, resource_id, token, expiration, updated_at) VALUES (?, 'chan-1', 'r', 'secret-token', 0, 0)",
    )
      .bind(userId)
      .run();
    const { env: qEnv, jobs } = testEnv();
    const push = (token: string, state = "exists") =>
      worker.fetch(
        new Request("https://bot.test/gcal/push", {
          method: "POST",
          headers: { "x-goog-channel-id": "chan-1", "x-goog-channel-token": token, "x-goog-resource-state": state },
        }),
        qEnv,
        {} as ExecutionContext,
      );
    expect((await push("wrong")).status).toBe(200);
    expect(jobs).toEqual([]);
    await push("secret-token", "sync");
    expect(jobs).toEqual([]);
    await push("secret-token");
    expect(jobs).toEqual([{ body: { type: "sync", userId }, delaySeconds: undefined }]);
  });
});
