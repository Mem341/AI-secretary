import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceUpdate } from "../src/bot/news";
import { CURRENT_VERSION } from "../src/changelog";
import { loadOwnerSettings, saveOwnerSettings } from "../src/google/oauth";
import { connectGoogle, GMAIL_SCOPE, mockFetch, resetInstance, testEnv, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const ALL = `${GMAIL_SCOPE} https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/pubsub https://www.googleapis.com/auth/calendar.app.created`;

describe("«what is new» after a new version", () => {
  it("once: the changes, then — checked live — what the owner has to do", async () => {
    await connectGoogle();
    const calls = mockFetch([]);
    const { env } = testEnv();
    expect(await announceUpdate(env)).toBe(true);
    const msg = tgCalls(calls, "sendMessage").at(-1)!;
    expect(String(msg.text)).toContain("🆕 <b>Бот оновлено</b>");
    expect(String(msg.text)).toContain("<b>Додано:</b>");
    // An old Google connection: the new permissions are missing.
    expect(String(msg.text)).toContain("Що зробити");
    expect(JSON.stringify(msg.reply_markup)).toContain("з усіма галочками");
    expect((await loadOwnerSettings(env)).v).toBe(CURRENT_VERSION);
    // Said once.
    expect(await announceUpdate(env)).toBe(false);
  });

  it("nothing to do when everything is set up", async () => {
    await connectGoogle({ scope: ALL });
    const calls = mockFetch([]);
    const { env } = testEnv();
    await saveOwnerSettings(env, { p: "ok", v: CURRENT_VERSION - 1 });
    expect(await announceUpdate(env)).toBe(true);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Нічого робити не треба");
  });

  it("a new owner (nothing connected yet) starts quietly at the current version", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv();
    expect(await announceUpdate(env)).toBe(false);
    expect(tgCalls(calls, "sendMessage").filter((m) => String(m.text).includes("Бот оновлено"))).toEqual([]);
  });
});
