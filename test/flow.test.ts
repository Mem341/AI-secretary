import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oauthCallback, telegramWebhook } from "../src/app";
import { connectLink, hasGoogleAuth, resetGoogleCache } from "../src/google/oauth";
import { toBase64Url } from "../src/lib/crypto";
import { handleUpdate } from "../src/telegram/handler";
import { hiddenData } from "../src/telegram/hidden";
import type { TgMessage, TgUpdate } from "../src/telegram/types";
import {
  botMessage,
  calendarList,
  connectGoogle,
  lastBotMessage,
  isSupervisor,
  lastContent,
  type LlmRequest,
  llmText,
  llmTools,
  mockFetch,
  openRouter,
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
    expect(tg.pinned!.text!.replace(/<a href="[^"]*">/, "")).not.toContain("r1");
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

describe("agents (the n8n «AI Agent ALL» flow)", () => {
  it("an obvious calendar request goes straight to the Calendar Agent (no Supervisor call) and its answer to the chat", async () => {
    await connectGoogle();
    const seen: LlmRequest[] = [];
    let listed = false;
    const calls = mockFetch([
      (url, init) => {
        if (url.pathname !== "/calendar/v3/calendars/primary/events" || (init.method ?? "GET") !== "GET") return undefined;
        if (url.searchParams.get("orderBy") === "startTime" && url.searchParams.get("maxResults") === "20") listed = true;
        return Response.json({ items: [] });
      },
      openRouter((req) => {
        if (isSupervisor(req)) {
          return req.messages.at(-1)!.role === "tool" ? llmText(lastContent(req)) : llmTools(["calendar_agent", { prompt: lastContent(req) }]);
        }
        return req.messages.at(-1)!.role === "tool"
          ? llmText("📅 <b>Розклад на сьогодні:</b>\n\nЗустрічей немає")
          : llmTools(["get_calendar_events", { timeMax: "2026-10-01T00:00:00+03:00" }]);
      }, seen),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "що в мене сьогодні?"));
    expect(jobs.map((j) => j.body.type)).toEqual(["agent"]);
    await runJobs(env, jobs);

    expect(seen.map((r) => r.model)).toEqual(["test/agent-model", "test/agent-model"]);
    // The Calendar Agent gets the user's message without the session block, and the calendar tools.
    expect(lastContent(seen[0]!)).toBe("що в мене сьогодні?");
    expect(seen[0]!.tools!.map((t) => t.function.name)).toContain("create_event_google_meet");
    expect(String(seen[0]!.messages[0]!.content)).toContain("o.kovalenko@acme.ua");
    expect(listed).toBe(true);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toBe("📅 <b>Розклад на сьогодні:</b>\n\nЗустрічей немає");
  });

  it("an unclear request (both topics) goes to the Supervisor, which calls the agents as tools (no Think)", async () => {
    await connectGoogle();
    const seen: LlmRequest[] = [];
    mockFetch([
      calendarList([]),
      openRouter((req) => {
        if (isSupervisor(req)) {
          return req.messages.at(-1)!.role === "tool" ? llmText(lastContent(req)) : llmTools(["calendar_agent", { prompt: lastContent(req) }]);
        }
        return llmText("Готово");
      }, seen),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "перенеси зустріч з Іваном і напиши йому лист"));
    await runJobs(env, jobs);
    expect(seen.map((r) => r.model)).toEqual(["test/agent-model", "test/agent-model", "test/agent-model"]);
    expect(seen.map(isSupervisor)).toEqual([true, false, true]);
    expect(lastContent(seen[0]!)).toContain("USER: перенеси зустріч з Іваном і напиши йому лист");
    expect(lastContent(seen[0]!)).toContain("---SESSION---");
    expect(seen[0]!.tools!.map((t) => t.function.name)).toEqual(["calendar_agent", "gmail_agent", "remember_fact", "forget_fact"]);
    expect(lastContent(seen[1]!)).toBe("перенеси зустріч з Іваном і напиши йому лист");
  });

  it("create_event_google_meet: Meet link, 10-minute popup, guests cannot edit, silent for the calendar notices", async () => {
    await connectGoogle();
    let inserted: Record<string, unknown> | undefined;
    let insertUrl: URL | undefined;
    mockFetch([
      calendarList([]),
      (url, init) => {
        if (url.pathname !== "/calendar/v3/calendars/primary/events" || init.method !== "POST") return undefined;
        insertUrl = url;
        inserted = JSON.parse(init.bodyText);
        return Response.json({ id: "ev1", status: "confirmed", hangoutLink: "https://meet.google.com/abc", organizer: { self: true } });
      },
      openRouter((req) => {
        if (isSupervisor(req)) {
          return req.messages.at(-1)!.role === "tool" ? llmText(lastContent(req)) : llmTools(["calendar_agent", { prompt: lastContent(req) }]);
        }
        return req.messages.at(-1)!.role === "tool"
          ? llmText("✅ <b>Зустріч створена!</b>")
          : llmTools([
              "create_event_google_meet",
              {
                summary: "Бюджет",
                description: "",
                startDateTime: "2026-10-01T10:00:00+03:00",
                endDateTime: "2026-10-01T11:00:00+03:00",
                attendeesJson: '{"email":"o.kovalenko@acme.ua"},{"email":"o.melnyk@acme.ua"}',
              },
            ]);
      }),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "зустріч з Олегом 1 жовтня о 10 по бюджету"));
    await runJobs(env, jobs);

    expect(insertUrl!.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(inserted).toMatchObject({
      summary: "Бюджет",
      guestsCanModify: false,
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
      attendees: [{ email: "o.kovalenko@acme.ua" }, { email: "o.melnyk@acme.ua" }],
      conferenceData: { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
    const props = (inserted!.extendedProperties as { private: Record<string, string> }).private;
    expect(props.aisStart).toBe(String(Date.parse("2026-10-01T10:00:00+03:00")));
    expect(lastBotMessage("Зустріч створена")).toBeTruthy();
  });

  it("✅ Прийняти under an invitation: answered in code (no AI) — rsvp keeps the other guests; the buttons are removed", async () => {
    await connectGoogle();
    const invitation = tg.message(hiddenData({ k: "ev", id: "ev7" }) + "📅 <b>Запрошення на зустріч</b>\n\n📌 <b>Демо</b>");
    let patched: { attendees: { email: string; responseStatus?: string }[] } | undefined;
    const seen: LlmRequest[] = [];
    const calls = mockFetch([
      calendarList([]),
      (url, init) => {
        if (url.pathname !== "/calendar/v3/calendars/primary/events/ev7") return undefined;
        if (init.method === "PATCH") {
          patched = JSON.parse(init.bodyText);
          return Response.json({ id: "ev7", ...patched });
        }
        return Response.json({
          id: "ev7",
          attendees: [
            { email: "boss@partner.ua", organizer: true, responseStatus: "accepted" },
            { email: "o.kovalenko@acme.ua", self: true, responseStatus: "needsAction" },
            { email: "anna@partner.ua", responseStatus: "tentative" },
          ],
        });
      },
      openRouter((req) => {
        if (isSupervisor(req)) {
          return req.messages.at(-1)!.role === "tool" ? llmText(lastContent(req)) : llmTools(["calendar_agent", { prompt: lastContent(req) }]);
        }
        return req.messages.at(-1)!.role === "tool" ? llmText("✅ Зустріч підтверджена!") : llmTools(["rsvp_event", { eventId: "ev7", responseStatus: "accepted" }]);
      }, seen),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, callbackUpdate(OWNER, "accept:ev7", invitation));
    await runJobs(env, jobs);

    expect(seen).toEqual([]);
    expect(patched!.attendees.map((a) => [a.email, a.responseStatus])).toEqual([
      ["boss@partner.ua", "accepted"],
      ["o.kovalenko@acme.ua", "accepted"],
      ["anna@partner.ua", "tentative"],
    ]);
    expect(tgCalls(calls, "answerCallbackQuery")).toHaveLength(1);
    expect(tgCalls(calls, "editMessageReplyMarkup")[0]).toMatchObject({ message_id: invitation.message_id, reply_markup: { inline_keyboard: [] } });
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toBe("✅ Зустріч підтверджена!");
  });

  it("a reply to the bot's message carries its text and the event id (n8n REPLY_TO_BOT_MESSAGE)", async () => {
    await connectGoogle();
    const notice = tg.message(hiddenData({ k: "ev", id: "ev9" }) + "🔄 <b>Подію перенесено в календарі</b>\n\n<b>Стендап</b>");
    const seen: LlmRequest[] = [];
    mockFetch([calendarList([]), openRouter(() => llmText("Добре"), seen)]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "скасуй", { reply_to_message: notice }));
    await runJobs(env, jobs);
    const input = lastContent(seen[0]!);
    expect(input.startsWith("---REPLY_TO_BOT_MESSAGE---\n")).toBe(true);
    expect(input).toContain("Стендап");
    expect(input).toContain("\n[eventId: ev9]\n---END_REPLY---\n\nскасуй");
    // The event id alone decides: straight to the Calendar Agent.
    expect(seen.map((r) => r.model)).toEqual(["test/agent-model"]);
  });

  it("remembers the conversation within the instance (n8n chat memory); /reset forgets it", async () => {
    const seen: LlmRequest[] = [];
    mockFetch([openRouter((_req, n) => llmText(n === 1 ? "Привіт! Чим допомогти?" : "Завжди радий допомогти!"), seen)]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "привіт"));
    await runJobs(env, jobs);
    await handleUpdate(env, textUpdate(OWNER, "дякую"));
    await runJobs(env, jobs);
    // n8n Window Buffer Memory: the earlier pair as real chat turns, with the rule not to redo what was done.
    expect(seen[1]!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(String(seen[1]!.messages[1]!.content)).toMatch(/^\[\d\d:\d\d\] привіт$/);
    expect(seen[1]!.messages[2]!.content).toBe("Привіт! Чим допомогти?");
    const system = String(seen[1]!.messages[0]!.content);
    expect(system).toContain("ПАМʼЯТЬ РОЗМОВИ");
    expect(system).toContain("НЕ виконуй повторно");

    await handleUpdate(env, textUpdate(OWNER, "/reset"));
    await handleUpdate(env, textUpdate(OWNER, "ще раз"));
    await runJobs(env, jobs);
    expect(seen[2]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("without Google the agents say how to connect it instead of failing", async () => {
    const seen: LlmRequest[] = [];
    mockFetch([
      openRouter((req) =>
        req.messages.at(-1)!.role === "tool" ? llmText(lastContent(req)) : llmTools(["calendar_agent", { prompt: lastContent(req) }]),
      seen),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "зустріч з Олегом завтра"));
    await runJobs(env, jobs);
    expect(seen).toEqual([]);
    expect(lastBotMessage("Google не підключено")).toBeTruthy();
  });

  it("delete_event marks the event as the bot's own before deleting, so no «cancelled» notice follows", async () => {
    await connectGoogle();
    const order: string[] = [];
    mockFetch([
      calendarList([]),
      (url, init) => {
        if (url.pathname !== "/calendar/v3/calendars/primary/events/ev5") return undefined;
        const method = init.method ?? "GET";
        if (method === "PATCH") order.push(`patch:${JSON.stringify(JSON.parse(init.bodyText).extendedProperties.private)}:${url.searchParams.get("sendUpdates")}`);
        if (method === "DELETE") {
          order.push("delete");
          return new Response(null, { status: 204 });
        }
        return Response.json({ id: "ev5", extendedProperties: { private: { aisStart: "1" } } });
      },
      openRouter((req) => {
        if (isSupervisor(req)) {
          return req.messages.at(-1)!.role === "tool" ? llmText(lastContent(req)) : llmTools(["calendar_agent", { prompt: lastContent(req) }]);
        }
        return req.messages.at(-1)!.role === "tool" ? llmText("🗑 Видалено") : llmTools(["delete_event", { eventId: "ev5" }]);
      }),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "видали стендап"));
    await runJobs(env, jobs);
    expect(order).toEqual(['patch:{"aisStart":"1","aisBotCancel":"1"}:none', "delete"]);
  });

  it("a burst of forwarded messages becomes one request (debounced in the instance)", async () => {
    const seen: LlmRequest[] = [];
    mockFetch([openRouter(() => llmText("ok"), seen)]);
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
    expect(seen).toHaveLength(1);
    expect(lastContent(seen[0]!)).toContain("Іван: Привіт, зустрінемось?");
    expect(lastContent(seen[0]!)).toContain("Іван: Давай у середу об 11");
    expect(lastContent(seen[0]!)).toContain("inputType: forward");
  });

  it("markup Telegram rejects is sent again as plain text", async () => {
    let first = true;
    const calls = mockFetch([
      (url) => {
        if (!url.pathname.endsWith("/sendMessage") || !first) return undefined;
        first = false;
        return Response.json({ ok: false, description: "Bad Request: can't parse entities" }, { status: 400 });
      },
      openRouter(() => llmText('<a href="x y">лінк</a> & <b>готово</b>')),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "привіт"));
    await runJobs(env, jobs);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toBe("лінк &amp; готово");
  });
});

describe("which model serves a request", () => {
  it("text → AGENT_MODEL, pictures → VISION_MODEL", async () => {
    const seen: LlmRequest[] = [];
    mockFetch([openRouter(() => llmText("ok"), seen)]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "привіт"));
    await handleUpdate(env, textUpdate(OWNER, "", { text: undefined, caption: "що тут?", photo: [{ file_id: "p", file_unique_id: "u", width: 1, height: 1 }] }));
    await runJobs(env, jobs);
    expect(seen.map((r) => r.model)).toEqual(["test/agent-model", "test/vision-model"]);
  });

  it("when the cheap model fails before changing anything, the request is retried on LLM_MODEL", async () => {
    const seen: LlmRequest[] = [];
    const calls = mockFetch([
      openRouter((req) => (req.model === "test/agent-model" ? Response.json({ error: { message: "bad tool call" } }, { status: 400 }) : llmText("Привіт!")), seen),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "привіт"));
    await runJobs(env, jobs);
    expect(seen.map((r) => r.model)).toEqual(["test/agent-model", "test/strong-model"]);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toBe("Привіт!");
  });

  it("after a change (an event deleted) a failure is not retried, so nothing is done twice", async () => {
    await connectGoogle();
    const seen: LlmRequest[] = [];
    let deletes = 0;
    mockFetch([
      calendarList([]),
      (url, init) => {
        if (url.pathname !== "/calendar/v3/calendars/primary/events/ev5") return undefined;
        if (init.method === "DELETE") {
          deletes++;
          return new Response(null, { status: 204 });
        }
        return Response.json({ id: "ev5" });
      },
      openRouter((req) =>
        req.messages.at(-1)!.role === "tool"
          ? Response.json({ error: { message: "overloaded" } }, { status: 400 })
          : llmTools(["delete_event", { eventId: "ev5" }]),
      seen),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "видали зустріч"));
    await runJobs(env, jobs);
    expect(deletes).toBe(1);
    expect(seen.map((r) => r.model)).toEqual(["test/agent-model", "test/agent-model"]);
    expect(lastBotMessage("Не вдалося обробити запит")).toBeTruthy();
  });
});

describe("voice", () => {
  it("transcribes through OpenRouter, shows the text and hands it to the agents", async () => {
    let audio: { data: string; format: string } | undefined;
    const seen: LlmRequest[] = [];
    const calls = mockFetch([
      (url, init) => {
        if (url.hostname !== "openrouter.ai") return undefined;
        const body = JSON.parse(init.bodyText);
        if (body.model !== "test/audio-model") return undefined;
        audio = body.messages[0].content.find((p: { type: string }) => p.type === "input_audio").input_audio;
        return Response.json({ choices: [{ message: { content: " привіт, як справи \n" } }] });
      },
      openRouter(() => llmText("ok"), seen),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(OWNER, "", { text: undefined, voice: { file_id: "f", file_unique_id: "u", duration: 3 } }));
    expect(jobs.map((j) => j.body.type)).toEqual(["voice"]);
    await runJobs(env, jobs);
    expect(audio).toEqual({ data: Buffer.from([1, 2, 3]).toString("base64"), format: "ogg" });
    expect(tgCalls(calls, "sendMessage").some((m) => String(m.text).includes("🎙 <i>привіт, як справи</i>"))).toBe(true);
    expect(lastContent(seen[0]!)).toContain("USER: привіт, як справи");
    // Spoken requests go to the strong model.
    expect(seen[0]!.model).toBe("test/strong-model");
    expect(lastContent(seen[0]!)).toContain("inputType: voice");
  });
});

describe("Google via a Desktop app client (the downloaded JSON)", () => {
  it("reads GOOGLE_CLIENT_JSON: installed → desktop, web → web; rejects anything else", async () => {
    const { loadConfig, ConfigError } = await import("../src/env");
    const base = { OWNER_TELEGRAM_ID: "1", TELEGRAM_BOT_TOKEN: "1:A", OPENROUTER_API_KEY: "k", PUBLIC_URL: "https://b.test" };
    const desktop = loadConfig({ ...base, GOOGLE_CLIENT_JSON: JSON.stringify({ installed: { client_id: "d.apps.googleusercontent.com", client_secret: "GOCSPX-d" } }) });
    expect(desktop).toMatchObject({ GOOGLE_CLIENT_ID: "d.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "GOCSPX-d", GOOGLE_OAUTH_MODE: "desktop" });
    const web = loadConfig({ ...base, GOOGLE_CLIENT_JSON: JSON.stringify({ web: { client_id: "w", client_secret: "s" } }) });
    expect(web.GOOGLE_OAUTH_MODE).toBe("web");
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_JSON: "{oops" })).toThrow(ConfigError);
  });

  it("the connect link opens a friendly page with the Google button (loopback redirect), not a raw error", async () => {
    mockFetch([(url) => (url.pathname.endsWith("/getMe") ? Response.json({ ok: true, result: { username: "my_bot" } }) : undefined)]);
    const { oauthStart } = await import("../src/app");
    const { env } = testEnv({ GOOGLE_OAUTH_MODE: "desktop" });
    const res = await oauthStart(new Request(await connectLink(env)), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Увійти через Google");
    expect(html).toContain("@my_bot");
    const google = new URL(/href="(https:\/\/accounts\.google\.com[^"]+)"/.exec(html)![1]!.replace(/&amp;/g, "&"));
    expect(google.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53682");
  });

  it("the owner pastes the browser address; the bot exchanges the code, pins the grant and deletes the message", async () => {
    let tokenBody = "";
    const calls = mockFetch([
      (url, init) => {
        if (url.hostname !== "oauth2.googleapis.com") return undefined;
        tokenBody = init.bodyText;
        return Response.json({ access_token: "a", expires_in: 3600, refresh_token: "r", scope: "calendar.events gmail.modify" });
      },
    ]);
    const { env, jobs } = testEnv({ GOOGLE_OAUTH_MODE: "desktop" });
    const state = new URL(await connectLink(env)).searchParams.get("state")!;
    const pasted = `http://127.0.0.1:53682/?state=${encodeURIComponent(state)}&code=4/0AbCdEf&scope=calendar`;
    await handleUpdate(env, textUpdate(OWNER, pasted));
    const params = new URLSearchParams(tokenBody);
    expect(params.get("code")).toBe("4/0AbCdEf");
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:53682");
    expect(tg.pinned!.text).toContain("Google підключено");
    expect(tgCalls(calls, "deleteMessage")).toHaveLength(1);
    expect(jobs.map((j) => j.body)).toEqual([{ type: "connected", gmail: true }]);
  });

  it("an outdated or cancelled answer asks to try again instead of failing", async () => {
    const calls = mockFetch([]);
    const { env, jobs } = testEnv({ GOOGLE_OAUTH_MODE: "desktop" });
    await handleUpdate(env, textUpdate(OWNER, "http://127.0.0.1:53682/?state=forged&code=4/0AbCdEf"));
    await handleUpdate(env, textUpdate(OWNER, "http://127.0.0.1:53682/?error=access_denied"));
    const texts = tgCalls(calls, "sendMessage").map((m) => String(m.text));
    expect(texts[0]).toContain("застаріло");
    expect(texts[1]).toContain("скасовано");
    expect(jobs).toEqual([]);
  });
});

describe("typing indicator", () => {
  it("shows «печатает…» for as long as a job the owner waits for is running", async () => {
    vi.useFakeTimers();
    try {
      await connectGoogle();
      let release: (() => void) | undefined;
      const calls = mockFetch([
        (url) => (url.hostname === "openrouter.ai" ? new Promise<Response>((r) => (release = () => r(llmText("ok")))) : undefined),
      ]);
      const { env, jobs } = testEnv();
      const running = runJobs(env, [{ body: { type: "agent", input: { chatId: OWNER, inputType: "text", text: "привіт" }, photoIds: [] } }]);
      // Wait (in fake time, with real async crypto in between) until the job is inside the LLM call.
      for (let i = 0; i < 2000 && !release; i++) await vi.advanceTimersByTimeAsync(50);
      expect(release).toBeDefined();
      const before = tgCalls(calls, "sendChatAction").length;
      expect(before).toBeGreaterThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(9000);
      // Repeated every 4 s while the owner waits.
      const during = tgCalls(calls, "sendChatAction").length;
      expect(during - before).toBeGreaterThanOrEqual(2);
      release!();
      await vi.advanceTimersByTimeAsync(0);
      await running;
      await vi.advanceTimersByTimeAsync(9000);
      // …and stops when the answer is sent.
      expect(tgCalls(calls, "sendChatAction").length).toBe(during);
      expect(jobs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
