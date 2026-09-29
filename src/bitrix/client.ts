import type { Env } from "../env";
import { fetchWithRetry, HttpError } from "../lib/http";
import { fullName, matchPeople, type Match, type Person } from "./names";

/**
 * Bitrix24 REST through the owner's incoming webhook (BITRIX_WEBHOOK_URL, rights: Tasks and Users). The webhook acts
 * as the owner. Tasks only: read tasks and comments, add comments, create tasks. Nothing here can close, change or
 * delete an existing task — those methods are deliberately not wrapped.
 */

/** A task as Bitrix24 returns it (tasks.task.list / get, camelCase). */
export interface BxTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  subStatus?: string;
  priority?: string;
  deadline?: string | null;
  createdDate?: string;
  changedDate?: string;
  closedDate?: string | null;
  createdBy?: string;
  responsibleId?: string;
  accomplices?: string[];
  auditors?: string[];
  groupId?: string;
  stageId?: string;
  creator?: { id: string; name: string };
  responsible?: { id: string; name: string };
  group?: { id: string; name: string } | [];
}

export interface BxComment {
  id: string;
  authorId: string;
  authorName: string;
  date: string;
  text: string;
}

/** Bitrix24 task statuses. */
export const STATUS: Record<string, string> = {
  "1": "Нова",
  "2": "Чекає виконання",
  "3": "Виконується",
  "4": "Чекає контролю",
  "5": "Завершена",
  "6": "Відкладена",
  "7": "Відхилена",
};
export const CLOSED = new Set(["5", "7"]);

const TASK_FIELDS = [
  "ID", "TITLE", "DESCRIPTION", "STATUS", "SUB_STATUS", "PRIORITY", "DEADLINE", "CREATED_DATE", "CHANGED_DATE", "CLOSED_DATE",
  "CREATED_BY", "RESPONSIBLE_ID", "ACCOMPLICES", "AUDITORS", "GROUP_ID", "STAGE_ID",
];

/** BBCode and HTML out of a comment or description. */
export function plainText(text: string | undefined): string {
  return (text ?? "")
    .replace(/\[(\/?)(b|i|u|s|url|user|quote|code|list|\*|color|size|font|img|disk file id)[^\]]*\]/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

let peopleCache: { at: number; list: Person[] } | null = null;
let meCache: Person | null = null;
const stagesCache = new Map<string, Record<string, string>>();

export function resetBitrixCache(): void {
  peopleCache = null;
  meCache = null;
  stagesCache.clear();
}

export class Bitrix {
  constructor(private readonly env: Pick<Env, "BITRIX_WEBHOOK_URL">) {}

  /** https://<portal> */
  get portal(): string {
    return new URL(this.env.BITRIX_WEBHOOK_URL).origin;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<{ result: T; next?: number; total?: number }> {
    const res = await fetchWithRetry(`${this.env.BITRIX_WEBHOOK_URL}${method}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const body = (await res.json().catch(() => null)) as { result?: T; next?: number; total?: number; error?: string; error_description?: string } | null;
    if (!res.ok || !body || body.error) {
      throw new HttpError(`bitrix ${method}`, res.status, body?.error_description || body?.error || "no answer");
    }
    return { result: body.result as T, next: body.next, total: body.total };
  }

  /** Several calls in one request (Bitrix24 `batch`, up to 50): keeps a report under the portal's rate limit. */
  async batch<T>(commands: Record<string, string>): Promise<Record<string, T>> {
    const out: Record<string, T> = {};
    const keys = Object.keys(commands);
    for (let i = 0; i < keys.length; i += 50) {
      const cmd = Object.fromEntries(keys.slice(i, i + 50).map((k) => [k, commands[k]!]));
      const { result } = await this.call<{ result: Record<string, T> }>("batch", { halt: 0, cmd });
      Object.assign(out, result.result ?? {});
    }
    return out;
  }

  /** The owner (whose webhook this is). */
  async me(): Promise<Person> {
    if (meCache) return meCache;
    const { result } = await this.call<Record<string, string>>("user.current");
    meCache = toPerson(result);
    return meCache;
  }

  /** Active colleagues, cached for 10 minutes in the running instance. */
  async people(): Promise<Person[]> {
    if (peopleCache && Date.now() - peopleCache.at < 10 * 60_000) return peopleCache.list;
    const list: Person[] = [];
    let start = 0;
    for (let page = 0; page < 40; page++) {
      const { result, next } = await this.call<Record<string, string>[]>("user.get", { FILTER: { ACTIVE: true }, start });
      list.push(...result.map(toPerson));
      if (!next) break;
      start = next;
    }
    peopleCache = { at: Date.now(), list };
    return list;
  }

  async findPeople(query: string): Promise<Match[]> {
    return matchPeople(query, await this.people());
  }

  async personName(id: string | number | undefined): Promise<string> {
    if (!id) return "";
    const p = (await this.people()).find((x) => String(x.id) === String(id));
    return p ? fullName(p) : `#${id}`;
  }

  /** Tasks by a Bitrix24 filter (tasks.task.list), up to `limit`. */
  async tasks(filter: Record<string, unknown>, limit = 50, order: Record<string, string> = { DEADLINE: "asc" }): Promise<BxTask[]> {
    const out: BxTask[] = [];
    let start = 0;
    while (out.length < limit) {
      const { result, next } = await this.call<{ tasks: BxTask[] }>("tasks.task.list", { filter, select: TASK_FIELDS, order, start });
      out.push(...(result.tasks ?? []));
      if (!next) break;
      start = next;
    }
    return out.slice(0, limit);
  }

  async task(id: string | number): Promise<BxTask> {
    const { result } = await this.call<{ task: BxTask }>("tasks.task.get", { taskId: Number(id), select: TASK_FIELDS });
    return result.task;
  }

  /**
   * The task's whole discussion, oldest first: the «Чат завдання» of new Bitrix24 task cards (im chat of the task,
   * where status changes are posted too) plus old-style comments. Needs the webhook's «Чат і повідомлення» (im)
   * right for the chat; without it only old comments are read.
   */
  async comments(id: string | number): Promise<BxComment[]> {
    return (await this.commentsOf([String(id)]))[String(id)] ?? [];
  }

  /** Discussions of many tasks at once (batch requests of up to 50 calls). */
  async commentsOf(ids: string[]): Promise<Record<string, BxComment[]>> {
    if (!ids.length) return {};
    const old = await this.batch<Record<string, string>[]>(
      Object.fromEntries(ids.map((id) => [`t${id}`, `task.commentitem.getlist?TASKID=${encodeURIComponent(id)}&ORDER[POST_DATE]=asc`])),
    ).catch(() => ({}) as Record<string, Record<string, string>[]>);
    const chats = await this.chatIds(ids);
    const chatMessages = await this.chatMessagesOf(chats);
    return Object.fromEntries(
      ids.map((id) => {
        const all = [...(old[`t${id}`] ?? []).map(toComment), ...(chatMessages[id] ?? [])];
        return [id, all.sort((a, b) => Date.parse(a.date) - Date.parse(b.date))];
      }),
    );
  }

  /** The chat of each task (new task cards have one), via im.chat.get by entity. */
  async chatIds(ids: string[]): Promise<Record<string, string>> {
    const raw = await this.batch<{ ID?: string | number } | string | number | null>(
      Object.fromEntries(ids.map((id) => [`c${id}`, `im.chat.get?ENTITY_TYPE=TASKS_TASK&ENTITY_ID=${encodeURIComponent(id)}`])),
    ).catch(() => ({}) as Record<string, null>);
    const out: Record<string, string> = {};
    for (const id of ids) {
      const r = raw[`c${id}`];
      const chat = typeof r === "object" && r ? r.ID : r;
      if (chat) out[id] = String(chat);
    }
    // Second way: the chat id as a field of the task.
    const missing = ids.filter((id) => !out[id]);
    if (missing.length) {
      const tasks = await this.batch<{ task?: { chatId?: string | number } }>(
        Object.fromEntries(missing.map((id) => [`g${id}`, `tasks.task.get?taskId=${encodeURIComponent(id)}&select[]=ID&select[]=CHAT_ID`])),
      ).catch(() => ({}) as Record<string, { task?: { chatId?: string | number } }>);
      for (const id of missing) {
        const chat = tasks[`g${id}`]?.task?.chatId;
        if (chat && String(chat) !== "0") out[id] = String(chat);
      }
    }
    return out;
  }

  private async chatMessagesOf(chats: Record<string, string>): Promise<Record<string, BxComment[]>> {
    const tasks = Object.keys(chats);
    if (!tasks.length) return {};
    type Page = { messages?: Record<string, unknown>[]; users?: { id: number | string; name?: string }[] };
    const raw = await this.batch<Page>(
      Object.fromEntries(tasks.map((t) => [`m${t}`, `im.dialog.messages.get?DIALOG_ID=chat${chats[t]}&LIMIT=50`])),
    ).catch(() => ({}) as Record<string, Page>);
    const out: Record<string, BxComment[]> = {};
    for (const t of tasks) {
      const page = raw[`m${t}`];
      const names = new Map((page?.users ?? []).map((u) => [String(u.id), u.name ?? ""]));
      out[t] = (page?.messages ?? [])
        .map((m) => {
          const author = String(m.author_id ?? m.AUTHOR_ID ?? "0");
          return {
            id: `chat${m.id}`,
            authorId: author,
            authorName: author === "0" ? "Система" : names.get(author) || `#${author}`,
            date: String(m.date ?? ""),
            text: plainText(String(m.text ?? "")),
          };
        })
        .filter((c) => c.text);
    }
    return out;
  }

  /** Writes into the task's chat when it has one (new task cards), else as an old-style comment. */
  async addComment(id: string | number, text: string): Promise<number> {
    const chat = (await this.chatIds([String(id)]))[String(id)];
    if (chat) {
      const { result } = await this.call<number>("im.message.add", { DIALOG_ID: `chat${chat}`, MESSAGE: text });
      return result;
    }
    const { result } = await this.call<number>("task.commentitem.add", { TASKID: Number(id), FIELDS: { POST_MESSAGE: text } });
    return result;
  }

  async createTask(fields: Record<string, unknown>): Promise<BxTask> {
    const { result } = await this.call<{ task: BxTask }>("tasks.task.add", { fields });
    return result.task;
  }

  /** Names of the Kanban stages of a project ("0" = the owner's "My plan"). */
  async stageNames(groupId: string | undefined): Promise<Record<string, string>> {
    const key = groupId && groupId !== "0" ? groupId : "0";
    const cached = stagesCache.get(key);
    if (cached) return cached;
    const names: Record<string, string> = {};
    try {
      const { result } = await this.call<Record<string, { ID: string; TITLE: string }>>("task.stages.get", { entityId: Number(key) });
      for (const s of Object.values(result ?? {})) names[String(s.ID)] = s.TITLE;
    } catch {
      /* no access to that project's stages */
    }
    stagesCache.set(key, names);
    return names;
  }

  async projects(query: string): Promise<{ id: string; name: string }[]> {
    const { result } = await this.call<{ ID: string; NAME: string }[]>("sonet_group.get", { FILTER: { "%NAME": query } });
    return (result ?? []).map((g) => ({ id: String(g.ID), name: g.NAME }));
  }

  taskUrl(id: string | number, me: Person): string {
    return `${this.portal}/company/personal/user/${me.id}/tasks/task/view/${id}/`;
  }
}

function toPerson(u: Record<string, unknown>): Person {
  return {
    id: Number(u.ID),
    name: String(u.NAME ?? ""),
    lastName: String(u.LAST_NAME ?? ""),
    secondName: u.SECOND_NAME ? String(u.SECOND_NAME) : undefined,
    email: u.EMAIL ? String(u.EMAIL) : undefined,
    position: u.WORK_POSITION ? String(u.WORK_POSITION) : undefined,
  };
}

function toComment(c: Record<string, string>): BxComment {
  return { id: String(c.ID), authorId: String(c.AUTHOR_ID), authorName: c.AUTHOR_NAME ?? "", date: c.POST_DATE ?? "", text: plainText(c.POST_MESSAGE) };
}
