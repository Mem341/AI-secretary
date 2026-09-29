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
    if (path.endsWith(":getIamPolicy")) return Response.json({ etag: "x" });
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
        { method: "popup", minutes: 10 },
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
