import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeByKeywords } from "../src/agent/route";
import { digestEnabled, reminderMarks } from "../src/bot/settings";
import { loadOwnerSettings, resetGoogleCache } from "../src/google/oauth";
import { handleUpdate } from "../src/telegram/handler";
import type { TgMessage, TgUpdate } from "../src/telegram/types";
import { connectGoogle, mockFetch, OWNER, resetInstance, testEnv, tg, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

let n = 1;
const command = (text: string): TgUpdate => ({
  update_id: n++,
  message: { message_id: 100 + n, date: 0, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Олександр" }, text },
});
const press = (data: string, message: TgMessage): TgUpdate => ({
  update_id: n++,
  callback_query: { id: `cb${n}`, from: { id: OWNER, is_bot: false, first_name: "Олександр" }, data, message },
});

describe("/settings in Telegram", () => {
  it("shows what is connected and what can be connected — no deployment variables", async () => {
    await connectGoogle();
    const calls = mockFetch([]);
    const { env } = testEnv();
    await handleUpdate(env, command("/settings"));
    const sent = tgCalls(calls, "sendMessage").at(-1)!;
    const text = String(sent.text);
    expect(text).toContain("✅ Google Calendar");
    expect(text).toContain("✅ Gmail");
    expect(text).toContain("<b>Можна підключити</b>");
    expect(text).toContain("➕ Zoom");
    expect(text).toContain("⏰ Нагадування: за 30 і 10 хв до зустрічі");
    expect(text).not.toMatch(/Vercel|REMINDER_MINUTES|LLM_MODEL|Environment/);
    const buttons = (sent.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }).inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data).filter(Boolean)).toEqual(["set:rem", "set:dg", "set:mem", "set:on:bitrix", "set:on:zoom"]);
  });

  it("the owner picks reminder times with buttons; they are saved in the pinned message and used by reminders", async () => {
    await connectGoogle();
    const pinnedId = tg.pinned!.message_id;
    const calls = mockFetch([]);
    const { env } = testEnv();
    await handleUpdate(env, command("/settings"));
    const settingsMsg = [...tg.messages.values()].at(-1)!;

    await handleUpdate(env, press("set:rem", settingsMsg));
    expect(String(tgCalls(calls, "editMessageText").at(-1)!.text)).toContain("Нагадування про зустрічі");

    await handleUpdate(env, press("set:r:10", settingsMsg)); // off
    await handleUpdate(env, press("set:r:60", settingsMsg)); // on
    expect(await reminderMarks(env)).toEqual([60, 30]);

    // Survives a cold start: read back from the pinned message, which stays the same message.
    resetGoogleCache();
    expect(tg.pinned!.message_id).toBe(pinnedId);
    expect(await loadOwnerSettings(env)).toEqual({ r: [60, 30] });
    expect(tg.pinned!.text).toContain("Google підключено");

    await handleUpdate(env, press("set:r:off", settingsMsg));
    expect(await reminderMarks(env)).toEqual([]);
    await handleUpdate(env, press("set:digest", settingsMsg));
    expect(await digestEnabled(env)).toBe(false);
  });

  it("without Google the settings buttons ask to connect it first", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv();
    await handleUpdate(env, command("/settings"));
    const msg = [...tg.messages.values()].at(-1)!;
    expect(String(msg.text)).toContain("➕ Google Calendar");
    await handleUpdate(env, press("set:r:10", msg));
    expect(tgCalls(calls, "answerCallbackQuery").at(-1)!.text).toBe("Спершу підключіть Google");
  });
});

describe("routing without a model call (the n8n routing table in code)", () => {
  const route = (text: string, extra: Record<string, unknown> = {}) =>
    routeByKeywords({ chatId: OWNER, inputType: "text", text, ...extra });

  it("sends obvious requests straight to one agent; anything unclear to the Supervisor", () => {
    expect(route("що в мене завтра?")).toBe("calendar_agent");
    expect(route("Зустріч з Олегом о 14 в зумі")).toBe("calendar_agent");
    expect(route("перевір пошту")).toBe("gmail_agent");
    expect(route("напиши Івану що я згоден")).toBe("gmail_agent");
    expect(route("перенеси зустріч і напиши Івану")).toBeNull();
    expect(route("привіт")).toBeNull();
    expect(route("скасуй", { replyRef: "eventId: e1" })).toBe("calendar_agent");
    expect(route("відповідай, що згоден", { replyRef: "messageId: m1" })).toBe("gmail_agent");
    expect(route("Переслана переписка: зустріч завтра", { inputType: "forward" })).toBeNull();
  });
});
