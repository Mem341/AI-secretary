import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GEvent } from "../src/google/calendar";
import { handleUpdate } from "../src/telegram/handler";
import { hiddenData } from "../src/telegram/hidden";
import type { TgMessage, TgUpdate } from "../src/telegram/types";
import { botMessage, connectGoogle, lastBotMessage, llmReply, mockFetch, OWNER, resetInstance, runJobs, testEnv, tg, tgCalls } from "./helpers";

let updateId = 1;
let msgId = 10;

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const EVENT: GEvent = {
  id: "ev1",
  status: "confirmed",
  summary: "Бюджет",
  description: "Агенда: кошторис",
  start: { dateTime: "2026-10-01T15:00:00+03:00" },
  end: { dateTime: "2026-10-01T16:00:00+03:00" },
  attendees: [
    { email: "ivan@example.com", displayName: "Іван", responseStatus: "accepted" },
    { email: "oleh@example.com", responseStatus: "needsAction" },
    { email: "me@acme.ua", self: true, responseStatus: "accepted" },
  ],
  extendedProperties: { private: { aisStart: String(Date.parse("2026-10-01T15:00:00+03:00")) } },
};

/** A notice about the event, as the bot sends it: the event id is hidden inside. */
function notice(): TgMessage {
  return tg.message(hiddenData({ k: "ev", id: "ev1" }) + "🆕 Нова подія в календарі");
}

function replyTo(message: TgMessage, text: string): TgUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: msgId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER, type: "private" },
      from: { id: OWNER, is_bot: false, first_name: "O" },
      text,
      reply_to_message: message,
    },
  };
}

function press(data: string, message: TgMessage): TgUpdate {
  return { update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: OWNER, is_bot: false, first_name: "O" }, data, message } };
}

/** Google Calendar routes for ev1: GET returns the event, PATCH/DELETE are recorded. */
function eventRoutes(log: { method: string; url: URL; body: any }[]) {
  return (url: URL, init: RequestInit & { bodyText: string }) => {
    if (!url.pathname.endsWith("/events/ev1")) return undefined;
    const method = init.method ?? "GET";
    log.push({ method, url, body: init.bodyText ? JSON.parse(init.bodyText) : null });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(EVENT);
  };
}

describe("replying to a message about a meeting", () => {
  it("answers 'who is attending' from the calendar, without calling the LLM", async () => {
    await connectGoogle();
    const log: { method: string; url: URL; body: any }[] = [];
    const calls = mockFetch([eventRoutes(log)]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, replyTo(notice(), "хто буде?"));
    expect(jobs).toEqual([]);
    expect(calls.some((c) => c.url.includes("openrouter.ai"))).toBe(false);
    const text = String(tgCalls(calls, "sendMessage").at(-1)!.text);
    expect(text).toContain("Іван — прийде");
    expect(text).toContain("oleh@example.com — не відповів(ла)");
  });

  it("reschedules after confirmation and remembers the new start on the event, so its push stays silent", async () => {
    await connectGoogle();
    const log: { method: string; url: URL; body: any }[] = [];
    mockFetch([
      eventRoutes(log),
      (url) => (url.hostname === "openrouter.ai" ? llmReply({ action: "reschedule", new_start: "2026-10-02T16:00:00+03:00" }) : undefined),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, replyTo(notice(), "перенеси на завтра о 16"));
    expect(jobs.map((j) => j.body)).toEqual([{ type: "action", eventId: "ev1", text: "перенеси на завтра о 16" }]);
    await runJobs(env, jobs);
    const confirm = lastBotMessage("Перенести «Бюджет»");
    expect(confirm.text).toContain("Стане: пт, 2 жовтня, 16:00–17:00");
    expect(log.filter((l) => l.method === "PATCH")).toEqual([]);

    await handleUpdate(env, press("a:y", confirm));
    const patch = log.find((l) => l.method === "PATCH")!;
    expect(patch.url.searchParams.get("sendUpdates")).toBe("all");
    expect(patch.body.start.dateTime).toBe("2026-10-02T13:00:00.000Z");
    expect(patch.body.end.dateTime).toBe("2026-10-02T14:00:00.000Z");
    expect(patch.body.extendedProperties.private.aisStart).toBe(String(Date.parse("2026-10-02T13:00:00Z")));
    expect(botMessage(confirm.message_id).text).toContain("Перенесено");
  });

  it("appends a note, and cancels after marking the event as cancelled by the bot", async () => {
    await connectGoogle();
    const log: { method: string; url: URL; body: any }[] = [];
    let n = 0;
    mockFetch([
      eventRoutes(log),
      (url) =>
        url.hostname === "openrouter.ai" ? llmReply(n++ === 0 ? { action: "note", note_text: "Домовились про знижку" } : { action: "cancel" }) : undefined,
    ]);
    const { env, jobs } = testEnv();

    await handleUpdate(env, replyTo(notice(), "додай нотатку: домовились про знижку"));
    await runJobs(env, jobs);
    await handleUpdate(env, press("a:y", lastBotMessage("Додати до опису")));
    expect(log.find((l) => l.method === "PATCH")!.body.description).toBe("Агенда: кошторис\n\nДомовились про знижку");

    log.length = 0;
    await handleUpdate(env, replyTo(notice(), "скасуй"));
    await runJobs(env, jobs);
    await handleUpdate(env, press("a:y", lastBotMessage("Скасувати «Бюджет»")));
    const writes = log.filter((l) => l.method !== "GET");
    expect(writes.map((l) => l.method)).toEqual(["PATCH", "DELETE"]);
    expect(writes[0]!.body.extendedProperties.private.aisBotCancel).toBe("1");
    expect(writes[0]!.url.searchParams.get("sendUpdates")).toBe("none");
  });

  it("asks a question when the intent is unclear and takes the answer as a refinement", async () => {
    await connectGoogle();
    const log: { method: string; url: URL; body: any }[] = [];
    const prompts: string[] = [];
    mockFetch([
      eventRoutes(log),
      (url, init) => {
        if (url.hostname !== "openrouter.ai") return undefined;
        prompts.push(JSON.parse(init.bodyText).messages[1].content);
        return llmReply(
          prompts.length === 1 ? { action: "unclear", clarify_question: "На коли перенести?" } : { action: "reschedule", new_start: "2026-10-05T10:00:00+03:00" },
        );
      },
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, replyTo(notice(), "перенеси"));
    await runJobs(env, jobs);
    const question = lastBotMessage("На коли перенести?");
    await handleUpdate(env, replyTo(question, "на понеділок о 10"));
    await runJobs(env, jobs);
    expect(prompts[1]).toBe("перенеси\nна понеділок о 10");
    expect(lastBotMessage("Перенести «Бюджет»")).toBeTruthy();
  });

  it("the ✖️ button drops the action without touching the calendar", async () => {
    await connectGoogle();
    const log: { method: string; url: URL; body: any }[] = [];
    mockFetch([eventRoutes(log), (url) => (url.hostname === "openrouter.ai" ? llmReply({ action: "cancel" }) : undefined)]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, replyTo(notice(), "скасуй"));
    await runJobs(env, jobs);
    log.length = 0;
    await handleUpdate(env, press("a:x", lastBotMessage("Скасувати «Бюджет»")));
    expect(log).toEqual([]);
  });

  it("a deleted event is reported instead of acted on", async () => {
    await connectGoogle();
    const calls = mockFetch([(url) => (url.pathname.endsWith("/events/ev1") ? Response.json({ error: {} }, { status: 404 }) : undefined)]);
    const { env } = testEnv();
    await handleUpdate(env, replyTo(notice(), "хто буде?"));
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("уже не знайти");
  });
});
