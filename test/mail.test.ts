import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { looksLikeMailRequest } from "../src/bot/mail";
import type { Db } from "../src/db/client";
import { buildRawMessage, extractBody, replySubject } from "../src/google/gmail";
import { encrypt, fromBase64Url, toBase64Url } from "../src/lib/crypto";
import { handleUpdate } from "../src/telegram/handler";
import type { TgUpdate } from "../src/telegram/types";
import { type Call, llmReply, mockFetch, OWNER, pgliteDb, resetDb, runJobs, testConfig, testEnv, tgCalls } from "./helpers";

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

const b64 = (s: string) => toBase64Url(new TextEncoder().encode(s));
const decodeRaw = (raw: string) => new TextDecoder().decode(fromBase64Url(raw));

async function seedOwner(scope = "openid email calendar.events https://www.googleapis.com/auth/gmail.modify"): Promise<number> {
  const now = Date.now();
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO users (tg_id, full_name, position, email, created_at, updated_at)
     VALUES ($1, 'Олександр Коваленко', 'CEO', 'boss@acme.ua', $2, $2) RETURNING id`,
    [OWNER, now],
  );
  await db.query(
    "INSERT INTO google_auth (user_id, refresh_token_enc, access_token, expires_at, granted_scope, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [rows[0]!.id, await encrypt(testConfig.ENCRYPTION_KEY, "r"), await encrypt(testConfig.ENCRYPTION_KEY, "a"), now + 3600_000, scope, now],
  );
  await db.query("INSERT INTO contacts (name, email, updated_at) VALUES ('Іван Петренко', 'ivan@example.com', $1)", [now]);
  return rows[0]!.id;
}

function gmailMessage(id: string, over: { from?: string; subject?: string; body?: string; unread?: boolean } = {}) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: over.unread === false ? ["INBOX"] : ["INBOX", "UNREAD"],
    snippet: (over.body ?? "Привіт! Можемо зустрітись?").slice(0, 60),
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: over.from ?? "Іван Петренко <ivan@example.com>" },
        { name: "To", value: "boss@acme.ua" },
        { name: "Subject", value: over.subject ?? "Бюджет Буковелю" },
        { name: "Date", value: "Mon, 28 Sep 2026 10:00:00 +0300" },
        { name: "Message-ID", value: `<${id}@mail.example.com>` },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64(over.body ?? "Привіт! Можемо зустрітись?") } },
        { mimeType: "text/html", body: { data: b64("<p>HTML</p>") } },
      ],
    },
  };
}

/** Routes Gmail API calls to a tiny in-memory mailbox and records writes. */
function gmailRoutes(writes: { method: string; path: string; body: any }[], messages: Record<string, ReturnType<typeof gmailMessage>>) {
  return (url: URL, init: RequestInit & { bodyText: string }) => {
    if (url.hostname !== "gmail.googleapis.com") return undefined;
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (init.method && init.method !== "GET") {
      writes.push({ method: init.method, path, body: init.bodyText ? JSON.parse(init.bodyText) : null });
      if (path === "/labels") return Response.json({ id: "Label_1", name: JSON.parse(init.bodyText).name });
      return Response.json({ id: "sent-1", threadId: "t" });
    }
    if (path === "/messages") return Response.json({ messages: Object.keys(messages).map((id) => ({ id })) });
    if (path === "/labels") return Response.json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] });
    const m = /^\/messages\/([^/]+)$/.exec(path);
    if (m) return Response.json(messages[m[1]!]);
    return undefined;
  };
}

function text(t: string, extra: Record<string, unknown> = {}): TgUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: msgId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER, type: "private" },
      from: { id: OWNER, is_bot: false, first_name: "O" },
      text: t,
      ...extra,
    },
  };
}

function replyTo(messageId: number, t: string): TgUpdate {
  return text(t, { reply_to_message: { message_id: messageId, date: 0, chat: { id: OWNER, type: "private" } } });
}

function press(data: string): TgUpdate {
  return { update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: OWNER, is_bot: false, first_name: "O" }, data } };
}

const lastButtons = (calls: Call[]) => {
  const last = [...tgCalls(calls, "sendMessage"), ...tgCalls(calls, "editMessageText")].filter((m) => m.reply_markup).at(-1)!;
  return (last.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();
};

describe("mail routing", () => {
  it("recognizes mail requests by whole words only", () => {
    expect(looksLikeMailRequest("перевір пошту")).toBe(true);
    expect(looksLikeMailRequest("напиши Івану лист про бюджет")).toBe(true);
    expect(looksLikeMailRequest("проверь почту")).toBe(true);
    expect(looksLikeMailRequest("send an email to Ivan")).toBe(true);
    expect(looksLikeMailRequest("зустріч з Іваном 5 листопада о 15:00")).toBe(false);
    expect(looksLikeMailRequest("зустріч з Іваном завтра о 10")).toBe(false);
  });
});

describe("Gmail helpers", () => {
  it("builds a UTF-8 RFC 2822 message that threads a reply", () => {
    const raw = decodeRaw(
      buildRawMessage({ to: ["ivan@example.com"], subject: "Re: Бюджет", body: "Добре, буду.", inReplyTo: "<a@x>", references: "<z@x>" }),
    );
    expect(raw).toContain("To: ivan@example.com");
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Re: Бюджет").toString("base64")}?=`);
    expect(raw).toContain("In-Reply-To: <a@x>");
    expect(raw).toContain("References: <z@x> <a@x>");
    const body = raw.split("\r\n\r\n")[1]!;
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Добре, буду.");
    expect(replySubject("Re: Бюджет")).toBe("Re: Бюджет");
    expect(replySubject("Бюджет")).toBe("Re: Бюджет");
  });

  it("prefers the plain-text part and falls back to HTML converted to text", () => {
    expect(extractBody(gmailMessage("1").payload)).toBe("Привіт! Можемо зустрітись?");
    expect(extractBody({ mimeType: "text/html", body: { data: b64("<p>Рядок 1</p><p>Рядок&nbsp;2</p><script>x</script>") } })).toBe(
      "Рядок 1\nРядок 2",
    );
  });
});

describe("Gmail agent", () => {
  it("'перевір пошту' shows unread emails, one message per email, each with quick buttons", async () => {
    await seedOwner();
    const writes: { method: string; path: string; body: any }[] = [];
    const calls = mockFetch([
      (url) => (url.hostname === "openrouter.ai" ? llmReply({ action: "search", query: "is:unread in:inbox" }) : undefined),
      gmailRoutes(writes, { m1: gmailMessage("m1"), m2: gmailMessage("m2", { from: "Олег <oleh@x.ua>", subject: "Звіт" }) }),
    ]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, text("перевір пошту"));
    expect(jobs.map((j) => j.body.type)).toEqual(["mail_parse"]);
    await runJobs(env, jobs);

    const search = calls.find((c) => c.url.includes("/gmail/v1/users/me/messages?"))!;
    expect(new URL(search.url).searchParams.get("q")).toBe("is:unread in:inbox");
    const cards = tgCalls(calls, "sendMessage").filter((m) => String(m.text).startsWith("📧"));
    expect(cards.map((c) => String(c.text).split("\n")[1])).toEqual(["<b>Бюджет Буковелю</b>", "<b>Звіт</b>"]);
    expect(lastButtons(calls).map((b) => b.text)).toEqual(["📖 Прочитати", "✅ Прочитано", "🗄 В архів"]);
    const { rows } = await db.query("SELECT ref_type, ref_id FROM message_links ORDER BY ref_id");
    expect(rows).toEqual([
      { ref_type: "mail", ref_id: "m1" },
      { ref_type: "mail", ref_id: "m2" },
    ]);
    expect(writes).toEqual([]);
  });

  it("replying to an email drafts a threaded answer and sends it only after confirmation", async () => {
    await seedOwner();
    const writes: { method: string; path: string; body: any }[] = [];
    const calls = mockFetch([
      (url) => (url.hostname === "openrouter.ai" ? llmReply({ action: "reply", body: "Добре, буду в четвер." }) : undefined),
      gmailRoutes(writes, { m1: gmailMessage("m1") }),
    ]);
    const { env, jobs } = testEnv(db);
    const { linkMessage } = await import("../src/db/messageLinks");
    await linkMessage(db, 900, "mail", "m1");

    await handleUpdate(env, replyTo(900, "відповідай що буду в четвер"));
    await runJobs(env, jobs);
    const llm = calls.find((c) => c.url.includes("openrouter.ai"))!.body as { messages: { content: string }[] };
    expect(llm.messages[0]!.content).toContain("Тема: Бюджет Буковелю");
    const card = String(tgCalls(calls, "sendMessage").at(-1)!.text);
    expect(card).toContain("Відповісти Іван Петренко?");
    expect(card).toContain("Re: Бюджет Буковелю");
    expect(writes).toEqual([]);

    await handleUpdate(env, press(lastButtons(calls).find((b) => b.text === "✅ Надіслати")!.callback_data));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/messages/send");
    expect(writes[0]!.body.threadId).toBe("t-m1");
    const raw = decodeRaw(writes[0]!.body.raw);
    expect(raw).toContain("To: ivan@example.com");
    expect(raw).toContain("In-Reply-To: <m1@mail.example.com>");
    expect(String(tgCalls(calls, "editMessageText").at(-1)!.text)).toContain("Відповідь надіслано");
  });

  it("sends a new email to a contact from the address book; a name without email gets a question", async () => {
    await seedOwner();
    const writes: { method: string; path: string; body: any }[] = [];
    let n = 0;
    const calls = mockFetch([
      (url) =>
        url.hostname === "openrouter.ai"
          ? llmReply(
              n++ === 0
                ? { action: "send", to: [{ name: "Марія" }], subject: "Звіт", body: "Надішліть звіт." }
                : { action: "send", to: [{ name: "Іван" }], subject: "Перенесення", body: "Зустріч переносимо на пʼятницю." },
            )
          : undefined,
      gmailRoutes(writes, {}),
    ]);
    const { env, jobs } = testEnv(db);

    await handleUpdate(env, text("напиши Марії лист, щоб надіслала звіт"));
    await runJobs(env, jobs);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Вкажіть email для: Марія");
    expect(lastButtons(calls).map((b) => b.text)).toEqual(["✖️ Скасувати"]);
    await handleUpdate(env, press(lastButtons(calls)[0]!.callback_data));

    await handleUpdate(env, text("напиши Івану лист, що зустріч переносимо на пʼятницю"));
    await runJobs(env, jobs);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Іван &lt;ivan@example.com&gt;");
    await handleUpdate(env, press(lastButtons(calls).find((b) => b.text === "✅ Надіслати")!.callback_data));
    expect(writes.map((w) => w.path)).toEqual(["/messages/send"]);
    expect(decodeRaw(writes[0]!.body.raw)).toContain("To: ivan@example.com");
  });

  it("quick buttons mark as read and archive; reading shows the full text", async () => {
    await seedOwner();
    const writes: { method: string; path: string; body: any }[] = [];
    const calls = mockFetch([gmailRoutes(writes, { m1: gmailMessage("m1", { body: "Повний текст листа" }) })]);
    const { env } = testEnv(db);
    await handleUpdate(env, press("g:m1:r"));
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Повний текст листа");
    await handleUpdate(env, press("g:m1:a"));
    expect(writes.map((w) => [w.path, w.body])).toEqual([
      ["/messages/m1/modify", { addLabelIds: [], removeLabelIds: ["UNREAD"] }],
      ["/messages/m1/modify", { addLabelIds: [], removeLabelIds: ["INBOX"] }],
    ]);
  });

  it("trash and labels wait for confirmation; trash is recoverable", async () => {
    await seedOwner();
    const writes: { method: string; path: string; body: any }[] = [];
    let n = 0;
    const calls = mockFetch([
      (url) => (url.hostname === "openrouter.ai" ? llmReply(n++ === 0 ? { action: "label", label: "Бюджет" } : { action: "trash" }) : undefined),
      gmailRoutes(writes, { m1: gmailMessage("m1") }),
    ]);
    const { env, jobs } = testEnv(db);
    const { linkMessage } = await import("../src/db/messageLinks");
    await linkMessage(db, 900, "mail", "m1");

    await handleUpdate(env, replyTo(900, "додай мітку Бюджет"));
    await runJobs(env, jobs);
    await handleUpdate(env, press(lastButtons(calls).find((b) => b.text === "✅ Так")!.callback_data));
    expect(writes.map((w) => w.path)).toEqual(["/labels", "/messages/m1/modify"]);
    expect(writes[1]!.body).toEqual({ addLabelIds: ["Label_1"], removeLabelIds: [] });

    await handleUpdate(env, replyTo(900, "видали цей лист"));
    await runJobs(env, jobs);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Перемістити в кошик");
    await handleUpdate(env, press(lastButtons(calls).find((b) => b.text === "✅ Так")!.callback_data));
    expect(writes.at(-1)!.path).toBe("/messages/m1/trash");
  });

  it("asks to reconnect Google when the grant predates Gmail access", async () => {
    await seedOwner("openid email https://www.googleapis.com/auth/calendar.events");
    const calls = mockFetch([]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, text("перевір пошту"));
    expect(jobs).toEqual([]);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("дайте доступ до Gmail");
  });

  it("/mail routes explicitly, even without mail words", async () => {
    await seedOwner();
    mockFetch([]);
    const { env, jobs } = testEnv(db);
    await handleUpdate(env, text("/mail що нового?"));
    expect(jobs.map((j) => j.body.type)).toEqual(["mail_parse"]);
  });
});
