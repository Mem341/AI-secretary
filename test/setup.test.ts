import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyCron, oauthStart, setupBootErrorPage, setupPage } from "../src/app";
import type { Db } from "../src/db/client";
import { ConfigError, loadConfig } from "../src/env";
import { connectLink } from "../src/google/oauth";
import { handleUpdate } from "../src/telegram/handler";
import { mockFetch, OWNER, pgliteDb, resetDb, testConfig, testEnv, tgCalls } from "./helpers";

let db: Db;
beforeAll(async () => {
  db = await pgliteDb();
});
beforeEach(async () => {
  await resetDb(db);
});
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
    expect(c.ELEVENLABS_API_KEY).toBe("");
    expect(c.CRON_SECRET).toBe("");
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
      (url) => (url.pathname.endsWith("/getWebhookInfo") ? Response.json({ ok: true, result: { url: webhookUrl } }) : undefined),
      (url, init) => {
        if (!url.pathname.endsWith("/setWebhook")) return undefined;
        webhookUrl = JSON.parse(init.bodyText).url;
        return Response.json({ ok: true, result: true });
      },
    ]);
    const { env } = testEnv(db);
    env.GOOGLE_CLIENT_ID = "";
    env.ELEVENLABS_API_KEY = "";

    const html = await (await setupPage(new Request("https://bot.test/api/setup"), env)).text();
    expect(tgCalls(calls, "setWebhook")).toEqual([
      {
        url: "https://bot.test/api/telegram",
        secret_token: "tg-secret",
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      },
    ]);
    expect(tgCalls(calls, "setMyCommands")).toHaveLength(1);
    expect(html).toContain("@my_secretary_bot");
    expect(html).toContain("https://bot.test/api/oauth/callback");
    expect(html).toContain("Готово 3 з 5");
    expect(html).not.toContain("tg-secret");
    expect(html).not.toContain(String(OWNER));

    // Opening the page again does not re-register the webhook.
    await setupPage(new Request("https://bot.test/api/setup"), env);
    expect(tgCalls(calls, "setWebhook")).toHaveLength(1);
  });

  it("explains missing variables and the database when the deployment cannot start", async () => {
    const html = await setupBootErrorPage({ TELEGRAM_BOT_TOKEN: "x" }, undefined, "boom").text();
    expect(html).toContain("OWNER_TELEGRAM_ID");
    expect(html).toContain("OPENROUTER_API_KEY");
    expect(html).toContain("@userinfobot");
    expect(html).toContain("Neon");

    const dbOnly = await setupBootErrorPage(
      { OWNER_TELEGRAM_ID: "1", TELEGRAM_BOT_TOKEN: "x", OPENROUTER_API_KEY: "y" },
      undefined,
      "Missing environment variables: DATABASE_URL",
    ).text();
    expect(dbOnly).toContain("Готово 1 з 2");
  });
});

describe("optional features", () => {
  it("without a Google OAuth client, calendar buttons lead to the setup page", async () => {
    const { env } = testEnv(db);
    env.GOOGLE_CLIENT_ID = "";
    expect(await connectLink(env, 1)).toBe("https://bot.test/api/setup");
    const res = await oauthStart(new Request("https://bot.test/api/oauth/start?state=x"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://bot.test/api/setup");
  });

  it("without ElevenLabs, voice messages get an explanation instead of a job", async () => {
    await db.query(
      "INSERT INTO users (tg_id, full_name, position, created_at, updated_at) VALUES ($1, 'Олександр Коваленко', 'CEO', 0, 0)",
      [OWNER],
    );
    const calls = mockFetch([]);
    const { env, jobs } = testEnv(db);
    env.ELEVENLABS_API_KEY = "";
    await handleUpdate(env, {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: OWNER, type: "private" },
        from: { id: OWNER, is_bot: false, first_name: "O" },
        voice: { file_id: "f", file_unique_id: "u", duration: 3 },
      },
    });
    expect(jobs).toEqual([]);
    expect(String(tgCalls(calls, "sendMessage")[0]!.text)).toContain("ELEVENLABS_API_KEY");
  });

  it("daily cron is open when CRON_SECRET is not set", async () => {
    const { env } = testEnv(db);
    env.CRON_SECRET = "";
    expect((await dailyCron(new Request("https://bot.test/api/cron/daily"), env)).status).toBe(200);
    expect(testConfig.CRON_SECRET).toBe("cron-secret");
  });
});

describe("changed encryption key", () => {
  it("asks to reconnect the calendar instead of failing when stored tokens cannot be decrypted", async () => {
    const { rows } = await db.query<{ id: number }>(
      "INSERT INTO users (tg_id, full_name, created_at, updated_at) VALUES ($1, 'O K', 0, 0) RETURNING id",
      [OWNER],
    );
    const { encrypt } = await import("../src/lib/crypto");
    await db.query(
      "INSERT INTO google_auth (user_id, refresh_token_enc, access_token, expires_at, updated_at) VALUES ($1, $2, $3, $4, 0)",
      [rows[0]!.id, await encrypt("old-key", "r"), await encrypt("old-key", "a"), Date.now() + 3600_000],
    );
    const { GoogleAuthRevokedError, getAccessToken } = await import("../src/google/oauth");
    const { env } = testEnv(db);
    await expect(getAccessToken(env, rows[0]!.id)).rejects.toBeInstanceOf(GoogleAuthRevokedError);
  });
});
