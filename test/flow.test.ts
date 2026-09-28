import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { oauthCallback, oauthStart, telegramWebhook } from "../src/app";
import type { Db } from "../src/db/client";
import { getDraft } from "../src/db/drafts";
import { getUserByTgId, listContacts } from "../src/db/users";
import { connectLink } from "../src/google/oauth";
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

async function seedConnectedOwner(): Promise<number> {
  const now = Date.now();
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO users (tg_id, tg_username, email, full_name, position, phone, defaults_json, created_at, updated_at)
     VALUES ($1, 'tester', 'o.kovalenko@ribas.ua', 'Олександр Коваленко', 'Директор', '+380671234567',
       '{"duration_min":60,"format":"offline","address":"вул. Хрещатик, 1"}', $2, $2) RETURNING id`,
    [OWNER, now],
  );
  await db.query(
    "INSERT INTO google_auth (user_id, refresh_token_enc, access_token, expires_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
    [rows[0]!.id, await encrypt(testConfig.ENCRYPTION_KEY, "r"), await encrypt(testConfig.ENCRYPTION_KEY, "a"), now + 3600_000, now],
  );
  await db.query("INSERT INTO contacts (name, email, updated_at) VALUES ('Олег Мельник', 'o.melnyk@ribas.ua', $1)", [now]);
  return rows[0]!.id;
}

function inDays(days: number, hourKyiv: number): string {
  const d = new Date(Date.now() + days * 86400_000);
  d.setUTCHours(hourKyiv - 3, 0, 0, 0);
  return d.toISOString().replace(".000Z", "Z");
}

describe("single owner", () => {
  it("ignores everyone except OWNER_TELEGRAM_ID, without replying or storing anything", async () => {
    const calls = mockFetch([]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, textUpdate(555, "/start"));
    await handleUpdate(env, textUpdate(555, "зустріч з Іваном завтра о 10"));
    await handleUpdate(env, callbackUpdate(555, "d:whatever:c"));
    expect(calls).toEqual([]);
    expect(jobs).toEqual([]);
    expect(await getUserByTgId(env.db, 555)).toBeNull();
  });

  it("ignores group chats even from the owner", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv(db);
    const update = textUpdate(OWNER, "/start");
    update.message!.chat = { id: -100, type: "group" };
    await handleUpdate(env, update);
    expect(calls).toEqual([]);
  });

  it("rejects webhook calls without the Telegram secret and handles valid ones in the background", async () => {
    mockFetch([]);
    const { env, deferred } = testEnv(db);
    const bad = await telegramWebhook(new Request("https://bot.test/api/telegram", { method: "POST", body: "{}" }), env, {
      defer: (p) => void deferred.push(p),
      sleep: async () => undefined,
    });
    expect(bad.status).toBe(403);

    const ok = await telegramWebhook(
      new Request("https://bot.test/api/telegram", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "tg-secret" },
        body: JSON.stringify(textUpdate(OWNER, "/start")),
      }),
      env,
      { defer: (p) => void deferred.push(p), sleep: async () => undefined },
    );
    expect(ok.status).toBe(200);
    await Promise.all(deferred);
    expect(await getUserByTgId(env.db, OWNER)).not.toBeNull();
  });
});

describe("owner onboarding", () => {
  it("collects the profile and ends with the Google Calendar connect button", async () => {
    const calls = mockFetch([]);
    const { env } = testEnv(db);
    await handleUpdate(env, textUpdate(OWNER, "/start"));
    await handleUpdate(env, textUpdate(OWNER, "Олександр"));
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("імʼя та прізвище");
    await handleUpdate(env, textUpdate(OWNER, "Олександр Коваленко"));
    await handleUpdate(env, textUpdate(OWNER, "Директор з розвитку"));
    await handleUpdate(env, textUpdate(OWNER, "", { contact: { phone_number: "380671234567", user_id: OWNER } }));
    await handleUpdate(env, callbackUpdate(OWNER, "o:dur:45"));
    await handleUpdate(env, callbackUpdate(OWNER, "o:fmt:google_meet"));
    await handleUpdate(env, callbackUpdate(OWNER, "o:addr:skip"));

    const owner = await getUserByTgId(env.db, OWNER);
    expect(owner).toMatchObject({
      full_name: "Олександр Коваленко",
      position: "Директор з розвитку",
      phone: "+380671234567",
      dialog_state: null,
      defaults: { duration_min: 45, format: "google_meet" },
    });
    const last = tgCalls(calls, "sendMessage").at(-1)!;
    expect(last.text).toContain("Google Calendar");
    const button = (last.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0]![0]!;
    expect(button.url).toMatch(/^https:\/\/bot\.test\/api\/oauth\/start\?state=/);
  });
});

describe("OAuth", () => {
  it("exchanges the code, subscribes to push and queues the initial sync", async () => {
    const userId = await seedConnectedOwner();
    await db.query("DELETE FROM google_auth");
    const idToken = `x.${btoa(JSON.stringify({ email: "Boss@Ribas.ua" })).replace(/=+$/, "")}.y`;
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
    const { env, jobs } = testEnv(db);
    const link = new URL(await connectLink(env, userId));
    const start = await oauthStart(new Request(link), env);
    expect(start.status).toBe(302);
    const google = new URL(start.headers.get("location")!);
    expect(google.searchParams.get("scope")).toContain("calendar.events");
    expect(google.searchParams.get("access_type")).toBe("offline");
    expect(google.searchParams.get("redirect_uri")).toBe("https://bot.test/api/oauth/callback");

    const cb = await oauthCallback(
      new Request(`https://bot.test/api/oauth/callback?code=abc&state=${encodeURIComponent(link.searchParams.get("state")!)}`),
      env,
    );
    expect(cb.status).toBe(200);
    const { rows } = await db.query<{ refresh_token_enc: string }>("SELECT refresh_token_enc FROM google_auth WHERE user_id = $1", [userId]);
    expect(rows[0]!.refresh_token_enc).toMatch(/^v1\./);
    expect(rows[0]!.refresh_token_enc).not.toContain("rt");
    expect((await getUserByTgId(env.db, OWNER))!.email).toBe("boss@ribas.ua");
    expect(calls.some((c) => c.url.endsWith("/events/watch"))).toBe(true);
    expect(jobs.map((j) => j.body)).toEqual([{ type: "full_sync", userId, notify: true }]);

    const forged = await oauthCallback(new Request("https://bot.test/api/oauth/callback?code=abc&state=forged.sig"), env);
    expect(forged.status).toBe(400);
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
        { name: "Олег", email: null, internal: false },
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

  it("text → card → «Створити» → Google event with invitations; attendees go to the address book", async () => {
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
    const { env, jobs } = testEnv(db);

    await handleUpdate(env, textUpdate(OWNER, "зустріч з Іваном Петренком по бюджету Буковелю"));
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("Готую картку");
    expect(jobs.map((j) => j.body.type)).toEqual(["parse"]);
    await runJobs(env, jobs);

    const llm = calls.find((c) => c.url.includes("openrouter.ai"))!.body as { model: string; messages: { content: unknown }[] };
    expect(llm.model).toBe("test/card-model");
    expect(String(llm.messages[0]!.content)).toContain("Олег Мельник <o.melnyk@ribas.ua>");

    const cardMsg = tgCalls(calls, "editMessageText").at(-1)!;
    expect(cardMsg.text).toContain("Нова зустріч");
    // Email from the address book; same corporate domain as the owner → colleague.
    expect(cardMsg.text).toContain("Олег (свій) — o.melnyk@ribas.ua");
    const buttons = (cardMsg.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
    expect(buttons.map((b) => b.callback_data.split(":")[2])).toEqual(["c", "e", "x"]);
    const create = buttons[0]!;

    await handleUpdate(env, callbackUpdate(OWNER, create.callback_data));
    // A double click does not create a second event.
    await handleUpdate(env, callbackUpdate(OWNER, create.callback_data));

    expect(insertUrl!.searchParams.get("sendUpdates")).toBe("all");
    expect(insertUrl!.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(inserted!.attendees).toEqual([
      { email: "ivan@example.com", displayName: "Іван Петренко" },
      { email: "o.melnyk@ribas.ua", displayName: "Олег" },
    ]);
    expect(inserted!.id).toMatch(/^ais[0-9a-f]{32}$/);
    expect(inserted!.location).toBe("вул. Хрещатик, 1");
    expect(inserted!.guestsCanModify).toBe(true);
    expect(inserted!.description).toContain("краще писати, ніж дзвонити");
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/calendars/primary/events?")).length).toBe(1);

    const { rows } = await db.query("SELECT source, status, title FROM meetings WHERE user_id = $1", [userId]);
    expect(rows).toEqual([{ source: "bot", status: "confirmed", title: "Іван Петренко + Олександр" }]);
    expect(tgCalls(calls, "editMessageText").at(-1)!.text).toContain("Зустріч створена");
    expect(tgCalls(calls, "answerCallbackQuery").map((a) => a.text)).toEqual(["Створено", "Вже обробляється"]);
    expect((await listContacts(db)).map((c) => c.email).sort()).toEqual(["ivan@example.com", "o.melnyk@ribas.ua"]);
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
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, textUpdate(OWNER, "треба зустрітись"));
    await runJobs(env, jobs);
    expect(tgCalls(calls, "editMessageText").at(-1)!.text).toContain("З ким зустріч?");

    await handleUpdate(env, textUpdate(OWNER, "з Іваном Петренком"));
    expect(jobs.map((j) => j.body.type)).toEqual(["parse"]);
    await runJobs(env, jobs);
    const second = calls.filter((c) => c.url.includes("openrouter.ai"))[1]!.body as { messages: { content: { text: string }[] }[] };
    expect(second.messages[1]!.content[0]!.text).toContain("Уточнення: з Іваном Петренком");
    expect(tgCalls(calls, "editMessageText").at(-1)!.text).toContain("Нова зустріч");
  });

  it("collects forwarded messages into one batch processed after the 15 s debounce", async () => {
    const userId = await seedConnectedOwner();
    const calls = mockFetch([(url) => (url.hostname === "openrouter.ai" ? llmReply(llmCard()) : undefined)]);
    const { env, jobs } = testEnv(db);
    const fwd = (text: string, fromName: string) =>
      textUpdate(OWNER, text, { forward_origin: { type: "user", date: 1790600000, sender_user: { id: 3, is_bot: false, first_name: fromName } } });
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
    const { rows } = await db.query("SELECT state, source_type FROM drafts WHERE user_id = $1", [userId]);
    expect(rows).toEqual([{ state: "pending", source_type: "forward" }]);
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
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, textUpdate(OWNER, "зустріч з Іваном"));
    await runJobs(env, jobs);
    const keyboard = (tgCalls(calls, "editMessageText").at(-1)!.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    const draftId = keyboard[0]![0]!.callback_data.split(":")[1]!;

    await handleUpdate(env, callbackUpdate(OWNER, `d:${draftId}:e`));
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("Напишіть, що змінити");
    await handleUpdate(env, textUpdate(OWNER, "прибери Олега, зроби онлайн"));
    expect(jobs.map((j) => j.body)).toEqual([{ type: "edit", draftId, instruction: "прибери Олега, зроби онлайн" }]);
    await runJobs(env, jobs);

    const editCall = calls.filter((c) => c.url.includes("openrouter.ai"))[1]!.body as { messages: { content: string }[] };
    expect(editCall.messages[1]!.content).toContain("Правка: прибери Олега, зроби онлайн");
    const draft = await getDraft(env.db, draftId);
    expect(draft).toMatchObject({ state: "pending", edits_count: 1 });
    expect(draft!.card!.format).toBe("google_meet");
    expect(tgCalls(calls, "editMessageText").at(-1)!.text).toContain("Google Meet");
  });

  it("offers free slots when the time is unknown and uses the chosen one", async () => {
    await seedConnectedOwner();
    const calls = mockFetch([(url) => (url.hostname === "openrouter.ai" ? llmReply(llmCard({ start: null })) : undefined)]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, textUpdate(OWNER, "зустріч з Іваном"));
    await runJobs(env, jobs);
    const keyboard = (tgCalls(calls, "editMessageText").at(-1)!.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] })
      .inline_keyboard;
    const slots = keyboard.flat().filter((b) => b.text.startsWith("🕒"));
    expect(slots).toHaveLength(3);

    await handleUpdate(env, callbackUpdate(OWNER, slots[1]!.callback_data));
    const draft = await getDraft(env.db, slots[1]!.callback_data.split(":")[1]!);
    expect(draft!.card!.start).toBeTruthy();
    const after = (tgCalls(calls, "editMessageText").at(-1)!.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard.flat();
    expect(after.some((b) => b.callback_data.endsWith(":c"))).toBe(true);
  });

  it("reports a failed LLM call to the owner after the retries", async () => {
    await seedConnectedOwner();
    const calls = mockFetch([(url) => (url.hostname === "openrouter.ai" ? new Response("bad", { status: 400 }) : undefined)]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, textUpdate(OWNER, "зустріч з Іваном"));
    await runJobs(env, jobs);
    const texts = tgCalls(calls, "sendMessage").map((m) => String(m.text));
    expect(texts.some((t) => t.includes("Не вдалося підготувати картку"))).toBe(true);
    const { rows } = await db.query<{ scope: string }>("SELECT scope FROM errors");
    expect(rows.map((r) => r.scope)).toEqual(["job.parse"]);
  });

  it("asks to connect the calendar before creating anything", async () => {
    await seedConnectedOwner();
    await db.query("DELETE FROM google_auth");
    const calls = mockFetch([]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, textUpdate(OWNER, "зустріч з Іваном завтра"));
    expect(jobs).toEqual([]);
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("підключіть Google Calendar");
  });
});

describe("address book", () => {
  it("adds, lists and deletes contacts", async () => {
    await seedConnectedOwner();
    const calls = mockFetch([]);
    const { env } = testEnv(db);
    await handleUpdate(env, textUpdate(OWNER, "/contact Іван Петренко Ivan@Example.com"));
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("Збережено: Іван Петренко — ivan@example.com");
    await handleUpdate(env, textUpdate(OWNER, "/contact без пошти"));
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("Формат");
    await handleUpdate(env, textUpdate(OWNER, "/contacts"));
    expect(tgCalls(calls, "sendMessage").at(-1)!.text).toContain("Іван Петренко — ivan@example.com");
    await handleUpdate(env, textUpdate(OWNER, "/contact_del ivan@example.com"));
    expect((await listContacts(db)).map((c) => c.email)).toEqual(["o.melnyk@ribas.ua"]);
  });
});
