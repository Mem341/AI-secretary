import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gmailSync } from "../src/google/gmailPush";
import { loadOwnerSettings, saveOwnerSettings } from "../src/google/oauth";
import { ensureGmailPush, setupGoogleWake } from "../src/google/pubsub";
import { desiredReminders, eventIdFromEmail } from "../src/google/reminders";
import type { GMessage } from "../src/google/gmail";
import { connectGoogle, GMAIL_SCOPE, lastBotMessage, mockFetch, resetInstance, testEnv, tgCalls } from "./helpers";

const FULL_SCOPE = `${GMAIL_SCOPE} https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/pubsub`;
const MIN = 60_000;

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

/** A fake Pub/Sub API: records what the bot created. */
function fakePubSub(disabled = false) {
  const made: { topic?: boolean; policy?: unknown; subscription?: Record<string, unknown> } = {};
  const route = (url: URL, init: RequestInit & { bodyText: string }) => {
    if (url.hostname !== "pubsub.googleapis.com") return undefined;
    if (disabled) return Response.json({ error: { status: "PERMISSION_DENIED", message: "Cloud Pub/Sub API has not been used in project p1 before or it is disabled. SERVICE_DISABLED" } }, { status: 403 });
    const path = url.pathname;
    // Like Google: the policy is read with GET only; a POST gets an HTML 404.
    if (path.endsWith(":getIamPolicy")) return init.method === "GET" ? Response.json({ etag: "x" }) : new Response("<!DOCTYPE html><title>Error 404</title>", { status: 404 });
    if (path.endsWith(":setIamPolicy")) {
      made.policy = JSON.parse(init.bodyText).policy;
      return Response.json(made.policy);
    }
    if (path.includes("/topics/")) {
      made.topic = true;
      return Response.json({ name: path });
    }
    if (path.includes("/subscriptions/")) {
      made.subscription = JSON.parse(init.bodyText);
      return Response.json(made.subscription);
    }
    return undefined;
  };
  return { made, route };
}

describe("Google as the bot's clock (no cron, no outside service)", () => {
  it("sets up Gmail → bot push in the owner's own project: topic, Gmail's publish right, push subscription", async () => {
    await connectGoogle({ scope: FULL_SCOPE });
    const ps = fakePubSub();
    mockFetch([ps.route]);
    const { env } = testEnv({ GOOGLE_PROJECT_ID: "p1" });
    expect(await ensureGmailPush(env)).toEqual({ ok: true });
    expect(ps.made.topic).toBe(true);
    expect(ps.made.policy).toMatchObject({ bindings: [{ role: "roles/pubsub.publisher", members: ["serviceAccount:gmail-api-push@system.gserviceaccount.com"] }] });
    expect(ps.made.subscription).toMatchObject({
      topic: "projects/p1/topics/ai-secretary-gmail",
      pushConfig: { pushEndpoint: expect.stringMatching(/^https:\/\/bot\.test\/api\/gmail-push\?token=/) },
    });
  });

  it("says exactly what is missing: the Pub/Sub API switched off, or an old Google permission", async () => {
    await connectGoogle({ scope: FULL_SCOPE });
    mockFetch([fakePubSub(true).route]);
    const { env } = testEnv({ GOOGLE_PROJECT_ID: "p1" });
    expect(await ensureGmailPush(env)).toMatchObject({ ok: false, reason: "api_disabled" });
    resetInstance();
    await connectGoogle();
    expect(await ensureGmailPush(testEnv({ GOOGLE_PROJECT_ID: "p1" }).env)).toMatchObject({ ok: false, reason: "no_scope" });
  });

  it("then gives the owner's upcoming meetings reminder emails at the chosen minutes (a series once, on its master)", async () => {
    await connectGoogle({ scope: FULL_SCOPE });
    const soon = Date.now() + 3 * 3600_000;
    const set: { id: string; reminders: unknown }[] = [];
    let watched = "";
    mockFetch([
      fakePubSub().route,
      (url, init) => {
        if (url.hostname !== "gmail.googleapis.com") return undefined;
        if (url.pathname.endsWith("/watch")) watched = JSON.parse(init.bodyText).topicName;
        if (url.pathname.endsWith("/labels")) return Response.json(init.method === "POST" ? { id: "L1", name: "AI-secretary-seen" } : { labels: [] });
        if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
        return Response.json({});
      },
      (url, init) => {
        if (url.hostname !== "www.googleapis.com" || !url.pathname.startsWith("/calendar/")) return undefined;
        if (init.method === "PATCH") {
          set.push({ id: decodeURIComponent(url.pathname.split("/").at(-1)!), reminders: JSON.parse(init.bodyText).reminders });
          return Response.json({});
        }
        const at = (h: number) => new Date(soon + h * 3600_000).toISOString();
        return Response.json({
          items: [
            { id: "one", status: "confirmed", start: { dateTime: at(0) }, end: { dateTime: at(1) }, reminders: { useDefault: true } },
            { id: "s_1", recurringEventId: "series", status: "confirmed", start: { dateTime: at(24) }, end: { dateTime: at(25) } },
            { id: "s_2", recurringEventId: "series", status: "confirmed", start: { dateTime: at(48) }, end: { dateTime: at(49) } },
            { id: "done", status: "confirmed", start: { dateTime: at(2) }, end: { dateTime: at(3) }, reminders: desiredReminders([60, 30, 10, 5]) },
          ],
        });
      },
    ]);
    const { env } = testEnv({ GOOGLE_PROJECT_ID: "p1" });
    await saveOwnerSettings(env, { r: [60, 30, 10, 5] });
    expect(await setupGoogleWake(env)).toEqual({ ok: true });
    expect(watched).toBe("projects/p1/topics/ai-secretary-gmail");
    expect((await loadOwnerSettings(env)).p).toBe("ok");
    expect(set.map((s) => s.id)).toEqual(["one", "series"]);
    expect(set[0]!.reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: "email", minutes: 60 },
        { method: "email", minutes: 30 },
        { method: "email", minutes: 10 },
        { method: "email", minutes: 5 },
        // No signal calendar yet (older permission): the 5th place goes to a Calendar notification, nearest first.
        { method: "popup", minutes: 5 },
      ],
    });
  });

  it("the calendar's reminder email becomes a Telegram reminder (not «Нова пошта»), and goes to Trash", async () => {
    await connectGoogle({ scope: FULL_SCOPE });
    const start = Date.now() + 30 * MIN;
    const eid = Buffer.from("evt123 owner@acme.ua").toString("base64url");
    const email: GMessage = {
      id: "m1",
      threadId: "t1",
      snippet: "",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Google Calendar <calendar-notification@google.com>" },
          { name: "Subject", value: "Notification: Планування @ Tue Sep 29, 2026 4pm - 5pm (EEST) (owner@acme.ua)" },
        ],
        body: { data: Buffer.from(`Планування\nhttps://calendar.google.com/calendar/event?action=VIEW&eid=${eid}&tok=abc`).toString("base64url") },
      },
    } as GMessage;
    expect(eventIdFromEmail(email)).toBe("evt123");
    let trashed = false;
    const calls = mockFetch([
      (url, init) => {
        if (url.hostname !== "gmail.googleapis.com") return undefined;
        if (url.pathname.endsWith("/labels")) return Response.json(init.method === "POST" ? { id: "L1", name: "AI-secretary-seen" } : { labels: [] });
        if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }] });
        if (url.pathname.endsWith("/trash")) {
          trashed = true;
          return Response.json({});
        }
        if (url.pathname.endsWith("/messages/m1")) return Response.json(email);
        return Response.json({});
      },
      (url, init) => {
        if (url.hostname !== "www.googleapis.com" || !url.pathname.includes("/events/evt123")) return undefined;
        if (init.method === "PATCH") return Response.json({});
        return Response.json({
          id: "evt123",
          etag: '"e1"',
          status: "confirmed",
          summary: "Планування",
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(start + 60 * MIN).toISOString() },
          hangoutLink: "https://meet.google.com/abc-defg-hij",
        });
      },
    ]);
    const { env } = testEnv();
    await saveOwnerSettings(env, { r: [30, 10] });
    await gmailSync(env);
    expect(lastBotMessage("⏰").text).toContain("Через 30 хв:</b> Планування");
    expect(tgCalls(calls, "sendMessage").some((m) => String(m.text).includes("Нова пошта"))).toBe(false);
    expect(trashed).toBe(true);
  });
});

describe("reminder emails in any language of the calendar", () => {
  it("recognises Ukrainian and Russian subjects too (a Cyrillic word has no \\b boundary in JS)", async () => {
    const { handleReminderEmail } = await import("../src/google/reminders");
    mockFetch([(url) => (url.hostname === "www.googleapis.com" || url.hostname === "gmail.googleapis.com" ? Response.json({}) : undefined)]);
    const { env } = testEnv();
    await connectGoogle();
    const mail = (subject: string) =>
      ({
        id: "m",
        threadId: "t",
        payload: {
          headers: [
            { name: "From", value: "Google Календар <calendar-notification@google.com>" },
            { name: "Subject", value: subject },
          ],
          body: { data: Buffer.from(`https://calendar.google.com/calendar/event?action=VIEW&eid=${Buffer.from("e1 a@b.c").toString("base64url")}`).toString("base64url") },
        },
      }) as never;
    expect(await handleReminderEmail(env, mail("Нагадування: Стендап @ вт 29 вер. 2026"))).toBe(true);
    expect(await handleReminderEmail(env, mail("Уведомление: Стендап @ вт 29 сент. 2026"))).toBe(true);
    expect(await handleReminderEmail(env, mail("Запрошення: Стендап"))).toBe(false);
  });
});

describe("each chosen time: a Telegram message AND a Google Calendar notification", () => {
  const SIGNAL_SCOPE = `${FULL_SCOPE} https://www.googleapis.com/auth/calendar.app.created`;

  it("the meeting keeps Calendar notifications at all times; its Telegram signals go on a shadow in the bot's own calendar", async () => {
    await connectGoogle({ scope: SIGNAL_SCOPE });
    const soon = Date.now() + 3 * 3600_000;
    const at = (h: number) => new Date(soon + h * 3600_000).toISOString();
    const primaryPatches: { id: string; reminders: unknown }[] = [];
    const shadows = new Map<string, Record<string, unknown>>([["aisdead00000000000000000000000", { id: "aisdead00000000000000000000000", extendedProperties: { private: { aisFor: "gone" } } }]]);
    let created = "";
    mockFetch([
      fakePubSub().route,
      (url, init) => (url.hostname === "gmail.googleapis.com" ? Response.json(url.pathname.endsWith("/labels") ? { labels: [{ id: "L", name: "AI-secretary-seen" }] } : {}) : undefined),
      (url, init) => {
        if (url.hostname !== "www.googleapis.com" || !url.pathname.startsWith("/calendar/v3/")) return undefined;
        const path = decodeURIComponent(url.pathname);
        if (path === "/calendar/v3/calendars" && init.method === "POST") {
          created = JSON.parse(init.bodyText).summary;
          return Response.json({ id: "sig@group.calendar.google.com" });
        }
        if (path.startsWith("/calendar/v3/calendars/sig@group.calendar.google.com/events")) {
          const id = path.split("/").at(-1)!;
          if (init.method === "PUT") {
            shadows.set(id, JSON.parse(init.bodyText));
            return Response.json({ id });
          }
          if (init.method === "DELETE") {
            shadows.delete(id);
            return new Response(null, { status: 204 });
          }
          return Response.json({ items: [...shadows.values()] });
        }
        if (init.method === "PATCH") {
          primaryPatches.push({ id: path.split("/").at(-1)!, reminders: JSON.parse(init.bodyText).reminders });
          return Response.json({});
        }
        return Response.json({ items: [{ id: "one", status: "confirmed", summary: "Планування", start: { dateTime: at(0) }, end: { dateTime: at(1) } }] });
      },
    ]);
    const { env } = testEnv({ GOOGLE_PROJECT_ID: "p1" });
    await saveOwnerSettings(env, { r: [60, 30, 10, 5] });
    expect(await setupGoogleWake(env)).toEqual({ ok: true });

    expect(created).toBe("AI-secretary · сигнали");
    // The meeting: Calendar notifications at every chosen time.
    expect(primaryPatches).toEqual([
      { id: "one", reminders: { useDefault: false, overrides: [60, 30, 10, 5].map((minutes) => ({ method: "popup", minutes })) } },
    ]);
    // Its shadow: the email signals that wake the bot for Telegram, at the same times; the stale shadow is gone.
    const { shadowId } = await import("../src/google/signals");
    // (plus the morning report's signals for today and tomorrow)
    const meetingShadows = [...shadows.entries()].filter(([, v]) => !String((v.extendedProperties as { private: { aisFor: string } }).private.aisFor).startsWith("digest:"));
    expect(meetingShadows.map(([k]) => k)).toEqual([shadowId("one")]);
    expect(shadows.get(shadowId("one"))).toMatchObject({
      summary: "🔔 Планування",
      transparency: "transparent",
      visibility: "private",
      reminders: { useDefault: false, overrides: [60, 30, 10, 5].map((minutes) => ({ method: "email", minutes })) },
      extendedProperties: { private: { aisFor: "one" } },
    });
  });
});

describe("a signal from the bot's calendar", () => {
  it("becomes the reminder of the owner's meeting it shadows", async () => {
    await connectGoogle({ scope: FULL_SCOPE });
    const { shadowId } = await import("../src/google/signals");
    const { handleReminderEmail } = await import("../src/google/reminders");
    const sid = shadowId("meet1");
    const start = Date.now() + 10 * MIN;
    const calls = mockFetch([
      (url) => (url.hostname === "gmail.googleapis.com" ? Response.json({}) : undefined),
      (url, init) => {
        if (url.hostname !== "www.googleapis.com") return undefined;
        const path = decodeURIComponent(url.pathname);
        if (path.endsWith(`/sig@x/events/${sid}`)) return Response.json({ id: sid, extendedProperties: { private: { aisFor: "meet1" } } });
        if (path.endsWith("/primary/events/meet1") && (init.method ?? "GET") === "GET")
          return Response.json({ id: "meet1", status: "confirmed", summary: "Стендап", start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + 30 * MIN).toISOString() } });
        return Response.json({});
      },
    ]);
    const { env } = testEnv();
    await saveOwnerSettings(env, { r: [30, 10], sc: "sig@x" });
    const email = {
      id: "m",
      threadId: "t",
      payload: {
        headers: [
          { name: "From", value: "Google Calendar <calendar-notification@google.com>" },
          { name: "Subject", value: "Нагадування: 🔔 Стендап @ вт 29 вер. 2026" },
        ],
        body: { data: Buffer.from(`https://calendar.google.com/calendar/event?action=VIEW&eid=${Buffer.from(`${sid} sig@x`).toString("base64url")}`).toString("base64url") },
      },
    } as never;
    expect(await handleReminderEmail(env, email)).toBe(true);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Через 10 хв:</b> Стендап");
  });
});

describe("«🔁 Налаштувати»: every link of the chain", () => {
  it("an old Google connection (API enabled, but no new permissions): says to reconnect, touches nothing", async () => {
    await connectGoogle();
    const calls = mockFetch([]);
    const { env } = testEnv({ GOOGLE_PROJECT_ID: "p1" });
    const { reportWake } = await import("../src/google/wake");
    await reportWake(env, env.OWNER_TELEGRAM_ID);
    const msg = tgCalls(calls, "sendMessage").at(-1)!;
    expect(String(msg.text)).toContain("не поставлено галочки");
    expect(String(msg.text)).toContain("Pub/Sub");
    expect(JSON.stringify(msg.reply_markup)).toContain("з усіма галочками");
  });

  it("all set: every step ✅ and no test event left in the calendar", async () => {
    await connectGoogle({ scope: `${FULL_SCOPE} https://www.googleapis.com/auth/calendar.app.created` });
    const shadows = new Map<string, Record<string, unknown>>();
    const calls = mockFetch([
      fakePubSub().route,
      (url) => {
        if (url.hostname !== "gmail.googleapis.com") return undefined;
        if (url.pathname.endsWith("/labels")) return Response.json({ labels: [{ id: "L", name: "AI-secretary-seen" }] });
        if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
        return Response.json({});
      },
      (url, init) => {
        if (url.hostname !== "www.googleapis.com" || !url.pathname.startsWith("/calendar/v3/")) return undefined;
        const path = decodeURIComponent(url.pathname);
        if (path.startsWith("/calendar/v3/calendars/sig@x/events")) {
          const id = path.split("/").at(-1)!;
          if (init.method === "PUT") {
            shadows.set(id, JSON.parse(init.bodyText));
            return Response.json({ id });
          }
          return Response.json({ items: [...shadows.values()] });
        }
        return Response.json({ items: [] });
      },
    ]);
    const { env } = testEnv({ GOOGLE_PROJECT_ID: "p1" });
    await saveOwnerSettings(env, { r: [30, 10], sc: "sig@x", d: false });
    const { reportWake } = await import("../src/google/wake");
    await reportWake(env, env.OWNER_TELEGRAM_ID);
    const report = String(tgCalls(calls, "sendMessage").at(-1)!.text);
    expect(report).toContain("✅ <b>Pub/Sub");
    expect(report).toContain("Усе налаштовано");
    expect(report).not.toContain("Тест");
    expect(shadows.size).toBe(0);
  });
});
