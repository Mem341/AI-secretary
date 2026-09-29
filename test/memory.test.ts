import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMemory } from "../src/agent/memory";
import { resetDriveCache } from "../src/google/drive";
import { resetGoogleCache, saveOwnerSettings } from "../src/google/oauth";
import { handleUpdate } from "../src/telegram/handler";
import type { TgMessage, TgUpdate } from "../src/telegram/types";
import { connectGoogle, GMAIL_SCOPE, type LlmRequest, lastBotMessage, llmText, llmTools, mockFetch, OWNER, openRouter, resetInstance, runJobs, testEnv, tgCalls } from "./helpers";

const DRIVE_SCOPE = `${GMAIL_SCOPE} https://www.googleapis.com/auth/drive.appdata`;

/** A fake appDataFolder that survives "restarts" of the bot (like the real Drive). */
function fakeDrive() {
  const files = new Map<string, { name: string; body: string }>();
  let next = 1;
  const route = (url: URL, init: RequestInit & { bodyText: string }) => {
    if (url.hostname !== "www.googleapis.com" || !url.pathname.includes("/drive/v3/files")) return undefined;
    const method = init.method ?? "GET";
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const name = /name = '([^']+)'/.exec(url.searchParams.get("q") ?? "")?.[1];
      return Response.json({ files: [...files].filter(([, f]) => f.name === name).map(([id]) => ({ id })) });
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const parts = init.bodyText.split(/--ais\d+/).map((p) => p.split("\r\n\r\n")[1]?.trim()).filter(Boolean);
      const id = `f${next++}`;
      files.set(id, { name: JSON.parse(parts[0]!).name, body: parts[1]! });
      return Response.json({ id });
    }
    const id = url.pathname.split("/").at(-1)!;
    if (method === "PATCH") {
      files.set(id, { ...files.get(id)!, body: init.bodyText });
      return Response.json({ id });
    }
    return files.has(id) ? new Response(files.get(id)!.body) : Response.json({}, { status: 404 });
  };
  return { files, route, json: () => JSON.parse([...files.values()][0]!.body) };
}

/** A cold start: everything the running instance remembered is gone (Drive is not). */
function restart() {
  resetMemory();
  resetGoogleCache();
  resetDriveCache();
}

beforeEach(() => resetInstance());
afterEach(() => vi.restoreAllMocks());

let n = 1;
const from = { id: OWNER, is_bot: false, first_name: "О" };
const say = (t: string): TgUpdate => ({ update_id: n++, message: { message_id: 300 + n, date: 0, chat: { id: OWNER, type: "private" }, from, text: t } });
const press = (data: string, message: TgMessage): TgUpdate => ({ update_id: n++, callback_query: { id: `c${n}`, from, data, message } });

describe("conversation memory in the hidden Drive folder", () => {
  it("survives a restart of the bot", async () => {
    await connectGoogle({ scope: DRIVE_SCOPE });
    const drive = fakeDrive();
    const seen: LlmRequest[] = [];
    mockFetch([drive.route, openRouter((_r, i) => llmText(i === 1 ? "Привіт! Чим допомогти?" : "Завжди радий допомогти!"), seen)]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, say("привіт"));
    await runJobs(env, jobs);
    expect(drive.files.size).toBe(1);

    restart();
    await handleUpdate(env, say("дякую"));
    await runJobs(env, jobs);
    expect(seen[1]!.messages.map((m) => m.content)).toContain("Привіт! Чим допомогти?");
  });

  it("keeps the last N question–answer pairs the owner chose; the oldest drop out", async () => {
    await connectGoogle({ scope: DRIVE_SCOPE });
    const drive = fakeDrive();
    mockFetch([drive.route, openRouter(() => llmText("ok"))]);
    const { env, jobs } = testEnv();
    await saveOwnerSettings(env, { m: 20 });
    for (let i = 1; i <= 22; i++) {
      await handleUpdate(env, say(`повідомлення ${i}`));
      await runJobs(env, jobs);
    }
    // 20 pairs = 40 messages: the 21st and 22nd pushed out the first two.
    const log = drive.json().log as { who: string; text: string }[];
    expect(log).toHaveLength(40);
    expect(log[0]).toMatchObject({ who: "u", text: "повідомлення 3" });
    expect(log.at(-2)).toMatchObject({ who: "u", text: "повідомлення 22" });
  });

  it("facts the agent writes stay after /reset and go into the next prompt", async () => {
    await connectGoogle({ scope: DRIVE_SCOPE });
    const drive = fakeDrive();
    const seen: LlmRequest[] = [];
    let step = 0;
    mockFetch([
      drive.route,
      openRouter(() => (++step === 1 ? llmTools(["remember_fact", { fact: "Іван Петренко — ivan@acme.ua, менеджер з продажу" }]) : llmText("Запамʼятав")), seen),
    ]);
    const { env, jobs } = testEnv();
    await handleUpdate(env, say("запамʼятай: Іван Петренко — ivan@acme.ua"));
    await runJobs(env, jobs);
    expect(drive.json().facts).toEqual(["Іван Петренко — ivan@acme.ua, менеджер з продажу"]);

    restart();
    await handleUpdate(env, say("/reset"));
    expect(drive.json().log).toEqual([]);
    await handleUpdate(env, say("привіт"));
    await runJobs(env, jobs);
    expect(String(seen.at(-1)!.messages[0]!.content)).toContain("Іван Петренко — ivan@acme.ua");
  });

  it("/settings → 🧠 explains how memory works; sizes and clearing are buttons", async () => {
    await connectGoogle({ scope: DRIVE_SCOPE });
    const drive = fakeDrive();
    const calls = mockFetch([drive.route]);
    const { env } = testEnv();
    await handleUpdate(env, say("/settings"));
    const msg = lastBotMessage("Налаштування");
    await handleUpdate(env, press("set:mem", msg));
    const view = tgCalls(calls, "editMessageText").at(-1)!;
    expect(String(view.text)).toContain("Як це працює");
    expect(String(view.text)).toContain("останні <b>100</b> питань-відповідей");
    expect(String(view.text)).toContain("Google Drive");
    expect(String(view.text)).not.toContain("тимчасова");
    const buttons = (view.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard.flat().map((b) => b.callback_data);
    expect(buttons).toEqual(["set:mem:20", "set:mem:50", "set:mem:100", "set:mem:facts", "set:mem:clear", "set:back"]);
    await handleUpdate(env, press("set:mem:50", msg));
    expect(String(tgCalls(calls, "editMessageText").at(-1)!.text)).toContain("останні <b>50</b> питань-відповідей");
  });

  it("without the Drive permission the memory is temporary, and the section says how to fix it", async () => {
    await connectGoogle();
    const calls = mockFetch([]);
    const { env } = testEnv();
    await handleUpdate(env, say("/settings"));
    await handleUpdate(env, press("set:mem", lastBotMessage("Налаштування")));
    expect(String(tgCalls(calls, "editMessageText").at(-1)!.text)).toContain("Перепідключіть Google");
  });
});

describe("old requests in the memory are never carried out again", () => {
  it("«видали всі зустрічі» said earlier + «йому» now → nothing is deleted", async () => {
    await connectGoogle({ scope: DRIVE_SCOPE });
    const drive = fakeDrive();
    let deletes = 0;
    const toolResults: string[] = [];
    let step = 0;
    mockFetch([
      drive.route,
      (url, init) => {
        if (url.hostname !== "www.googleapis.com" || !url.pathname.startsWith("/calendar/")) return undefined;
        if (init.method === "DELETE") {
          deletes++;
          return new Response(null, { status: 204 });
        }
        return Response.json({ id: "ev1", items: [] });
      },
      openRouter((req) => {
        const last = req.messages.at(-1)!;
        if (last.role === "tool") {
          toolResults.push(String(last.content));
          return llmText("Кому саме написати?");
        }
        step++;
        // A confused model tries to act on the old request.
        return step === 1 ? llmTools(["calendar_agent", { prompt: "йому" }]) : llmTools(["delete_event", { eventId: "ev1" }]);
      }),
    ]);
    const { env, jobs } = testEnv();
    // Earlier in the conversation:
    const { loadMemory, rememberTurn, saveMemory } = await import("../src/agent/memory");
    await loadMemory(env);
    await rememberTurn(env, "удали все встречи на сегодня", "Видалив 2 зустрічі.");
    await saveMemory(env);

    await handleUpdate(env, say("йому"));
    await runJobs(env, jobs);
    expect(deletes).toBe(0);
    expect(toolResults.some((r) => r.includes("does not ask to delete"))).toBe(true);
  });

  it("the deletion rule: this message must ask; several or «all» only after «так»", async () => {
    const { deletionAllowed } = await import("../src/agent/calendarTools");
    expect(deletionAllowed("йому", 0)).toMatch(/does not ask/);
    expect(deletionAllowed("видали стендап", 0)).toBeNull();
    expect(deletionAllowed("видали стендап", 1)).toMatch(/confirmation/);
    expect(deletionAllowed("удали все встречи на сегодня", 0)).toMatch(/confirmation/);
    expect(deletionAllowed("так", 0)).toBeNull();
    expect(deletionAllowed("так", 3)).toBeNull();
  });
});

describe("one session: the bot's question gets the owner's answer", () => {
  it("«Заголовок ТЕСТ» after the task agent asked for a title goes back to that agent, with the conversation", async () => {
    await connectGoogle();
    const seen: LlmRequest[] = [];
    mockFetch([
      (url) => (url.hostname === "b24.test" ? Response.json({ result: {} }) : undefined),
      openRouter((_r, i) => llmText(i === 1 ? "Щоб створити задачу, мені потрібна назва. Яка назва?" : "Задачу «ТЕСТ» створено."), seen),
    ]);
    const { env, jobs } = testEnv({ BITRIX_WEBHOOK_URL: "https://b24.test/rest/1/abc/" });
    await handleUpdate(env, say("постав задачу Вероніці, дедлайн післязавтра"));
    await runJobs(env, jobs);
    await handleUpdate(env, say("Заголовок ТЕСТ"));
    await runJobs(env, jobs);
    const second = seen[1]!;
    expect(String(second.messages[0]!.content)).toContain("# Bitrix24 Task Agent");
    expect(second.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(String(second.messages[1]!.content)).toContain("постав задачу Вероніці");
    expect(second.messages[2]!.content).toContain("Яка назва?");
    expect(lastBotMessage("ТЕСТ").text).toContain("створено");
  });
});

describe("the answer to the task agent's question stays with it", () => {
  it("«ТЕСТ … Вероника бутенко … послезавтра … спостерігач» is not a calendar request", async () => {
    const { routeFollowUp } = await import("../src/agent/route");
    const input = (text: string) => ({ chatId: OWNER, inputType: "text" as const, text });
    const answer = "ТЕСТ ТЕСТОВИЧ\nВероника бутенко\nпослезавтра\nя буду как спостеригатель\nприоритет нормальный";
    expect(routeFollowUp(input(answer), "bitrix_agent", true)).toBe("bitrix_agent");
    // A plainly new request of another kind still goes there.
    expect(routeFollowUp(input("створи зустріч з Іваном завтра о 10"), "bitrix_agent", true)).toBe("calendar_agent");
    expect(routeFollowUp(input("так"), "calendar_agent", true)).toBe("calendar_agent");
  });

  it("«Надішліть ці дані» counts as the bot waiting for an answer", async () => {
    const { loadMemory, rememberTurn, pendingAgent } = await import("../src/agent/memory");
    const { env } = testEnv();
    mockFetch([]);
    await loadMemory(env);
    await rememberTurn(env, "Надо новую задачу поставить", "Уточніть: назва, відповідальний, дедлайн. Надішліть ці дані, і я підготую превʼю.", Date.now(), "bitrix_agent");
    expect(pendingAgent()).toBe("bitrix_agent");
  });
});

describe("/settings → «📧 Нова пошта в бот»", () => {
  it("off: new emails are not sent to the chat, but they are still marked as read by the bot", async () => {
    await connectGoogle({ scope: GMAIL_SCOPE });
    let marked = 0;
    const calls = mockFetch([
      (url, init) => {
        if (url.hostname !== "gmail.googleapis.com") return undefined;
        if (url.pathname.endsWith("/labels")) return Response.json({ labels: [{ id: "L", name: "AI-secretary-seen" }] });
        if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m9" }] });
        if (url.pathname.endsWith("/modify")) {
          marked++;
          return Response.json({});
        }
        return Response.json({ id: "m9", threadId: "t", snippet: "Привіт", payload: { headers: [{ name: "From", value: "Анна <ann@x.ua>" }, { name: "Subject", value: "Договір" }] } });
      },
    ]);
    const { env } = testEnv();
    const { saveOwnerSettings } = await import("../src/google/oauth");
    const { gmailSync } = await import("../src/google/gmailPush");
    await saveOwnerSettings(env, { ml: false });
    expect(await gmailSync(env)).toBe(0);
    expect(marked).toBe(1);
    expect(tgCalls(calls, "sendMessage").some((m) => String(m.text).includes("Нова пошта"))).toBe(false);
  });
});
