import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bitrixTools } from "../src/agent/bitrixTools";
import { routeByKeywords } from "../src/agent/route";
import { resetBitrixCache } from "../src/bitrix/client";
import { matchPeople, type Person } from "../src/bitrix/names";
import { buildTaskReport } from "../src/bitrix/report";
import { bitrixUrl } from "../src/env";
import { handleUpdate } from "../src/telegram/handler";
import type { TgUpdate } from "../src/telegram/types";
import { type LlmRequest, llmText, llmTools, mockFetch, OWNER, openRouter, resetInstance, runJobs, testEnv, tgCalls } from "./helpers";

const WEBHOOK = "https://acme.bitrix24.ua/rest/1/secret123/";

beforeEach(() => {
  resetInstance();
  resetBitrixCache();
});
afterEach(() => vi.restoreAllMocks());

const PEOPLE: Person[] = [
  { id: 1, name: "Олександр", lastName: "Коваленко", email: "owner@acme.ua" },
  { id: 7, name: "Іван", lastName: "Петренко", email: "ivan@acme.ua", position: "Менеджер з продажу" },
  { id: 8, name: "Іванна", lastName: "Петрук", email: "ivanna@acme.ua" },
  { id: 9, name: "Олена", lastName: "Коваль", email: "olena@acme.ua" },
  { id: 10, name: "Ivan", lastName: "Sydorenko", email: "sydorenko@acme.ua" },
];

describe("finding people by name", () => {
  const top = (q: string) => matchPeople(q, PEOPLE).map((m) => [m.person.id, m.full]);

  it("handles case endings, surname only, Latin/Cyrillic and email", () => {
    expect(top("Іван Петренко")[0]).toEqual([7, true]);
    expect(top("Івану Петренку")[0]).toEqual([7, true]);
    expect(top("Петренку")[0]).toEqual([7, true]);
    expect(top("Ivan Petrenko")[0]).toEqual([7, true]);
    expect(top("Сидоренко")[0]).toEqual([10, true]);
    expect(top("Олені Коваль")[0]).toEqual([9, true]);
    expect(top("ivanna@acme.ua")).toEqual([[8, true]]);
    expect(top("Марія")).toEqual([]);
  });

  it("an ambiguous first name returns several candidates for the agent to ask about", () => {
    const ids = top("Іван").map(([id]) => id);
    expect(ids).toEqual(expect.arrayContaining([7, 10]));
  });
});

/** A fake Bitrix24 portal: users, tasks, comments; records what was written. */
function bitrixRoute(writes: { method: string; body: Record<string, unknown> }[] = []) {
  const tasks = [
    {
      id: "123", title: "Звіт за вересень", status: "3", deadline: "2020-09-30T18:00:00+03:00", createdDate: "2026-09-01T10:00:00+03:00",
      createdBy: "1", responsibleId: "7", responsible: { id: "7", name: "Іван Петренко" }, creator: { id: "1", name: "Олександр Коваленко" },
      groupId: "5", stageId: "11", group: { id: "5", name: "Продажі" },
    },
    {
      id: "124", title: "Договір з постачальником", status: "2", deadline: "2099-10-03T18:00:00+03:00", createdDate: "2026-09-20T10:00:00+03:00",
      createdBy: "1", responsibleId: "9", responsible: { id: "9", name: "Олена Коваль" }, creator: { id: "1", name: "Олександр Коваленко" }, groupId: "0",
    },
  ];
  return (url: URL, init: RequestInit & { bodyText: string }) => {
    if (!url.href.startsWith(WEBHOOK)) return undefined;
    const method = url.pathname.split("/").at(-1)!.replace(/\.json$/, "");
    const body = init.bodyText ? (JSON.parse(init.bodyText) as Record<string, unknown>) : {};
    switch (method) {
      case "user.current":
        return Response.json({ result: { ID: "1", NAME: "Олександр", LAST_NAME: "Коваленко" } });
      case "user.get":
        return Response.json({ result: PEOPLE.map((p) => ({ ID: String(p.id), NAME: p.name, LAST_NAME: p.lastName, EMAIL: p.email, WORK_POSITION: p.position })) });
      case "tasks.task.list": {
        const f = body.filter as Record<string, unknown>;
        const closedOnly = JSON.stringify(f.REAL_STATUS) === '["5"]';
        return Response.json({ result: { tasks: closedOnly ? [] : tasks } });
      }
      case "task.stages.get":
        return Response.json({ result: { "11": { ID: "11", TITLE: "Узгодження" } } });
      case "batch": {
        // Old-style comments (t…), the task chat of the new card (c… → chat id, m… → its messages).
        const answers: Record<string, unknown> = {
          t123: [{ ID: "1", AUTHOR_ID: "7", AUTHOR_NAME: "Іван Петренко", POST_DATE: "2026-09-28T12:00:00+03:00", POST_MESSAGE: "[b]Чекаю[/b] цифри від бухгалтерії" }],
          t124: [],
          c124: { ID: 777 },
          m124: {
            messages: [
              { id: 2, author_id: 9, date: "2026-09-29T10:00:00+03:00", text: "Постачальник надіслав правки, узгоджую з юристом" },
              { id: 1, author_id: 0, date: "2026-09-25T09:00:00+03:00", text: "Задачу взято в роботу" },
            ],
            users: [{ id: 9, name: "Олена Коваль" }],
          },
        };
        const cmd = (body as { cmd: Record<string, string> }).cmd;
        return Response.json({ result: { result: Object.fromEntries(Object.keys(cmd).filter((k) => k in answers).map((k) => [k, answers[k]])) } });
      }
      case "im.message.add":
        writes.push({ method, body });
        return Response.json({ result: 91 });
      case "tasks.task.add":
        writes.push({ method, body });
        return Response.json({ result: { task: { id: "200", title: "x", status: "2" } } });
      case "task.commentitem.add":
        writes.push({ method, body });
        return Response.json({ result: 55 });
      default:
        writes.push({ method, body });
        return Response.json({ error: "NOT_ALLOWED", error_description: `unexpected ${method}` }, { status: 400 });
    }
  };
}

describe("Bitrix24 task agent", () => {
  it("reads, comments and creates — no tool can close, change or delete a task", () => {
    const { env } = testEnv({ BITRIX_WEBHOOK_URL: WEBHOOK });
    const names = bitrixTools(env).map((t) => t.spec.name);
    expect(names).toEqual(["find_user", "list_tasks", "get_task", "get_task_comments", "add_comment", "create_task", "find_project", "task_stats"]);
    expect(names.join(" ")).not.toMatch(/delete|close|complete|update|defer|delegate/);
  });

  it("task words go straight to the task agent when Bitrix24 is connected", () => {
    const route = (text: string, bitrix = true) => routeByKeywords({ chatId: OWNER, inputType: "text", text }, bitrix);
    expect(route("мої задачі на завтра")).toBe("bitrix_agent");
    expect(route("постав Івану задачу підготувати договір")).toBe("bitrix_agent");
    expect(route("що горить по дедлайнах?")).toBe("bitrix_agent");
    expect(route("мої задачі", false)).toBeNull();
    expect(route("що в мене завтра?")).toBe("calendar_agent");
  });

  it("«постав Івану Петренку задачу» → find_user → create_task with the right person and deadline", async () => {
    const writes: { method: string; body: Record<string, unknown> }[] = [];
    const seen: LlmRequest[] = [];
    let step = 0;
    const calls = mockFetch([
      bitrixRoute(writes),
      openRouter(() => {
        step++;
        if (step === 1) return llmTools(["find_user", { query: "Івану Петренку" }]);
        if (step === 2) return llmTools(["create_task", { title: "Підготувати договір", responsibleId: 7, deadline: "2026-10-02T18:00:00+03:00", priority: "high" }]);
        return llmText("✅ <b>Задачу створено</b>");
      }, seen),
    ]);
    const { env, jobs } = testEnv({ BITRIX_WEBHOOK_URL: WEBHOOK });
    await handleUpdate(env, { update_id: 1, message: { message_id: 1, date: 0, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "О" }, text: "постав Івану Петренку задачу підготувати договір до пʼятниці" } });
    await runJobs(env, jobs);
    expect(seen[0]!.tools!.map((t) => t.function.name)).toContain("create_task");
    expect(String(seen[0]!.messages[0]!.content)).toContain("СУВОРО ЗАБОРОНЕНО");
    // find_user answered with Ivan first
    expect(String(seen[1]!.messages.at(-1)!.content)).toMatch(/^\[\{"id":7,"name":"Іван Петренко"/);
    expect(writes).toEqual([
      { method: "tasks.task.add", body: { fields: { TITLE: "Підготувати договір", RESPONSIBLE_ID: 7, DEADLINE: "2026-10-02T18:00:00+03:00", PRIORITY: "2" } } },
    ]);
    expect(String(tgCalls(calls, "sendMessage").at(-1)!.text)).toContain("Задачу створено");
  });
});

describe("/bitrix menu and the Excel report", () => {
  const update = (text: string): TgUpdate => ({
    update_id: 2,
    message: { message_id: 2, date: 0, chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "О" }, text },
  });

  it("/bitrix shows the buttons; «Мої задачі» lists tasks in code, overdue ones marked", async () => {
    const calls = mockFetch([bitrixRoute()]);
    const { env, jobs } = testEnv({ BITRIX_WEBHOOK_URL: WEBHOOK });
    await handleUpdate(env, update("/bitrix"));
    const menu = tgCalls(calls, "sendMessage").at(-1)!;
    expect((menu.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
      "bx:my", "bx:overdue", "bx:stats", "bx:report",
    ]);
    await handleUpdate(env, { update_id: 3, callback_query: { id: "c", from: { id: OWNER, is_bot: false, first_name: "О" }, data: "bx:my" } });
    await runJobs(env, jobs);
    const text = String(tgCalls(calls, "sendMessage").at(-1)!.text);
    expect(text).toContain("📋 <b>Мої задачі</b> (2)");
    expect(text).toContain("🔥 <b>Звіт за вересень</b>");
    expect(text).toContain("(прострочено)");
    expect(text).toContain("https://acme.bitrix24.ua/company/personal/user/1/tasks/task/view/123/");
  });

  it("«📊 Excel-звіт» first asks what to export; each choice becomes the matching Bitrix24 filter", async () => {
    const lists: Record<string, unknown>[] = [];
    const route = bitrixRoute();
    const calls = mockFetch([
      (url, init) => {
        if (url.href.includes("tasks.task.list")) lists.push(JSON.parse(init.bodyText || "{}").filter ?? {});
        return route(url, init);
      },
      openRouter(() => llmText("{}")),
    ]);
    const { env, jobs } = testEnv({ BITRIX_WEBHOOK_URL: WEBHOOK });
    const press = (data: string): TgUpdate => ({ update_id: 9, callback_query: { id: "c", from: { id: OWNER, is_bot: false, first_name: "О" }, data } });
    await handleUpdate(env, press("bx:report"));
    const menu = tgCalls(calls, "sendMessage").at(-1)!;
    expect(String(menu.text)).toContain("Що вивантажити в Excel?");
    expect((menu.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
      "bx:report:all", "bx:report:open", "bx:report:overdue", "bx:report:week", "bx:report:mine", "bx:report:given", "bx:report:closed",
    ]);
    expect(jobs.length).toBe(0);

    await handleUpdate(env, press("bx:report:mine"));
    await runJobs(env, jobs);
    expect(lists.at(-1)).toMatchObject({ RESPONSIBLE_ID: 1 });
    expect(calls.some((c) => c.url.endsWith("/sendDocument"))).toBe(true);
  });

  it("the report: tasks, stage, status, state from comments (AI), people, dates; overdue highlighted", async () => {
    mockFetch([bitrixRoute(), openRouter(() => llmText(JSON.stringify({ "123": "Іван чекає цифри від бухгалтерії" })))]);
    const { env } = testEnv({ BITRIX_WEBHOOK_URL: WEBHOOK });
    const report = (await buildTaskReport(env))!;
    expect(report.filename).toMatch(/^zadachi-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(report.caption).toContain("Відкрито: <b>2</b>");
    expect(report.caption).toContain("прострочено: <b>1</b>");
    // Stored ZIP: the sheet XML is readable in the bytes.
    const text = new TextDecoder().decode(report.file);
    expect(text.startsWith("PK")).toBe(true);
    for (const s of ["Звіт за вересень", "Узгодження", "Виконується", "Іван чекає цифри від бухгалтерії", "Іван Петренко", "Олександр Коваленко", "01.09.2026", "Олена Коваль", "Аналітика"]) {
      expect(text).toContain(s);
    }
  });
});

describe("BITRIX_WEBHOOK_URL", () => {
  it("accepts the webhook base or a pasted method URL; rejects anything else", () => {
    expect(bitrixUrl("https://acme.bitrix24.ua/rest/1/abc/")).toBe("https://acme.bitrix24.ua/rest/1/abc/");
    expect(bitrixUrl("https://acme.bitrix24.ua/rest/1/abc/profile.json")).toBe("https://acme.bitrix24.ua/rest/1/abc/");
    expect(bitrixUrl("")).toBe("");
    expect(() => bitrixUrl("acme.bitrix24.ua")).toThrow();
  });
});

describe("the task chat («Чат завдання») of new Bitrix24 task cards", () => {
  it("get_task_comments reads the task chat (people and system status messages) together with old comments, oldest first", async () => {
    mockFetch([bitrixRoute()]);
    const { env } = testEnv({ BITRIX_WEBHOOK_URL: WEBHOOK });
    const tool = bitrixTools(env).find((t) => t.spec.name === "get_task_comments")!;
    const out = (await tool.run({ taskId: 124 })) as { author: string; text: string }[];
    expect(out).toEqual([
      expect.objectContaining({ author: "Система", text: "Задачу взято в роботу" }),
      expect.objectContaining({ author: "Олена Коваль", text: "Постачальник надіслав правки, узгоджую з юристом" }),
    ]);
  });

  it("a comment goes into the task chat when the task has one, else as an old-style comment", async () => {
    const writes: { method: string; body: Record<string, unknown> }[] = [];
    mockFetch([bitrixRoute(writes)]);
    const { env } = testEnv({ BITRIX_WEBHOOK_URL: WEBHOOK });
    const tool = bitrixTools(env).find((t) => t.spec.name === "add_comment")!;
    await tool.run({ taskId: 124, text: "Документи надіслано" });
    await tool.run({ taskId: 123, text: "Цифри будуть завтра" });
    expect(writes).toEqual([
      { method: "im.message.add", body: { DIALOG_ID: "chat777", MESSAGE: "Документи надіслано" } },
      { method: "task.commentitem.add", body: { TASKID: 123, FIELDS: { POST_MESSAGE: "Цифри будуть завтра" } } },
    ]);
  });
});
