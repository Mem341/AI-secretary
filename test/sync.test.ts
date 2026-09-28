import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyCron, gcalPush } from "../src/app";
import type { Db } from "../src/db/client";
import type { Env } from "../src/env";
import type { GEvent } from "../src/google/calendar";
import { eventToChange, fullSync, incrementalSync, startWatch } from "../src/google/sync";
import { encrypt } from "../src/lib/crypto";
import { mockFetch, pgliteDb, resetDb, testConfig, testEnv } from "./helpers";

let db: Db;
let env: Env;

beforeAll(async () => {
  db = await pgliteDb();
});

async function seedOwner(): Promise<number> {
  const now = Date.now();
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO users (tg_id, full_name, created_at, updated_at) VALUES (1000, 'Олександр Коваленко', $1, $1) RETURNING id",
    [now],
  );
  await db.query(
    "INSERT INTO google_auth (user_id, refresh_token_enc, access_token, expires_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
    [
      rows[0]!.id,
      await encrypt(testConfig.ENCRYPTION_KEY, "refresh"),
      await encrypt(testConfig.ENCRYPTION_KEY, "access"),
      now + 3600_000,
      now,
    ],
  );
  return rows[0]!.id;
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
    await resetDb(db);
    env = testEnv(db).env;
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
          items: [timed("e1", iso(soon + 86400_000), iso(soon + 86400_000 + 3600_000)), { id: "e2", status: "cancelled" }],
          nextSyncToken: "sync-2",
        });
      },
    ]);

    await startWatch(env, userId);
    const watch = calls.find((c) => c.url.endsWith("/events/watch"))!.body as Record<string, string>;
    expect(watch.address).toBe("https://bot.test/api/gcal-push");
    expect(watch.type).toBe("web_hook");
    expect(watch.token).toHaveLength(32);

    expect(await fullSync(env, userId)).toBe(2);
    expect(await incrementalSync(env, userId)).toBe(2);

    const { rows } = await db.query("SELECT gcal_event_id, status, start_at FROM meetings ORDER BY gcal_event_id");
    expect(rows).toEqual([
      { gcal_event_id: "e1", status: "confirmed", start_at: soon + 86400_000 },
      { gcal_event_id: "e2", status: "cancelled", start_at: soon + 7200_000 },
    ]);
    const { rows: ch } = await db.query<{ sync_token: string }>("SELECT sync_token FROM watch_channels");
    expect(ch[0]!.sync_token).toBe("sync-2");
  });

  it("cancels mirrored meetings that disappeared from the window during a full sync", async () => {
    const soon = Date.now() + 86400_000;
    let round = 0;
    mockFetch([
      (url) => {
        if (!url.pathname.endsWith("/calendars/primary/events")) return undefined;
        round++;
        const items = [timed("keep", new Date(soon).toISOString(), new Date(soon + 3600_000).toISOString())];
        if (round === 1) items.push(timed("gone", new Date(soon).toISOString(), new Date(soon + 3600_000).toISOString()));
        return Response.json({ items, nextSyncToken: `t${round}` });
      },
    ]);
    await fullSync(env, userId);
    await fullSync(env, userId);
    const { rows } = await db.query("SELECT gcal_event_id, status FROM meetings ORDER BY gcal_event_id");
    expect(rows).toEqual([
      { gcal_event_id: "gone", status: "cancelled" },
      { gcal_event_id: "keep", status: "confirmed" },
    ]);
  });

  it("falls back to a full sync when Google answers 410 for the sync token", async () => {
    await db.query(
      `INSERT INTO watch_channels (user_id, channel_id, resource_id, token, expiration, sync_token, updated_at)
       VALUES ($1, 'c', 'r', 't', 0, 'stale', 0)`,
      [userId],
    );
    mockFetch([
      (url) => (url.searchParams.get("syncToken") ? new Response("gone", { status: 410 }) : Response.json({ items: [], nextSyncToken: "fresh" })),
    ]);
    await incrementalSync(env, userId);
    const { rows } = await db.query<{ sync_token: string }>("SELECT sync_token FROM watch_channels");
    expect(rows[0]!.sync_token).toBe("fresh");
  });

  it("accepts pushes only with the channel's secret token and queues a sync", async () => {
    await db.query(
      `INSERT INTO watch_channels (user_id, channel_id, resource_id, token, expiration, updated_at)
       VALUES ($1, 'chan-1', 'r', 'secret-token', 0, 0)`,
      [userId],
    );
    const { env: qEnv, jobs } = testEnv(db);
    const push = (token: string, state = "exists") =>
      gcalPush(
        new Request("https://bot.test/api/gcal-push", {
          method: "POST",
          headers: { "x-goog-channel-id": "chan-1", "x-goog-channel-token": token, "x-goog-resource-state": state },
        }),
        qEnv,
      );
    expect((await push("wrong")).status).toBe(200);
    expect(jobs).toEqual([]);
    await push("secret-token", "sync");
    expect(jobs).toEqual([]);
    await push("secret-token");
    expect(jobs).toEqual([{ body: { type: "sync", userId }, delaySeconds: undefined }]);
  });

  it("daily cron requires the cron secret and renews channels close to expiration", async () => {
    await db.query(
      `INSERT INTO watch_channels (user_id, channel_id, resource_id, token, expiration, updated_at)
       VALUES ($1, 'chan-1', 'r', 't', $2, 0)`,
      [userId, Date.now() + 3600_000],
    );
    const { env: qEnv, jobs } = testEnv(db);
    const call = (auth?: string) =>
      dailyCron(new Request("https://bot.test/api/cron/daily", { headers: auth ? { authorization: auth } : {} }), qEnv);
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect((await call("Bearer cron-secret")).status).toBe(200);
    expect(jobs.map((j) => j.body)).toEqual([{ type: "daily", userId, renew: true }]);
  });
});
