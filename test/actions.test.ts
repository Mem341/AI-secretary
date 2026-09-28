import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client";
import { getMeetingById, upsertMeeting } from "../src/db/meetings";
import { linkMessage } from "../src/db/messageLinks";
import { isSelfWrite } from "../src/db/selfWrites";
import { encrypt } from "../src/lib/crypto";
import { handleUpdate } from "../src/telegram/handler";
import type { TgUpdate } from "../src/telegram/types";
import { llmReply, mockFetch, OWNER, pgliteDb, resetDb, runJobs, testConfig, testEnv, tgCalls } from "./helpers";

let db: Db;
let updateId = 1;
let msgId = 10;

beforeAll(async () => {
  db = await pgliteDb();
});
beforeEach(async () => {
  await resetDb(db);
});
afterEach(() => vi.restoreAllMocks());

const START = Date.parse("2026-10-01T12:00:00Z");
const NOTICE_ID = 777;

async function seedOwnerWithMeeting(): Promise<string> {
  const now = Date.now();
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO users (tg_id, full_name, position, created_at, updated_at) VALUES ($1, 'Олександр Коваленко', 'CEO', $2, $2) RETURNING id`,
    [OWNER, now],
  );
  const userId = rows[0]!.id;
  await db.query(
    "INSERT INTO google_auth (user_id, refresh_token_enc, access_token, expires_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
    [userId, await encrypt(testConfig.ENCRYPTION_KEY, "r"), await encrypt(testConfig.ENCRYPTION_KEY, "a"), now + 3600_000, now],
  );
  const { id } = await upsertMeeting(db, userId, "ev1", {
    title: "Бюджет",
    description: "Агенда: кошторис",
    start_at: START,
    end_at: START + 3600_000,
    location: null,
    meet_url: null,
    html_link: null,
    attendees: [
      { email: "ivan@example.com", name: "Іван", response: "accepted" },
      { email: "oleh@example.com", name: null, response: "needsAction" },
    ],
    organizer_email: null,
    gcal_created_at: null,
  });
  await linkMessage(db, NOTICE_ID, "meeting", id);
  return id;
}

function replyTo(messageId: number, text: string): TgUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: msgId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER, type: "private" },
      from: { id: OWNER, is_bot: false, first_name: "O" },
      text,
      reply_to_message: { message_id: messageId, date: 0, chat: { id: OWNER, type: "private" } },
    },
  };
}

function press(data: string): TgUpdate {
  return { update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: OWNER, is_bot: false, first_name: "O" }, data } };
}

const lastKeyboard = (calls: ReturnType<typeof mockFetch>) => {
  const last = [...tgCalls(calls, "sendMessage"), ...tgCalls(calls, "editMessageText")].filter((m) => m.reply_markup).at(-1)!;
  return ((last.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard).flat();
};

describe("replying to a message about a meeting", () => {
  it("answers 'who is attending' from the stored meeting, without calling the LLM", async () => {
    await seedOwnerWithMeeting();
    const calls = mockFetch([]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, replyTo(NOTICE_ID, "хто буде?"));
    expect(jobs).toEqual([]);
    expect(calls.some((c) => c.url.includes("openrouter.ai"))).toBe(false);
    const text = String(tgCalls(calls, "sendMessage").at(-1)!.text);
    expect(text).toContain("Іван — прийде");
    expect(text).toContain("oleh@example.com — не відповів(ла)");
  });

  it("reschedules after confirmation: patches the event with notifications and updates the mirror", async () => {
    const meetingId = await seedOwnerWithMeeting();
    let patch: { url: URL; body: any } | null = null;
    const calls = mockFetch([
      (url) => (url.hostname === "openrouter.ai" ? llmReply({ action: "reschedule", new_start: "2026-10-02T16:00:00+03:00" }) : undefined),
      (url, init) => {
        if (init.method !== "PATCH") return undefined;
        patch = { url, body: JSON.parse(init.bodyText) };
        return Response.json({ id: "ev1" });
      },
    ]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, replyTo(NOTICE_ID, "перенеси на завтра о 16"));
    await runJobs(env, jobs);
    const card = String(tgCalls(calls, "sendMessage").at(-1)!.text);
    expect(card).toContain("Перенести «Бюджет»");
    expect(card).toContain("Стане: пт, 2 жовтня, 16:00–17:00");
    expect(patch).toBeNull();

    await handleUpdate(env, press(lastKeyboard(calls).find((b) => b.text === "✅ Так")!.callback_data));
    expect(patch!.url.pathname).toContain("/events/ev1");
    expect(patch!.url.searchParams.get("sendUpdates")).toBe("all");
    expect(patch!.body.start.dateTime).toBe("2026-10-02T13:00:00.000Z");
    expect(patch!.body.end.dateTime).toBe("2026-10-02T14:00:00.000Z");
    expect((await getMeetingById(db, meetingId))!.start_at).toBe(Date.parse("2026-10-02T13:00:00Z"));
    expect(await isSelfWrite(db, "ev1")).toBe(true);
    expect(String(tgCalls(calls, "editMessageText").at(-1)!.text)).toContain("Перенесено");
  });

  it("cancels after confirmation and appends a note to the description", async () => {
    const meetingId = await seedOwnerWithMeeting();
    let n = 0;
    const methods: string[] = [];
    let description = "";
    const calls = mockFetch([
      (url) =>
        url.hostname === "openrouter.ai"
          ? llmReply(n++ === 0 ? { action: "note", note_text: "Домовились про знижку" } : { action: "cancel" })
          : undefined,
      (url, init) => {
        if (!url.pathname.includes("/events/ev1")) return undefined;
        methods.push(init.method!);
        if (init.method === "PATCH") description = JSON.parse(init.bodyText).description;
        return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: "ev1" });
      },
    ]);
    const { env, jobs } = testEnv(db);

    await handleUpdate(env, replyTo(NOTICE_ID, "додай нотатку: домовились про знижку"));
    await runJobs(env, jobs);
    await handleUpdate(env, press(lastKeyboard(calls).find((b) => b.text === "✅ Так")!.callback_data));
    expect(description).toBe("Агенда: кошторис\n\nДомовились про знижку");
    expect((await getMeetingById(db, meetingId))!.description).toBe(description);

    await handleUpdate(env, replyTo(NOTICE_ID, "скасуй"));
    await runJobs(env, jobs);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Скасувати «Бюджет»");
    await handleUpdate(env, press(lastKeyboard(calls).find((b) => b.text === "✅ Так")!.callback_data));
    expect(methods).toEqual(["PATCH", "DELETE"]);
  });

  it("asks a question when the intent is unclear and takes the answer as a refinement", async () => {
    await seedOwnerWithMeeting();
    let n = 0;
    const calls = mockFetch([
      (url) =>
        url.hostname === "openrouter.ai"
          ? llmReply(n++ === 0 ? { action: "unclear", clarify_question: "На коли перенести?" } : { action: "reschedule", new_start: "2026-10-05T10:00:00+03:00" })
          : undefined,
    ]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, replyTo(NOTICE_ID, "перенеси"));
    await runJobs(env, jobs);
    const question = tgCalls(calls, "sendMessage").at(-1)!;
    expect(String(question.text)).toContain("На коли перенести?");
    expect(lastKeyboard(calls).map((b) => b.text)).toEqual(["✖️ Скасувати"]);

    // Answering the question (a reply to it) refines the same action.
    const { rows } = await db.query<{ card_message_id: number }>("SELECT card_message_id FROM drafts WHERE kind = 'action'");
    await handleUpdate(env, replyTo(rows[0]!.card_message_id, "на понеділок о 10"));
    await runJobs(env, jobs);
    const second = calls.filter((c) => c.url.includes("openrouter.ai"))[1]!.body as { messages: { content: string }[] };
    expect(second.messages[1]!.content).toContain("перенеси\nна понеділок о 10");
    expect(String(tgCalls(calls, "editMessageText").at(-1)!.text)).toContain("Перенести");
  });

  it("the ✖️ button drops the action without touching the calendar", async () => {
    await seedOwnerWithMeeting();
    const calls = mockFetch([(url) => (url.hostname === "openrouter.ai" ? llmReply({ action: "cancel" }) : undefined)]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, replyTo(NOTICE_ID, "скасуй"));
    await runJobs(env, jobs);
    await handleUpdate(env, press(lastKeyboard(calls).find((b) => b.text === "✖️ Скасувати")!.callback_data));
    expect(calls.some((c) => c.url.includes("googleapis.com/calendar"))).toBe(false);
  });
});
