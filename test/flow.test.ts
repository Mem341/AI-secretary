import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oauthCallback, telegramWebhook } from "../src/app";
import type { CardData } from "../src/bot/meetings";
import { connectLink, hasGoogleAuth, resetGoogleCache } from "../src/google/oauth";
import { toBase64Url } from "../src/lib/crypto";
import { handleUpdate } from "../src/telegram/handler";
import { readHidden } from "../src/telegram/hidden";
import type { TgMessage, TgUpdate } from "../src/telegram/types";
import {
  botMessage,
  calendarList,
  connectGoogle,
  lastBotMessage,
  llmReply,
  mockFetch,
  OWNER,
  resetInstance,
  runJobs,
  testEnv,
  tg,
  tgCalls,
} from "./helpers";

let updateId = 1;
let msgId = 10;

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

function textUpdate(fromId: number, text: string, extra: Record<string, unknown> = {}): TgUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: msgId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: "private" },
      from: { id: fromId, is_bot: false, first_name: "Олександр", last_name: "Коваленко", username: "oleksandr_k" },
      text,
      ...extra,
    },
  };
}

function callbackUpdate(fromId: number, data: string, message?: TgMessage): TgUpdate {
  return {
    update_id: updateId++,
    callback_query: { id: `cb${updateId}`, from: { id: fromId, is_bot: false, first_name: "Test" }, data, message },
  };
}

function inDays(days: number, hourKyiv: number): string {
  const d = new Date(Date.now() + days * 86400_000);
  d.setUTCHours(hourKyiv - 3, 0, 0, 0);
  return d.toISOString().replace(".000Z", "Z");
}

const CARD = {
  title: null,
  start: null as string | null,
  date: null,
  duration_min: null,
  format: "offline",
  location: null,
  attendees: [{ name: "Олег Мельник", email: "o.melnyk@acme.ua", internal: true }],
  initiator: null,
  purpose: "Бюджет",
  agenda: [],
  agreed_via: null,
  agreed_at: null,
  missing: [],
  confidence: 0.9,
  clarify_question: null,
};

describe("single owner", () => {
  it("ignores everyone except OWNER_TELEGRAM_ID, without replying", async () => {
    const calls = mockFetch([]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(555, "/start"));
    await handleUpdate(env, textUpdate(555, "зустріч з Іваном завтра о 10"));
    await handleUpdate(env, callbackUpdate(555, "d:c"));
    expect(calls).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it("ignores group chats even from the owner", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv();
    const update = textUpdate(OWNER, "/start");
    update.message!.chat = { id: -100, type: "group" };
    await handleUpdate(env, update);
    expect(calls).toEqual([]);
  });

  it("rejects webhook calls without the Telegram secret and handles valid ones in the background", async () => {
    const calls = mockFetch([]);
    const { env, deferred } = testEnv();
    const runtime = { defer: (p: Promise<unknown>) => void deferred.push(p), sleep: async () => undefined };
    const bad = await telegramWebhook(new Request("https://bot.test/api/telegram", { method: "POST", body: "{}" }), env, runtime);
    expect(bad.status).toBe(403);
    const ok = await telegramWebhook(
      new Request("https://bot.test/api/telegram", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "tg-secret" },
        body: JSON.stringify(textUpdate(OWNER, "/start")),
      }),
      env,
      runtime,
    );
    expect(ok.status).toBe(200);
    await Promise.all(deferred);
    expect(tgCalls(calls, "sendMessage").length).toBeGreaterThan(0);
  });
});

describe("/start", () => {
  it("asks no questions: greets by the Telegram name and offers to connect Google", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "/start"));
    const sent = tgCalls(calls, "sendMessage");
    expect(String(sent[0]!.text)).toContain("Олександр Коваленко");
    const button = (sent[1]!.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0]![0]!;
    expect(button.url).toMatch(/^https:\/\/bot\.test\/api\/oauth\/start\?state=/);
  });
});

describe("Google connection lives in one pinned message", () => {
  it("OAuth callback pins the encrypted grant and queues the connected job", async () => {
    const idToken = `x.${toBase64Url(new TextEncoder().encode(JSON.stringify({ email: "Boss@Acme.ua" })))}.y`;
    const calls = mockFetch([
      (url) =>
        url.hostname === "oauth2.googleapis.com"
          ? Response.json({ access_token: "a", expires_in: 3600, refresh_token: "r1", id_token: idToken, scope: "calendar.events gmail.modify" })
          : undefined,
    ]);
    const { env, jobs } = testEnv();
    const state = new URL(await connectLink(env)).searchParams.get("state")!;
    const res = await oauthCallback(new Request(`https://bot.test/api/oauth/callback?state=${encodeURIComponent(state)}&code=c`), env);
    expect(res.status).toBe(200);
    expect(tgCalls(calls, "pinChatMessage")).toHaveLength(1);
    expect(String(tg.pinned!.text)).toContain("boss@acme.ua");
    // The refresh token itself never appears in the chat text, only encrypted inside the hidden link.
    expect(tg.pinned!.text).not.toContain("r1");
    expect(jobs.map((j) => j.body)).toEqual([{ type: "connected", gmail: true }]);

    resetGoogleCache();
    expect(await hasGoogleAuth(env)).toBe(true);
  });

  it("reconnecting replaces the previous grant message", async () => {
    await connectGoogle();
    const old = tg.pinned!.message_id;
    mockFetch([
      (url) =>
        url.hostname === "oauth2.googleapis.com"
          ? Response.json({ access_token: "a", expires_in: 3600, refresh_token: "r2", scope: "calendar.events" })
          : undefined,
    ]);
    const { env } = testEnv();
    const state = new URL(await connectLink(env)).searchParams.get("state")!;
    await oauthCallback(new Request(`https://bot.test/api/oauth/callback?state=${encodeURIComponent(state)}&code=c`), env);
    expect(tg.messages.has(old)).toBe(false);
    expect(tg.pinned!.message_id).not.toBe(old);
  });

  it("a revoked grant deletes the pinned message and asks to reconnect", async () => {
    await connectGoogle();
    const calls = mockFetch([
      (url) => (url.hostname === "oauth2.googleapis.com" ? Response.json({ error: "invalid_grant" }, { status: 400 }) : undefined),
    ]);
    const { env, jobs } = testEnv();
    jobs.push({ body: { type: "daily" } });
    await runJobs(env, jobs);
    expect(tg.pinned).toBeNull();
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Доступ до Google втрачено");
  });
});

describe("meeting card without a database", () => {
  it("text → card with its data hidden inside → «Створити» creates the event from the message itself", async () => {
    await connectGoogle();
    const start = inDays(1, 10);
    let inserted: Record<string, unknown> | undefined;
    const calls = mockFetch([
      calendarList([]),
      (url, init) =>
        url.hostname === "openrouter.ai" ? llmReply({ ...CARD, start: start.replace("Z", "+00:00") }) : undefined,
      (url, init) => {
        if (url.pathname !== "/calendar/v3/calendars/primary/events" || init.method !== "POST") return undefined;
        inserted = JSON.parse(init.bodyText);
        return Response.json({ id: inserted!.id, htmlLink: "https://calendar.google.com/e", status: "confirmed" });
      },
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "зустріч з Олегом завтра о 10 по бюджету"));
    expect(jobs[0]!.body.type).toBe("parse");
    await runJobs(env, jobs);

    const llm = calls.find((c) => c.url.includes("openrouter.ai"))!.body as { model: string };
    expect(llm.model).toBe("test/card-model");
    const card = lastBotMessage("Нова зустріч");
    const data = readHidden<CardData>(card)!;
    expect(data.k).toBe("card");
    expect(data.card.attendees[0]!.email).toBe("o.melnyk@acme.ua");
    const keyboard = tgCalls(calls, "editMessageText").at(-1)!.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    expect(keyboard.inline_keyboard[0]![0]!.callback_data).toBe("d:c");

    await handleUpdate(env, callbackUpdate(OWNER, "d:c", card));
    expect(inserted!.id).toMatch(/^ais[0-9a-f]{32}$/);
    const props = (inserted!.extendedProperties as { private: Record<string, string> }).private;
    expect(props.aisStart).toBe(String(Date.parse(start)));
    expect(props.aiSecretaryDraft).toBe(data.id);
    const created = botMessage(card.message_id);
    expect(created.text).toContain("Зустріч створена");
    expect(readHidden<{ k: string; id: string }>(created)).toEqual({ k: "ev", id: inserted!.id });
  });

  it("«Змінити» sends a reply prompt carrying the card; the answer edits the original card", async () => {
    await connectGoogle();
    const start = inDays(1, 10);
    const edited = inDays(1, 16);
    let llmCalls = 0;
    mockFetch([
      calendarList([]),
      (url) => {
        if (url.hostname !== "openrouter.ai") return undefined;
        llmCalls++;
        return llmReply({ ...CARD, start: (llmCalls === 1 ? start : edited).replace("Z", "+00:00") });
      },
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "зустріч з Олегом завтра о 10"));
    await runJobs(env, jobs);
    const card = lastBotMessage("Нова зустріч");

    await handleUpdate(env, callbackUpdate(OWNER, "d:e", card));
    const prompt = lastBotMessage("що змінити");
    expect(readHidden<CardData>(prompt)!.msg).toBe(card.message_id);

    await handleUpdate(env, textUpdate(OWNER, "перенеси на 16:00", { reply_to_message: prompt }));
    expect(jobs[0]!.body).toMatchObject({ type: "edit", instruction: "перенеси на 16:00", messageId: card.message_id });
    await runJobs(env, jobs);
    expect(readHidden<CardData>(botMessage(card.message_id))!.card.start).toContain("16:00");
  });

  it("the answer also works without «reply», while the instance remembers the question", async () => {
    await connectGoogle();
    mockFetch([calendarList([]), (url) => (url.hostname === "openrouter.ai" ? llmReply({ ...CARD, start: inDays(1, 10) }) : undefined)]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "зустріч з Олегом"));
    await runJobs(env, jobs);
    const card = lastBotMessage("Нова зустріч");
    await handleUpdate(env, callbackUpdate(OWNER, "d:e", card));
    await handleUpdate(env, textUpdate(OWNER, "зроби онлайн"));
    expect(jobs[0]!.body).toMatchObject({ type: "edit", instruction: "зроби онлайн" });
  });

  it("an unclear request becomes a question; the answer is parsed together with the original text", async () => {
    await connectGoogle();
    const sent: string[] = [];
    mockFetch([
      calendarList([]),
      (url, init) => {
        if (url.hostname !== "openrouter.ai") return undefined;
        const body = JSON.parse(init.bodyText) as { messages: { content: { text?: string }[] | string }[] };
        const user = body.messages[1]!.content;
        sent.push(typeof user === "string" ? user : user[0]!.text!);
        return llmReply(sent.length === 1 ? { ...CARD, confidence: 0.3, clarify_question: "З ким зустріч?" } : { ...CARD, start: inDays(1, 10) });
      },
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "треба зустрітись завтра"));
    await runJobs(env, jobs);
    const question = lastBotMessage("З ким зустріч?");
    await handleUpdate(env, textUpdate(OWNER, "з Олегом о 10", { reply_to_message: question }));
    await runJobs(env, jobs);
    expect(sent[1]).toContain("треба зустрітись завтра");
    expect(sent[1]).toContain("Уточнення: з Олегом о 10");
    expect(lastBotMessage("Нова зустріч")).toBeTruthy();
  });

  it("a burst of forwarded messages becomes one card (debounced in the instance)", async () => {
    await connectGoogle();
    const prompts: string[] = [];
    mockFetch([
      calendarList([]),
      (url, init) => {
        if (url.hostname !== "openrouter.ai") return undefined;
        const body = JSON.parse(init.bodyText) as { messages: { content: { text: string }[] }[] };
        prompts.push(body.messages[1]!.content[0]!.text);
        return llmReply({ ...CARD, start: inDays(2, 11) });
      },
    ]);
    const { env, jobs } = testEnv();
    const fwd = (text: string) =>
      textUpdate(OWNER, text, { forward_origin: { type: "user", date: 1_790_000_000, sender_user: { id: 7, is_bot: false, first_name: "Іван" } } });
    await handleUpdate(env, fwd("Привіт, зустрінемось?"));
    await handleUpdate(env, fwd("Давай у середу об 11"));
    expect(jobs.map((j) => j.body)).toEqual([
      { type: "batch", chatId: OWNER, seq: 1 },
      { type: "batch", chatId: OWNER, seq: 2 },
    ]);
    await runJobs(env, jobs);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Привіт, зустрінемось?");
    expect(prompts[0]).toContain("Давай у середу об 11");
  });

  it("asks to connect Google before preparing a card", async () => {
    const calls = mockFetch([]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "зустріч з Олегом завтра"));
    expect(jobs).toEqual([]);
    expect(String(tgCalls(calls, "sendMessage")[0]!.text)).toContain("підключіть Google");
  });
});

describe("voice", () => {
  it("transcribes through OpenRouter and continues as text", async () => {
    await connectGoogle();
    let audio: { data: string; format: string } | undefined;
    const calls = mockFetch([
      (url, init) => {
        if (url.hostname !== "openrouter.ai") return undefined;
        const body = JSON.parse(init.bodyText);
        if (body.model !== "test/audio-model") return undefined;
        audio = body.messages[0].content.find((p: { type: string }) => p.type === "input_audio").input_audio;
        return Response.json({ choices: [{ message: { content: " зустріч з Іваном завтра о 10 \n" } }] });
      },
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "", { text: undefined, voice: { file_id: "f", file_unique_id: "u", duration: 3 } }));
    expect(jobs.map((j) => j.body.type)).toEqual(["voice"]);
    await runJobs(env, [jobs.shift()!]);
    expect(audio).toEqual({ data: Buffer.from([1, 2, 3]).toString("base64"), format: "ogg" });
    expect(tgCalls(calls, "sendMessage").some((m) => String(m.text).includes("🎙 <i>зустріч з Іваном завтра о 10</i>"))).toBe(true);
    expect(jobs.map((j) => j.body.type)).toEqual(["parse"]);
  });
});
