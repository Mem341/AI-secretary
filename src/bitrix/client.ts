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

  async comments(id: string | number): Promise<BxComment[]> {
    const { result } = await this.call<Record<string, string>[]>("task.commentitem.getlist", { TASKID: Number(id), ORDER: { POST_DATE: "asc" } });
    return (result ?? []).map(toComment);
  }

  /** Comments of many tasks at once (one batch request per 50 tasks). */
  async commentsOf(ids: string[]): Promise<Record<string, BxComment[]>> {
    const raw = await this.batch<Record<string, string>[]>(
      Object.fromEntries(ids.map((id) => [`t${id}`, `task.commentitem.getlist?TASKID=${encodeURIComponent(id)}&ORDER[POST_DATE]=asc`])),
    );
    return Object.fromEntries(ids.map((id) => [id, (raw[`t${id}`] ?? []).map(toComment)]));
  }

  async addComment(id: string | number, text: string): Promise<number> {
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
