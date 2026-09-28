import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronHandler, eventToRequest, type FunctionUrlEvent, handleHttp } from "../src/aws";
import { loadConfig } from "../src/env";
import { mockFetch, OWNER, resetInstance, tgCalls } from "./helpers";

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

const HOST = "abc123.lambda-url.eu-central-1.on.aws";
const source = {
  OWNER_TELEGRAM_ID: String(OWNER),
  TELEGRAM_BOT_TOKEN: "111:AAA",
  OPENROUTER_API_KEY: "or",
};

function event(method: string, path: string, over: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  return { rawPath: path, rawQueryString: "", headers: {}, requestContext: { domainName: HOST, http: { method } }, ...over };
}

describe("Lambda event → Request", () => {
  it("rebuilds URL, method, headers, cookies and a base64 body", async () => {
    const req = eventToRequest({
      rawPath: "/api/telegram",
      rawQueryString: "a=1&b=2",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s" },
      cookies: ["k=v", "x=y"],
      body: Buffer.from('{"ok":true}').toString("base64"),
      isBase64Encoded: true,
      requestContext: { domainName: HOST, http: { method: "POST" } },
    });
    expect(req.url).toBe(`https://${HOST}/api/telegram?a=1&b=2`);
    expect(req.method).toBe("POST");
    expect(req.headers.get("x-telegram-bot-api-secret-token")).toBe("s");
    expect(req.headers.get("cookie")).toBe("k=v; x=y");
    expect(await req.json()).toEqual({ ok: true });
  });

  it("ignores a body on GET", () => {
    expect(eventToRequest({ rawPath: "/", body: "x", requestContext: { http: { method: "GET" } } }).body).toBeNull();
  });
});

describe("AWS handler", () => {
  it("serves the setup page explaining missing variables", async () => {
    const { response } = await handleHttp(event("GET", "/api/setup"), { ...source, OPENROUTER_API_KEY: "" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("OPENROUTER_API_KEY");
  });

  it("uses the Function URL as PUBLIC_URL; the cron gets it from the stack", async () => {
    mockFetch([
      (url) => (url.pathname.endsWith("/getWebhookInfo") ? Response.json({ ok: true, result: { url: `https://${HOST}/api/telegram` } }) : undefined),
    ]);
    const { response } = await handleHttp(event("GET", "/api/health"), source);
    const body = (await response.json()) as { public_url: string; telegram_webhook: unknown };
    expect(body.public_url).toBe(`https://${HOST}`);
    expect(body.telegram_webhook).toBe(true);

    // The cron has no request: aws/template.yaml passes the Function URL as PUBLIC_URL.
    const { statusCode } = await cronHandler(undefined, { ...source, PUBLIC_URL: `https://${HOST}/` });
    expect(statusCode).toBe(200);
  });

  it("answers the Telegram webhook at once and finishes the update in the background", async () => {
    const calls = mockFetch([]);
    const secret = loadConfig(source, `https://${HOST}`).TELEGRAM_WEBHOOK_SECRET;
    const update = {
      update_id: 1,
      message: { message_id: 1, date: 0, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "O" }, text: "/start" },
    };
    const { response, background } = await handleHttp(
      event("POST", "/api/telegram", { headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update) }),
      source,
    );
    expect(response.status).toBe(200);
    await background;
    expect(String(tgCalls(calls, "sendMessage")[0]!.text)).toContain("Вітаю");
  });

  it("routes: root redirects to the setup page, unknown paths 404, wrong method 405", async () => {
    mockFetch([]);
    const root = (await handleHttp(event("GET", "/"), source)).response;
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe(`https://${HOST}/api/setup`);
    expect((await handleHttp(event("GET", "/nope"), source)).response.status).toBe(404);
    expect((await handleHttp(event("GET", "/api/telegram"), source)).response.status).toBe(405);
  });
});
