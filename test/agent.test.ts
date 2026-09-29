import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAttendees } from "../src/agent/calendarTools";
import { gmailTools } from "../src/agent/gmailTools";
import { toTelegramHtml } from "../src/agent/html";
import { ModelError, runAgent, type Tool } from "../src/agent/runner";
import { newMailNotice } from "../src/google/gmailPush";
import { fromBase64Url } from "../src/lib/crypto";
import { connectGoogle, type LlmRequest, llmText, llmTools, mockFetch, openRouter, resetInstance, testEnv } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

describe("Parse Agent Output (toTelegramHtml)", () => {
  it("unwraps fences and {response}, turns Markdown into HTML, drops unknown tags, closes open ones, escapes &", () => {
    expect(toTelegramHtml("```html\n<b>Привіт</b>\n```")).toBe("<b>Привіт</b>");
    expect(toTelegramHtml('{"response":"<i>ок</i>"}')).toBe("<i>ок</i>");
    expect(toTelegramHtml("**Важливо** [лінк](https://x.ua)")).toBe('<b>Важливо</b> <a href="https://x.ua">лінк</a>');
    expect(toTelegramHtml("<p>Абзац</p><br><b>жирний")).toBe("Абзац<b>жирний</b>");
    expect(toTelegramHtml("A & B &amp; C, 1 < 2")).toBe("A &amp; B &amp; C, 1 &lt; 2");
    expect(toTelegramHtml("")).toBe("🙂");
  });

  it("cuts to Telegram's limit without leaving a tag open", () => {
    const out = toTelegramHtml(`<b>${"я".repeat(5000)}</b>`);
    expect(out.length).toBeLessThan(4100);
    expect(out.endsWith("</b>")).toBe(true);
  });
});

describe("agent loop", () => {
  it("runs tools until the model answers; a failing tool's error goes back to the model", async () => {
    const seen: LlmRequest[] = [];
    mockFetch([openRouter((_req, n) => (n === 1 ? llmTools(["boom", {}], ["echo", { v: 1 }]) : llmText("готово")), seen)]);
    const { env } = testEnv();
    const tools: Tool[] = [
      { spec: { name: "boom", description: "", parameters: {} }, run: async () => Promise.reject(new Error("нема")) },
      { spec: { name: "echo", description: "", parameters: {} }, run: async (a) => a },
    ];
    const out = await runAgent(env, { model: "m", system: "s", history: [], input: "hi", tools, maxIterations: 5 });
    expect(out).toBe("готово");
    expect(seen[1]!.messages.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "call0", content: '{"error":"нема"}' },
      { role: "tool", tool_call_id: "call1", content: '{"v":1}' },
    ]);
  });

  it("stops after maxIterations", async () => {
    const seen: LlmRequest[] = [];
    mockFetch([openRouter(() => llmTools(["echo", {}]), seen)]);
    const { env } = testEnv();
    const echo: Tool = { spec: { name: "echo", description: "", parameters: {} }, run: async () => "ok" };
    await expect(runAgent(env, { model: "m", system: "s", history: [], input: "hi", tools: [echo], maxIterations: 3 })).rejects.toBeInstanceOf(
      ModelError,
    );
    expect(seen).toHaveLength(3);
  });
});

describe("calendar tools", () => {
  it("parseAttendees reads n8n's attendeesJson, arrays and plain lists", () => {
    expect(parseAttendees('{"email":"a@x.ua"},{"email":"b@y.ua"}')).toEqual([{ email: "a@x.ua" }, { email: "b@y.ua" }]);
    expect(parseAttendees(["a@x.ua", { email: "b@y.ua" }])).toEqual([{ email: "a@x.ua" }, { email: "b@y.ua" }]);
    expect(parseAttendees("a@x.ua, b@y.ua")).toEqual([{ email: "a@x.ua" }, { email: "b@y.ua" }]);
    expect(parseAttendees("")).toEqual([]);
  });
});

describe("gmail tools", () => {
  it("msg_get_many turns ReadStatus into the Gmail query; msg_send builds the email with CC", async () => {
    await connectGoogle();
    const queries: string[] = [];
    let sent = "";
    mockFetch([
      (url, init) => {
        if (url.hostname !== "gmail.googleapis.com") return undefined;
        if (url.pathname.endsWith("/messages")) {
          queries.push(url.searchParams.get("q")!);
          return Response.json({ messages: [] });
        }
        if (url.pathname.endsWith("/messages/send")) {
          sent = Buffer.from(fromBase64Url(JSON.parse(init.bodyText).raw)).toString("utf8");
          return Response.json({ id: "m1", threadId: "t1" });
        }
        return undefined;
      },
    ]);
    const { env } = testEnv();
    const tools = new Map(gmailTools(env).map((t) => [t.spec.name, t]));
    await tools.get("msg_get_many")!.run({ SearchQuery: "", ReadStatus: "unread" });
    await tools.get("msg_get_many")!.run({ SearchQuery: "from:anna", ReadStatus: "both" });
    expect(queries).toEqual(["is:unread", "from:anna"]);
    await tools.get("msg_send")!.run({ To: "anna@x.ua", Subject: "Звіт", Message: "Привіт", CC: "b@y.ua", BCC: "" });
    expect(sent).toContain("To: anna@x.ua");
    expect(sent).toContain("Cc: b@y.ua");
    expect(sent).not.toContain("Bcc:");
  });
});

describe("new-mail notice (n8n WF3 «Формат»)", () => {
  it("📧 Нова пошта! with sender, subject, recipient, Kyiv time, snippet and the Gmail link", () => {
    const text = newMailNotice({
      id: "18f0a",
      threadId: "t",
      internalDate: String(Date.parse("2026-09-29T07:05:00Z")),
      snippet: "Надсилаю <b>звіт</b> & план",
      payload: {
        headers: [
          { name: "From", value: "Анна <anna@partner.ua>" },
          { name: "To", value: "me@acme.ua" },
          { name: "Subject", value: "Звіт" },
        ],
      },
    } as never);
    expect(text).toBe(
      [
        "📧 <b>Нова пошта!</b>",
        "",
        "📩 <b>Від:</b> Анна &lt;anna@partner.ua&gt;",
        "📌 <b>Тема:</b> Звіт",
        "📨 <b>Кому:</b> me@acme.ua",
        "🕐 29.09.2026, 10:05",
        "",
        "Надсилаю звіт &amp; план",
        "",
        '🔗 <a href="https://mail.google.com/mail/u/0/#inbox/18f0a">Відкрити в Gmail</a>',
      ].join("\n"),
    );
  });
});

