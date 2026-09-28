import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyCron, healthCheck, oauthStart, setupBootErrorPage, setupPage } from "../src/app";
import { ConfigError, loadConfig } from "../src/env";
import { connectLink, getAccessToken, GoogleAuthRevokedError, hasGoogleAuth } from "../src/google/oauth";
import { encrypt } from "../src/lib/crypto";
import { hiddenData } from "../src/telegram/hidden";
import { connectGoogle, mockFetch, OWNER, resetInstance, testConfig, testEnv, tg, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

describe("loadConfig", () => {
  const minimal = {
    OWNER_TELEGRAM_ID: "123456789",
    TELEGRAM_BOT_TOKEN: "111:AAA",
    OPENROUTER_API_KEY: "or",
    VERCEL_PROJECT_PRODUCTION_URL: "my-bot.vercel.app",
  };

  it("needs only three variables; the rest is optional or derived", () => {
    const c = loadConfig(minimal);
    expect(c.PUBLIC_URL).toBe("https://my-bot.vercel.app");
    expect(c.OWNER_TELEGRAM_ID).toBe(123456789);
    expect(c.TELEGRAM_WEBHOOK_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(c.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(c.ENCRYPTION_KEY).not.toBe(c.TELEGRAM_WEBHOOK_SECRET);
    // Derived secrets are stable across instances of the same deployment.
    expect(loadConfig(minimal).ENCRYPTION_KEY).toBe(c.ENCRYPTION_KEY);
    expect(c.GOOGLE_CLIENT_ID).toBe("");
    expect(c.STT_MODEL).toBe("google/gemini-2.5-flash");
    expect(c.CRON_SECRET).toBe("");
    expect(c.DEFAULT_DURATION_MIN).toBe(60);
    expect(c.DEFAULT_FORMAT).toBe("offline");
  });

  it("reads the optional profile and meeting defaults", () => {
    const c = loadConfig({ ...minimal, OWNER_NAME: "Олена Іваненко", DEFAULT_DURATION_MIN: "30", DEFAULT_FORMAT: "google_meet", DEFAULT_ADDRESS: "Офіс" });
    expect(c.OWNER_NAME).toBe("Олена Іваненко");
    expect(c.DEFAULT_DURATION_MIN).toBe(30);
    expect(c.DEFAULT_FORMAT).toBe("google_meet");
    expect(loadConfig({ ...minimal, DEFAULT_DURATION_MIN: "abc", DEFAULT_FORMAT: "teams" }).DEFAULT_FORMAT).toBe("offline");
  });

  it("prefers explicit secrets and a custom PUBLIC_URL", () => {
    const c = loadConfig({ ...minimal, ENCRYPTION_KEY: "mine", PUBLIC_URL: "https://bot.example.com/" });
    expect(c.ENCRYPTION_KEY).toBe("mine");
    expect(c.PUBLIC_URL).toBe("https://bot.example.com");
  });

  it("lists every missing variable and rejects a non-numeric owner id", () => {
    expect(() => loadConfig({})).toThrow(
      new ConfigError("Missing environment variables: OWNER_TELEGRAM_ID, TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY, PUBLIC_URL"),
    );
    expect(() => loadConfig({ ...minimal, OWNER_TELEGRAM_ID: "@me" })).toThrow(/numeric Telegram user id/);
  });
});

describe("/api/setup", () => {
  it("registers the webhook with the secret and shows what is left to do", async () => {
    let webhookUrl = "";
    const calls = mockFetch([
      (url) => (url.pathname.endsWith("/getMe") ? Response.json({ ok: true, result: { username: "my_secretary_bot" } }) : undefined),
      (url) =>
        url.pathname.endsWith("/getWebhookInfo") ? Response.json({ ok: true, result: { url: webhookUrl, max_connections: webhookUrl ? 1 : 40 } }) : undefined,
      (url, init) => {
        if (!url.pathname.endsWith("/setWebhook")) return undefined;
        webhookUrl = JSON.parse(init.bodyText).url;
        return Response.json({ ok: true, result: true });
      },
    ]);
    const { env } = testEnv({ GOOGLE_CLIENT_ID: "" });

    const html = await (await setupPage(new Request("https://bot.test/api/setup"), env)).text();
    expect(tgCalls(calls, "setWebhook")).toEqual([
      {
        url: "https://bot.test/api/telegram",
        secret_token: "tg-secret",
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
        max_connections: 1,
      },
    ]);
    expect(tgCalls(calls, "setMyCommands")).toHaveLength(1);
    expect(html).toContain("@my_secretary_bot");
    expect(html).toContain("https://bot.test/api/oauth/callback");
    expect(html).toContain("Готово 2 з 4");
    expect(html).not.toContain("База даних");
    expect(html).not.toContain("tg-secret");
    expect(html).not.toContain(String(OWNER));

    // Opening the page again does not re-register the webhook.
    await setupPage(new Request("https://bot.test/api/setup"), env);
    expect(tgCalls(calls, "setWebhook")).toHaveLength(1);
  });

  it("explains missing variables when the deployment cannot start — and nothing about a database", async () => {
    const html = await setupBootErrorPage({ TELEGRAM_BOT_TOKEN: "x" }, "boom").text();
    expect(html).toContain("OWNER_TELEGRAM_ID");
    expect(html).toContain("OPENROUTER_API_KEY");
    expect(html).toContain("@userinfobot");
    expect(html).not.toContain("DATABASE_URL");
  });

  it("health reports the webhook and the Google connection, with no database to check", async () => {
    await connectGoogle();
    mockFetch([(url) => (url.pathname.endsWith("/getWebhookInfo") ? Response.json({ ok: true, result: { url: "https://bot.test/api/telegram" } }) : undefined)]);
    const { env } = testEnv();
    const body = (await (await healthCheck(new Request("https://bot.test/api/health"), env)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, telegram_webhook: true, owner_started: true, google_connected: true, gmail_connected: true });
    expect(body).not.toHaveProperty("database");
  });
});

describe("optional features", () => {
  it("without a Google OAuth client, calendar buttons lead to the setup page", async () => {
    const { env } = testEnv({ GOOGLE_CLIENT_ID: "" });
    expect(await connectLink(env)).toBe("https://bot.test/api/setup");
    const res = await oauthStart(new Request("https://bot.test/api/oauth/start?state=x"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://bot.test/api/setup");
  });

  it("daily cron is open when CRON_SECRET is not set", async () => {
    mockFetch([]);
    const { env } = testEnv({ CRON_SECRET: "" });
    expect((await dailyCron(new Request("https://bot.test/api/cron/daily"), env)).status).toBe(200);
    expect(testConfig.CRON_SECRET).toBe("cron-secret");
  });
});

describe("changed encryption key", () => {
  it("treats a grant encrypted with another key as not connected, and asks to reconnect", async () => {
    tg.pinned = tg.message(hiddenData({ k: "google", t: await encrypt("old-key", JSON.stringify({ refresh_token: "r", scope: "", email: null })) }));
    mockFetch([]);
    const { env } = testEnv();
    expect(await hasGoogleAuth(env)).toBe(false);
    await expect(getAccessToken(env)).rejects.toBeInstanceOf(GoogleAuthRevokedError);
  });
});
