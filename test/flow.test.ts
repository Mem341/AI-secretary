import { env as baseEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { getDraft } from "../src/db/drafts";
import { getUserByTgId } from "../src/db/users";
import type { Env } from "../src/env";
import { connectLink } from "../src/google/oauth";
import type { Job } from "../src/jobs";
import { encrypt } from "../src/lib/crypto";
import { handleUpdate } from "../src/telegram/handler";
import type { TgUpdate } from "../src/telegram/types";
import { llmReply, mockFetch, resetDb, testEnv, tgCalls } from "./helpers";

const plainEnv = baseEnv as unknown as Env;
const ADMIN = 1000;
let updateId = 1;
let msgId = 10;

function textUpdate(fromId: number, text: string, extra: Record<string, unknown> = {}): TgUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: msgId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: "private" },
      from: { id: fromId, is_bot: false, first_name: "Test", username: "tester" },
      text,
      ...extra,
    },
  };
}

function callbackUpdate(fromId: number, data: string): TgUpdate {
  return {
    update_id: updateId++,
    callback_query: { id: `cb${updateId}`, from: { id: fromId, is_bot: false, first_name: "Test" }, data },
  };
}

async function runJobs(env: Env, jobs: { body: Job }[]): Promise<void> {
  while (jobs.length) {
    const { body } = jobs.shift()!;
    const message = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [message] } as unknown as MessageBatch<Job>, env);
    expect(message.retry).not.toHaveBeenCalled();
  }
}

async function seedConnectedOwner(): Promise<number> {
  const now = Date.now();
  const row = await plainEnv.DB.prepare(
    `INSERT INTO users (tg_id, tg_username, email, full_name, position, phone, role, defaults_json, created_at, updated_at)
     VALUES (?, 'tester', 'o.kovalenko@ribas.ua', 'Олександр Коваленко', 'Директор', '+380671234567', 'owner',
       '{"duration_min":60,"format":"offline","address":"вул. Хрещатик, 1"}', ?, ?) RETURNING id`,
  )
    .bind(ADMIN, now, now)
    .first<{ id: number }>();
  await plainEnv.DB.prepare(
    "INSERT INTO google_auth (user_id, refresh_token_enc, access_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(row!.id, await encrypt(plainEnv.ENCRYPTION_KEY, "r"), await encrypt(plainEnv.ENCRYPTION_KEY, "a"), now + 3600_000, now)
    .run();
  await plainEnv.DB.prepare(
    "INSERT INTO users (tg_id, email, full_name, role, created_at, updated_at) VALUES (2000, 'o.melnyk@ribas.ua', 'Олег Мельник', 'member', ?, ?)",
  )
    .bind(now, now)
    .run();
  return row!.id;
}

function inDays(days: number, hour: number): string {
  // A weekday-agnostic future time in Kyiv (+03:00 in the test period is not assumed: use UTC offset form).
  const d = new Date(Date.now() + days * 86400_000);
  d.setUTCHours(hour - 3, 0, 0, 0);
  return d.toISOString().replace(".000Z", "Z");
}

beforeEach(async () => {
  await resetDb();
});
afterEach(() => vi.restoreAllMocks());

describe("access control", () => {
  it("rejects a stranger and shows their Telegram ID", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv();
    await handleUpdate(env, textUpdate(555, "привіт"));
    const sent = tgCalls(calls, "sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Доступ обмежено");
    expect(sent[0]!.text).toContain("555");
    expect(await getUserByTgId(env.DB, 555)).toBeNull();
  });

  it("rejects webhook calls without the Telegram secret", async () => {
    const res = await worker.fetch(
      new Request("https://bot.test/telegram/webhook", { method: "POST", body: "{}" }),
      plainEnv,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });

  it("lets the admin whitelist a member, who then onboards with name and email", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv();
    await handleUpdate(env, textUpdate(ADMIN, "/allow 2000 member"));
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("2000 додано");

    await handleUpdate(env, textUpdate(2000, "/start"));
    await handleUpdate(env, textUpdate(2000, "Олег"));
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("імʼя та прізвище");
    await handleUpdate(env, textUpdate(2000, "Олег Мельник"));
    await handleUpdate(env, textUpdate(2000, "not email"));
    await handleUpdate(env, textUpdate(2000, "O.Melnyk@Ribas.ua"));
    const member = await getUserByTgId(env.DB, 2000);
    expect(member).toMatchObject({ full_name: "Олег Мельник", email: "o.melnyk@ribas.ua", role: "member", dialog_state: null });
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("Готово");
  });

  it("members cannot create meetings", async () => {
    const calls = mockFetch([]);
    const { env, jobs } = testEnv();
    await seedConnectedOwner();
    await handleUpdate(env, textUpdate(2000, "зустріч з Іваном завтра о 10"));
    expect(jobs).toEqual([]);
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("нагадування");
  });
});

describe("owner onboarding", () => {
  it("collects the profile and ends with the Google Calendar connect button", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv();
    await handleUpdate(env, textUpdate(ADMIN, "/start"));
    await handleUpdate(env, textUpdate(ADMIN, "Олександр Коваленко"));
    await handleUpdate(env, textUpdate(ADMIN, "Директор з розвитку"));
    await handleUpdate(env, textUpdate(ADMIN, "", { contact: { phone_number: "380671234567", user_id: ADMIN } }));
    await handleUpdate(env, callbackUpdate(ADMIN, "o:dur:45"));
    await handleUpdate(env, callbackUpdate(ADMIN, "o:fmt:google_meet"));
    await handleUpdate(env, callbackUpdate(ADMIN, "o:addr:skip"));

    const owner = await getUserByTgId(env.DB, ADMIN);
    expect(owner).toMatchObject({
      full_name: "Олександр Коваленко",
      position: "Директор з розвитку",
      phone: "+380671234567",
      role: "owner",
      dialog_state: null,
      defaults: { duration_min: 45, format: "google_meet" },
    });
    const last = tgCalls(calls, "sendMessage").at(-1)!;
    expect(last.text).toContain("Google Calendar");
    const button = (last.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0]![0]!;
    expect(button.url).toMatch(/^https:\/\/bot\.test\/oauth\/google\/start\?state=/);
  });
});

describe("OAuth", () => {
  it("exchanges the code, subscribes to push and queues the initial sync", async () => {
    const userId = (await seedConnectedOwner()) as number;
    await plainEnv.DB.prepare("DELETE FROM google_auth").run();
    const idToken = `x.${btoa(JSON.stringify({ email: "boss@ribas.ua" })).replace(/=+$/, "")}.y`;
    const calls = mockFetch([
      (url) =>
        url.hostname === "oauth2.googleapis.com"
          ? Response.json({
              access_token: "at",
              expires_in: 3600,
              refresh_token: "rt",
              id_token: idToken,
              scope: "openid email https://www.googleapis.com/auth/calendar.events",
            })
          : undefined,
      (url) => (url.pathname.endsWith("/events/watch") ? Response.json({ id: "c", resourceId: "r", expiration: "9999999999999" }) : undefined),
    ]);
    const { env, jobs } = testEnv();
    const link = new URL(await connectLink(env, userId));
    const start = await worker.fetch(new Request(link), env, {} as ExecutionContext);
    expect(start.status).toBe(302);
    const google = new URL(start.headers.get("location")!);
    expect(google.searchParams.get("scope")).toContain("calendar.events");
    expect(google.searchParams.get("access_type")).toBe("offline");

    const cb = await worker.fetch(
      new Request(`https://bot.test/oauth/google/callback?code=abc&state=${encodeURIComponent(link.searchParams.get("state")!)}`),
      env,
      {} as ExecutionContext,
    );
    expect(cb.status).toBe(200);
    const stored = await env.DB.prepare("SELECT refresh_token_enc FROM google_auth WHERE user_id = ?").bind(userId).first<{ refresh_token_enc: string }>();
    expect(stored!.refresh_token_enc).toMatch(/^v1\./);
    expect(stored!.refresh_token_enc).not.toContain("rt");
    expect(calls.some((c) => c.url.endsWith("/events/watch"))).toBe(true);
    expect(jobs.map((j) => j.body)).toEqual([{ type: "full_sync", userId, notify: true }]);

    const bad = await worker.fetch(new Request("https://bot.test/oauth/google/callback?code=abc&state=forged.sig"), env, {} as ExecutionContext);
    expect(bad.status).toBe(400);
  });
});

describe("meeting creation", () => {
  const start = inDays(3, 15);

  function llmCard(over: Record<string, unknown> = {}) {
    return {
      title: "Іван Петренко + Олександр",
      start,
      duration_min: null,
      format: null,
      location: null,
      attendees: [
        { name: "Іван Петренко", email: "ivan@example.com", internal: false },
        { name: "Олег", email: null, internal: true },
      ],
      initiator: "Іван Петренко",
      purpose: "Бюджет Буковелю",
      agenda: ["Кошторис"],
      agreed_via: null,
      agreed_at: null,
      missing: [],
      confidence: 0.95,
      clarify_question: null,
      ...over,
    };
  }

  it("text → card → «Створити» → Google event with invitations", async () => {
    const userId = await seedConnectedOwner();
    let inserted: Record<string, any> | null = null;
    let insertUrl: URL | null = null;
    const calls = mockFetch([
      (url) => (url.hostname === "openrouter.ai" ? llmReply(llmCard()) : undefined),
      (url, init) => {
        if (!(url.pathname.endsWith("/calendars/primary/events") && init.method === "POST")) return undefined;
        inserted = JSON.parse(init.bodyText);
        insertUrl = url;
        return Response.json({
          ...inserted,
          status: "confirmed",
          htmlLink: "https://calendar.google.com/event?eid=1",
          attendees: [...inserted!.attendees, { email: "o.kovalenko@ribas.ua", self: true, responseStatus: "accepted" }],
        });
      },
    ]);
    const { env, jobs } = testEnv();

    await handleUpdate(env, textUpdate(ADMIN, "зустріч з Іваном Петренком по бюджету Буковелю"));
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("Готую картку");
    expect(jobs.map((j) => j.body.type)).toEqual(["parse"]);
    await runJobs(env, jobs);

    const llm = calls.find((c) => c.url.includes("openrouter.ai"))!.body as { model: string; messages: { content: unknown }[] };
    expect(llm.model).toBe(env.LLM_MODEL);
    expect(String(llm.messages[0]!.content)).toContain("Олег Мельник <o.melnyk@ribas.ua>");

    const cardMsg = tgCalls(calls, "editMessageText").at(-1)!;
    expect(cardMsg.text).toContain("Нова зустріч");
    expect(cardMsg.text).toContain("Олег (свій) — o.melnyk@ribas.ua");
    const buttons = (cardMsg.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
    const create = buttons.find((b) => b.callback_data.endsWith(":c"))!;
    expect(buttons.map((b) => b.callback_data.split(":")[2])).toEqual(["c", "e", "x"]);

    await handleUpdate(env, callbackUpdate(ADMIN, create.callback_data));
    // Double click does not create a second event.
    await handleUpdate(env, callbackUpdate(ADMIN, create.callback_data));

    expect(insertUrl!.searchParams.get("sendUpdates")).toBe("all");
    expect(insertUrl!.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(inserted!.attendees).toEqual([
      { email: "ivan@example.com", displayName: "Іван Петренко" },
      { email: "o.melnyk@ribas.ua", displayName: "Олег" },
    ]);
    expect(inserted!.id).toMatch(/^ais[0-9a-f]{32}$/);
    expect(inserted!.location).toBe("вул. Хрещатик, 1");
    expect(inserted!.description).toContain("краще писати, ніж дзвонити");
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/calendars/primary/events?")).length).toBe(1);

    const meeting = await env.DB.prepare("SELECT source, status, title FROM meetings WHERE user_id = ?").bind(userId).first();
    expect(meeting).toEqual({ source: "bot", status: "confirmed", title: "Іван Петренко + Олександр" });
    expect(tgCalls(calls, "editMessageText").at(-1)!.text).toContain("Зустріч створена");
    expect(tgCalls(calls, "answerCallbackQuery").map((a) => a.text)).toEqual(["Створено", "Вже обробляється"]);
  });

  it("asks a clarifying question when confidence is low, then builds the card from the answer", async () => {
    await seedConnectedOwner();
    let n = 0;
    const calls = mockFetch([
      (url) =>
        url.hostname === "openrouter.ai"
          ? llmReply(n++ === 0 ? llmCard({ confidence: 0.3, clarify_question: "З ким зустріч?" }) : llmCard())
          : undefined,
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(ADMIN, "треба зустрітись"));
    await runJobs(env, jobs);
    expect(tgCalls(calls, "editMessageText").at(-1)!.text).toContain("З ким зустріч?");

    await handleUpdate(env, textUpdate(ADMIN, "з Іваном Петренком"));
    expect(jobs.map((j) => j.body.type)).toEqual(["parse"]);
    await runJobs(env, jobs);
    const second = calls.filter((c) => c.url.includes("openrouter.ai"))[1]!.body as { messages: { content: { text: string }[] }[] };
    expect(second.messages[1]!.content[0]!.text).toContain("Уточнення: з Іваном Петренком");
    expect(tgCalls(calls, "editMessageText").at(-1)!.text).toContain("Нова зустріч");
  });

  it("collects forwarded messages into one batch processed after the debounce", async () => {
    const userId = await seedConnectedOwner();
    const calls = mockFetch([(url) => (url.hostname === "openrouter.ai" ? llmReply(llmCard()) : undefined)]);
    const { env, jobs } = testEnv();
    const fwd = (text: string, fromName: string) =>
      textUpdate(ADMIN, text, { forward_origin: { type: "user", date: 1790600000, sender_user: { id: 3, is_bot: false, first_name: fromName } } });
    await handleUpdate(env, fwd("Добрий день! Можемо зустрітись у четвер?", "Іван"));
    await handleUpdate(env, fwd("о 15:00 підійде", "Іван"));

    expect(jobs.map((j) => [j.body.type, (j.body as { seq: number }).seq, j.delaySeconds])).toEqual([
      ["batch", 1, 15],
      ["batch", 2, 15],
    ]);
    expect(tgCalls(calls, "sendMessage").filter((m) => String(m.text).includes("Збираю переписку"))).toHaveLength(1);
    await runJobs(env, jobs);

    const llmCalls = calls.filter((c) => c.url.includes("openrouter.ai"));
    expect(llmCalls).toHaveLength(1);
    const content = (llmCalls[0]!.body as { messages: { content: { text: string }[] }[] }).messages[1]!.content[0]!.text;
    expect(content).toContain("Переслана керівником переписка");
    expect(content).toMatch(/\] Іван: Добрий день! Можемо зустрітись у четвер\?\n\[.*\] Іван: о 15:00 підійде/);
    const drafts = await env.DB.prepare("SELECT state, source_type FROM drafts WHERE user_id = ?").bind(userId).all();
    expect(drafts.results).toEqual([{ state: "pending", source_type: "forward" }]);
  });

  it("applies a free-text edit after «Змінити» and counts it", async () => {
    await seedConnectedOwner();
    let n = 0;
    const calls = mockFetch([
      (url) =>
        url.hostname === "openrouter.ai"
          ? llmReply(n++ === 0 ? llmCard() : llmCard({ attendees: [{ name: "Іван Петренко", email: "ivan@example.com" }], format: "google_meet" }))
          : undefined,
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(ADMIN, "зустріч з Іваном"));
    await runJobs(env, jobs);
    const draftId = String((tgCalls(calls, "editMessageText").at(-1)!.reply_markup as any).inline_keyboard[0][0].callback_data).split(":")[1]!;

    await handleUpdate(env, callbackUpdate(ADMIN, `d:${draftId}:e`));
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("Напишіть, що змінити");
    await handleUpdate(env, textUpdate(ADMIN, "прибери Олега, зроби онлайн"));
    expect(jobs.map((j) => j.body)).toEqual([{ type: "edit", draftId, instruction: "прибери Олега, зроби онлайн" }]);
    await runJobs(env, jobs);

    const editCall = calls.filter((c) => c.url.includes("openrouter.ai"))[1]!.body as { messages: { content: string }[] };
    expect(editCall.messages[1]!.content).toContain("Правка: прибери Олега, зроби онлайн");
    const draft = await getDraft(env.DB, draftId);
    expect(draft).toMatchObject({ state: "pending", edits_count: 1 });
    expect(draft!.card!.format).toBe("google_meet");
    expect(tgCalls(calls, "editMessageText").at(-1)!.text).toContain("Google Meet");
  });

  it("offers free slots when the time is unknown and uses the chosen one", async () => {
    await seedConnectedOwner();
    const calls = mockFetch([(url) => (url.hostname === "openrouter.ai" ? llmReply(llmCard({ start: null })) : undefined)]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(ADMIN, "зустріч з Іваном"));
    await runJobs(env, jobs);
    const keyboard = (tgCalls(calls, "editMessageText").at(-1)!.reply_markup as any).inline_keyboard as { text: string; callback_data: string }[][];
    const slots = keyboard.flat().filter((b) => b.text.startsWith("🕒"));
    expect(slots).toHaveLength(3);

    await handleUpdate(env, callbackUpdate(ADMIN, slots[1]!.callback_data));
    const draft = await getDraft(env.DB, slots[1]!.callback_data.split(":")[1]!);
    expect(draft!.card!.start).toBeTruthy();
    const after = (tgCalls(calls, "editMessageText").at(-1)!.reply_markup as any).inline_keyboard.flat() as { callback_data: string }[];
    expect(after.some((b) => b.callback_data.endsWith(":c"))).toBe(true);
  });

  it("asks to connect the calendar before creating anything", async () => {
    await seedConnectedOwner();
    await plainEnv.DB.prepare("DELETE FROM google_auth").run();
    const calls = mockFetch([]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, textUpdate(ADMIN, "зустріч з Іваном завтра"));
    expect(jobs).toEqual([]);
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("підключіть Google Calendar");
  });
});
