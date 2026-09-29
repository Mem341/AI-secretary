import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBitrixCache } from "../src/bitrix/client";
import { loadIntegrations, resetGoogleCache } from "../src/google/oauth";
import { handleUpdate } from "../src/telegram/handler";
import type { TgMessage, TgUpdate } from "../src/telegram/types";
import { connectGoogle, lastBotMessage, mockFetch, OWNER, resetInstance, testEnv, tg, tgCalls } from "./helpers";

beforeEach(() => {
  resetInstance();
  resetBitrixCache();
});
afterEach(() => vi.restoreAllMocks());

let n = 1;
const from = { id: OWNER, is_bot: false, first_name: "О" };
const text = (t: string, extra: Partial<TgMessage> = {}): TgUpdate => ({
  update_id: n++,
  message: { message_id: 900 + n, date: 0, chat: { id: OWNER, type: "private" }, from, text: t, ...extra },
});
const press = (data: string, message?: TgMessage): TgUpdate => ({ update_id: n++, callback_query: { id: `c${n}`, from, data, message } });

const WEBHOOK = "https://acme.bitrix24.ua/rest/1/secret123/";
const bitrixOk = (url: URL) =>
  url.href.startsWith(WEBHOOK) ? Response.json({ result: { ID: "1", NAME: "Олександр", LAST_NAME: "Коваленко" } }) : undefined;

describe("connecting Bitrix24 and Zoom from /settings (no deployment variables)", () => {
  it("Bitrix24: button → instructions → the owner replies with the webhook → checked, stored encrypted, message deleted", async () => {
    await connectGoogle();
    const calls = mockFetch([bitrixOk]);
    const { env } = testEnv();
    await handleUpdate(env, text("/settings"));
    const settings = lastBotMessage("Налаштування");
    await handleUpdate(env, press("set:on:bitrix", settings));
    const prompt = lastBotMessage("Підключення Bitrix24");
    // No force-reply: it would leave a placeholder in the owner's input field.
    expect(tgCalls(calls, "sendMessage").at(-1)!.reply_markup).toBeUndefined();

    await handleUpdate(env, text(`${WEBHOOK}profile.json`, { reply_to_message: prompt }));
    expect(tgCalls(calls, "deleteMessage").length).toBeGreaterThanOrEqual(1);
    expect(lastBotMessage("Bitrix24 підключено").text).toContain("Олександр Коваленко");
    // Kept in the pinned message, encrypted: the webhook is not readable there.
    expect(tg.pinned!.text).not.toContain("secret123");
    expect(tg.pinned!.entities?.[0]?.url ?? "").not.toContain("secret123");
    resetGoogleCache();
    expect(await loadIntegrations(env)).toEqual({ bitrix: WEBHOOK });
    // Google itself is still connected.
    expect(tg.pinned!.text).toContain("Google підключено");

    // Now /bitrix works and /settings offers to disconnect it.
    await handleUpdate(env, text("/settings"));
    const buttons = (tgCalls(calls, "sendMessage").at(-1)!.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toContain("set:off:bitrix");
    await handleUpdate(env, press("set:off:bitrix", lastBotMessage("Налаштування")));
    resetGoogleCache();
    expect(await loadIntegrations(env)).toEqual({});
  });

  it("a wrong webhook is not saved; a plain message is not mistaken for a key", async () => {
    await connectGoogle();
    const calls = mockFetch([(url) => (url.href.startsWith("https://acme.bitrix24.ua/") ? Response.json({ error: "INVALID_CREDENTIALS" }, { status: 401 }) : undefined)]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, press("set:on:bitrix", lastBotMessage("Google підключено")));
    await handleUpdate(env, text("https://acme.bitrix24.ua/rest/1/wrong/"));
    expect(lastBotMessage("не прийняв").text).toContain("Bitrix24 не прийняв");
    expect(await loadIntegrations(env)).toEqual({});
    await handleUpdate(env, text("що в мене завтра?"));
    expect(jobs.map((j) => j.body.type)).toEqual(["agent"]);
    expect(tgCalls(calls, "deleteMessage")).toHaveLength(1);
  });

  it("Zoom: three values, checked against Zoom, stored — works even before Google is connected", async () => {
    let basic = "";
    mockFetch([
      (url, init) => {
        if (url.href !== "https://zoom.us/oauth/token") return undefined;
        basic = new Headers(init.headers).get("authorization") ?? "";
        return Response.json({ access_token: "z", expires_in: 3600 });
      },
    ]);
    const { env } = testEnv();
    await handleUpdate(env, text("/settings"));
    await handleUpdate(env, press("set:on:zoom", lastBotMessage("Налаштування")));
    const prompt = lastBotMessage("Підключення Zoom");
    await handleUpdate(env, text("Account ID: acc_123456\nClient ID: cli_abcdef\nClient Secret: sec_987654321", { reply_to_message: prompt }));
    expect(Buffer.from(basic.replace("Basic ", ""), "base64").toString()).toBe("cli_abcdef:sec_987654321");
    expect(lastBotMessage("Zoom підключено")).toBeTruthy();
    resetGoogleCache();
    expect(await loadIntegrations(env)).toEqual({ zoom: { accountId: "acc_123456", clientId: "cli_abcdef", clientSecret: "sec_987654321" } });
    expect(tg.pinned!.text).toContain("Сховище бота");
  });
});
