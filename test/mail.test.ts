import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gmailPush } from "../src/app";
import { looksLikeMailRequest } from "../src/bot/mail";
import { buildRawMessage, extractBody, replySubject } from "../src/google/gmail";
import { gmailPushToken, gmailSync, SEEN_LABEL } from "../src/google/gmailPush";
import { fromBase64Url, toBase64Url } from "../src/lib/crypto";
import { handleUpdate } from "../src/telegram/handler";
import { hiddenData, readHidden } from "../src/telegram/hidden";
import type { TgMessage, TgUpdate } from "../src/telegram/types";
import {
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

const b64 = (s: string) => toBase64Url(new TextEncoder().encode(s));
const decodeRaw = (raw: string) => new TextDecoder().decode(fromBase64Url(raw));

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

const replyTo = (message: TgMessage, t: string) => text(t, { reply_to_message: message });

function press(data: string, message?: TgMessage): TgUpdate {
  return { update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: OWNER, is_bot: false, first_name: "O" }, data, message } };
}

/** An email card as the bot sends it (the Gmail id hidden inside). */
const mailCard = (id: string) => tg.message(hiddenData({ k: "mail", id }) + "📧 <b>Іван Петренко</b>");

/** The calendar knows Ivan from a past meeting — that is the address book. */
const knownPeople = calendarList([{ id: "old", attendees: [{ email: "ivan@example.com", displayName: "Іван Петренко" }] }]);

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
  it("'перевір пошту' shows unread emails, one message per email with its id hidden, each with quick buttons", async () => {
    await connectGoogle();
    const writes: { method: string; path: string; body: any }[] = [];
    const calls = mockFetch([
      knownPeople,
      (url) => (url.hostname === "openrouter.ai" ? llmReply({ action: "search", query: "is:unread in:inbox" }) : undefined),
      gmailRoutes(writes, { m1: gmailMessage("m1"), m2: gmailMessage("m2", { from: "Олег <oleh@x.ua>", subject: "Звіт" }) }),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, text("перевір пошту"));
    expect(jobs.map((j) => j.body)).toEqual([{ type: "mail", text: "перевір пошту", targetId: null }]);
    await runJobs(env, jobs);

    const search = calls.find((c) => c.url.includes("/gmail/v1/users/me/messages?"))!;
    expect(new URL(search.url).searchParams.get("q")).toBe("is:unread in:inbox");
    const cards = [...tg.messages.values()].filter((m) => m.text?.includes("📧"));
    expect(cards.map((c) => readHidden(c))).toEqual([
      { k: "mail", id: "m1" },
      { k: "mail", id: "m2" },
    ]);
    const buttons = (tgCalls(calls, "sendMessage").at(-1)!.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(["📖 Прочитати", "✅ Прочитано", "🗄 В архів"]);
    expect(writes).toEqual([]);
  });

  it("replying to an email drafts a threaded answer and sends it only after confirmation", async () => {
    await connectGoogle();
    const writes: { method: string; path: string; body: any }[] = [];
    const calls = mockFetch([
      knownPeople,
      (url) => (url.hostname === "openrouter.ai" ? llmReply({ action: "reply", body: "Добре, буду в четвер." }) : undefined),
      gmailRoutes(writes, { m1: gmailMessage("m1") }),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, replyTo(mailCard("m1"), "відповідай що буду в четвер"));
    await runJobs(env, jobs);
    const llm = calls.find((c) => c.url.includes("openrouter.ai"))!.body as { messages: { content: string }[] };
    expect(llm.messages[0]!.content).toContain("Тема: Бюджет Буковелю");
    const confirm = lastBotMessage("Відповісти Іван Петренко?");
    expect(confirm.text).toContain("Re: Бюджет Буковелю");
    expect(writes).toEqual([]);

    await handleUpdate(env, press("m:y", confirm));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/messages/send");
    expect(writes[0]!.body.threadId).toBe("t-m1");
    const raw = decodeRaw(writes[0]!.body.raw);
    expect(raw).toContain("To: ivan@example.com");
    expect(raw).toContain("In-Reply-To: <m1@mail.example.com>");
    expect(tg.messages.get(confirm.message_id)!.text).toContain("Відповідь надіслано");
  });

  it("finds a known person's email in the calendar; a name without email gets a question", async () => {
    await connectGoogle();
    const writes: { method: string; path: string; body: any }[] = [];
    let n = 0;
    mockFetch([
      knownPeople,
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
    const { env, jobs } = testEnv();

    await handleUpdate(env, text("напиши Марії лист, щоб надіслала звіт"));
    await runJobs(env, jobs);
    expect(lastBotMessage("Вкажіть email для: Марія")).toBeTruthy();

    await handleUpdate(env, text("/cancel"));
    await handleUpdate(env, text("напиши Івану лист, що зустріч переносимо на пʼятницю"));
    await runJobs(env, jobs);
    const confirm = lastBotMessage("Іван &lt;ivan@example.com&gt;");
    await handleUpdate(env, press("m:y", confirm));
    expect(writes.map((w) => w.path)).toEqual(["/messages/send"]);
    expect(decodeRaw(writes[0]!.body.raw)).toContain("To: ivan@example.com");
  });

  it("quick buttons mark as read and archive; reading shows the full text", async () => {
    await connectGoogle();
    const writes: { method: string; path: string; body: any }[] = [];
    const calls = mockFetch([gmailRoutes(writes, { m1: gmailMessage("m1", { body: "Повний текст листа" }) })]);
    const { env } = testEnv();
    await handleUpdate(env, press("g:m1:r"));
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Повний текст листа");
    expect(readHidden(lastBotMessage("Повний текст листа"))).toEqual({ k: "mail", id: "m1" });
    await handleUpdate(env, press("g:m1:a"));
    expect(writes.map((w) => [w.path, w.body])).toEqual([
      ["/messages/m1/modify", { addLabelIds: [], removeLabelIds: ["UNREAD"] }],
      ["/messages/m1/modify", { addLabelIds: [], removeLabelIds: ["INBOX"] }],
    ]);
  });

  it("trash and labels wait for confirmation; trash is recoverable", async () => {
    await connectGoogle();
    const writes: { method: string; path: string; body: any }[] = [];
    let n = 0;
    mockFetch([
      knownPeople,
      (url) => (url.hostname === "openrouter.ai" ? llmReply(n++ === 0 ? { action: "label", label: "Бюджет" } : { action: "trash" }) : undefined),
      gmailRoutes(writes, { m1: gmailMessage("m1") }),
    ]);
    const { env, jobs } = testEnv();

    await handleUpdate(env, replyTo(mailCard("m1"), "додай мітку Бюджет"));
    await runJobs(env, jobs);
    await handleUpdate(env, press("m:y", lastBotMessage("Додати мітку")));
    expect(writes.map((w) => w.path)).toEqual(["/labels", "/messages/m1/modify"]);
    expect(writes[1]!.body).toEqual({ addLabelIds: ["Label_1"], removeLabelIds: [] });

    await handleUpdate(env, replyTo(mailCard("m1"), "видали цей лист"));
    await runJobs(env, jobs);
    await handleUpdate(env, press("m:y", lastBotMessage("Перемістити в кошик")));
    expect(writes.at(-1)!.path).toBe("/messages/m1/trash");
  });

  it("asks to reconnect Google when the grant has no Gmail access", async () => {
    await connectGoogle({ scope: "openid email https://www.googleapis.com/auth/calendar.events" });
    const calls = mockFetch([]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, text("перевір пошту"));
    expect(jobs).toEqual([]);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("дайте доступ до Gmail");
  });

  it("/mail routes explicitly, even without mail words", async () => {
    await connectGoogle();
    mockFetch([]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, text("/mail що нового?"));
    expect(jobs.map((j) => j.body.type)).toEqual(["mail"]);
  });
});

describe("instant new-mail notifications (Gmail push)", () => {
  it("the push endpoint checks its token and queues a sync", async () => {
    mockFetch([]);
    const { env, jobs } = testEnv();
    const post = (token: string) =>
      gmailPush(
        new Request(`https://bot.test/api/gmail-push?token=${token}`, {
          method: "POST",
          body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify({ emailAddress: "boss@acme.ua", historyId: 101 })).toString("base64") } }),
        }),
        env,
      );
    expect((await post("wrong")).status).toBe(403);
    expect(jobs).toEqual([]);
    expect((await post(gmailPushToken(env))).status).toBe(204);
    expect(jobs.map((j) => j.body)).toEqual([{ type: "gmail_sync" }]);
  });

  it("reports each new INBOX email once and marks it with a hidden label instead of storing anything", async () => {
    await connectGoogle();
    const writes: { method: string; path: string; body: any }[] = [];
    let query = "";
    const calls = mockFetch([
      (url) => {
        if (url.pathname.endsWith("/messages") && url.searchParams.get("q")) query = url.searchParams.get("q")!;
        return undefined;
      },
      gmailRoutes(writes, { n1: gmailMessage("n1", { subject: "Нова пропозиція" }), n2: gmailMessage("n2") }),
    ]);
    const { env } = testEnv();
    expect(await gmailSync(env)).toBe(2);
    expect(query).toBe(`in:inbox -label:${SEEN_LABEL} -from:me newer_than:1d`);
    const notices = tgCalls(calls, "sendMessage").map((m) => String(m.text));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("📨 Новий лист");
    expect(notices[0]).toContain("Нова пропозиція");
    // The hidden label is created once (hidden in Gmail) and put on each reported email.
    const created = writes.find((w) => w.path === "/labels")!;
    expect(created.body).toEqual({ name: SEEN_LABEL, labelListVisibility: "labelHide", messageListVisibility: "hide" });
    expect(writes.filter((w) => w.path.endsWith("/modify")).map((w) => w.body.addLabelIds)).toEqual([["Label_1"], ["Label_1"]]);
  });

  it("the daily job renews the Gmail watch when push is configured", async () => {
    await connectGoogle();
    let watched: any = null;
    mockFetch([
      (url, init) =>
        url.pathname.endsWith("/events/watch") ? Response.json({ id: JSON.parse(init.bodyText).id, resourceId: "r" }) : undefined,
      (url) => (url.pathname.endsWith("/channels/stop") ? new Response(null, { status: 204 }) : undefined),
      calendarList([]),
      (url, init) => {
        if (!url.pathname.endsWith("/gmail/v1/users/me/watch")) return undefined;
        watched = JSON.parse(init.bodyText);
        return Response.json({ historyId: "200", expiration: String(Date.now() + 7 * 86400_000) });
      },
    ]);
    const { env, jobs } = testEnv({ GMAIL_PUBSUB_TOPIC: "projects/p/topics/gmail" });
    jobs.push({ body: { type: "daily" } });
    await runJobs(env, jobs);
    expect(watched).toEqual({ topicName: "projects/p/topics/gmail", labelIds: ["INBOX"], labelFilterBehavior: "include" });
  });
});
