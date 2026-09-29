import { Bitrix, type BxTask, STATUS } from "../bitrix/client";
import { isOverdue, kyivDateTime, projectName } from "../bitrix/format";
import { fullName, type Person } from "../bitrix/names";
import type { Env } from "../env";
import { str, type Tool } from "./runner";

/**
 * Tools of the Bitrix24 task agent. On purpose there is no tool to close, change, defer, delegate or delete an
 * existing task: the agent reads tasks and comments, adds comments and creates new tasks — nothing else.
 */

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });
const ids = (description: string) => ({ type: "array", items: { type: "integer" }, description });

const PRIORITY: Record<string, string> = { low: "0", normal: "1", high: "2" };
const ACTIVE_STATUSES = ["1", "2", "3", "4", "6"];

async function brief(bx: Bitrix, t: BxTask, me: Person): Promise<Record<string, unknown>> {
  return {
    id: t.id,
    title: t.title,
    status: STATUS[String(t.status)] ?? t.status,
    overdue: isOverdue(t) || undefined,
    deadline: kyivDateTime(t.deadline) || undefined,
    responsible: t.responsible?.name || (await bx.personName(t.responsibleId)),
    creator: t.creator?.name || (await bx.personName(t.createdBy)),
    project: projectName(t) || undefined,
    created: kyivDateTime(t.createdDate, false),
    url: bx.taskUrl(t.id, me),
  };
}

function roleFilter(role: string, id: number): Record<string, unknown> {
  switch (role) {
    case "responsible":
      return { RESPONSIBLE_ID: id };
    case "creator":
      return { CREATED_BY: id };
    case "accomplice":
      return { ACCOMPLICE: id };
    case "auditor":
      return { AUDITOR: id };
    default:
      return { MEMBER: id };
  }
}

function statusFilter(status: string): Record<string, unknown> {
  switch (status) {
    case "completed":
      return { REAL_STATUS: ["5"] };
    case "overdue":
      return { REAL_STATUS: ACTIVE_STATUSES, "<DEADLINE": new Date().toISOString() };
    case "all":
      return {};
    default:
      return { REAL_STATUS: ACTIVE_STATUSES };
  }
}

/** The owner's task numbers: what is open, late, whose, how fast things get closed. Computed, not guessed. */
export async function taskStats(bx: Bitrix, now = Date.now()): Promise<Record<string, unknown>> {
  const me = await bx.me();
  const active = await bx.tasks({ MEMBER: me.id, REAL_STATUS: ACTIVE_STATUSES }, 500);
  const closed = await bx.tasks({ MEMBER: me.id, REAL_STATUS: ["5"], ">=CLOSED_DATE": new Date(now - 30 * 86_400_000).toISOString() }, 500);
  const byStatus: Record<string, number> = {};
  const byPerson: Record<string, { active: number; overdue: number; closed30d: number }> = {};
  const person = async (t: BxTask) => t.responsible?.name || (await bx.personName(t.responsibleId));
  for (const t of active) {
    const st = STATUS[String(t.status)] ?? String(t.status);
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    const p = (byPerson[await person(t)] ??= { active: 0, overdue: 0, closed30d: 0 });
    p.active++;
    if (isOverdue(t, now)) p.overdue++;
  }
  for (const t of closed) (byPerson[await person(t)] ??= { active: 0, overdue: 0, closed30d: 0 }).closed30d++;
  const durations = closed
    .map((t) => (t.closedDate && t.createdDate ? (Date.parse(t.closedDate) - Date.parse(t.createdDate)) / 86_400_000 : NaN))
    .filter((d) => Number.isFinite(d) && d >= 0);
  const overdue = active.filter((t) => isOverdue(t, now));
  return {
    active: active.length,
    overdue: overdue.length,
    closedLast30Days: closed.length,
    averageDaysToClose: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null,
    byStatus,
    byResponsible: byPerson,
    mostOverdue: await Promise.all(
      overdue
        .sort((a, b) => Date.parse(a.deadline!) - Date.parse(b.deadline!))
        .slice(0, 10)
        .map(async (t) => ({ id: t.id, title: t.title, deadline: kyivDateTime(t.deadline), responsible: await person(t) })),
    ),
  };
}

export function bitrixTools(env: Env): Tool[] {
  const bx = new Bitrix(env);
  return [
    {
      spec: {
        name: "find_user",
        description:
          "Find a colleague in Bitrix24 by what the owner wrote: first and/or last name in any case form or alphabet («Івану Петренку», «Petrenko»), or email. ALWAYS call this before using anybody in a task or filter. Returns candidates, best first; `full: true` means every word matched.",
        parameters: object({ query: s("Name, surname or email exactly as the owner wrote it") }, ["query"]),
      },
      async run(a) {
        const matches = await bx.findPeople(str(a, "query"));
        return matches.map((m) => ({ id: m.person.id, name: fullName(m.person), position: m.person.position, email: m.person.email, full: m.full }));
      },
    },
    {
      spec: {
        name: "list_tasks",
        description:
          "List the owner's Bitrix24 tasks (max 50). role: any (default — every task the owner takes part in), responsible (owner does it), creator (owner set it), accomplice, auditor. status: active (default), overdue, completed, all. Optional: responsibleId (someone's tasks — get the id with find_user), search (words of the title), deadlineFrom/deadlineTo (ISO).",
        parameters: object(
          {
            role: { type: "string", enum: ["any", "responsible", "creator", "accomplice", "auditor"] },
            status: { type: "string", enum: ["active", "overdue", "completed", "all"] },
            responsibleId: { type: "integer", description: "Only tasks where this user is responsible" },
            search: s("Words of the task title"),
            deadlineFrom: s("ISO date/time"),
            deadlineTo: s("ISO date/time"),
            limit: { type: "integer", description: "Default 20, max 50" },
          },
          [],
        ),
      },
      async run(a) {
        const me = await bx.me();
        const filter: Record<string, unknown> = {
          ...(a.responsibleId ? { RESPONSIBLE_ID: Number(a.responsibleId) } : roleFilter(str(a, "role"), me.id)),
          ...statusFilter(str(a, "status")),
        };
        if (str(a, "search")) filter["%TITLE"] = str(a, "search");
        if (str(a, "deadlineFrom")) filter[">=DEADLINE"] = str(a, "deadlineFrom");
        if (str(a, "deadlineTo")) filter["<=DEADLINE"] = str(a, "deadlineTo");
        const limit = Math.min(50, Math.max(1, Number(a.limit) || 20));
        const tasks = await bx.tasks(filter, limit);
        return Promise.all(tasks.map((t) => brief(bx, t, me)));
      },
    },
    {
      spec: {
        name: "get_task",
        description: "Full details of one task: description, status, stage, deadline, all participants, project, dates and link.",
        parameters: object({ taskId: { type: "integer", description: "Task ID" } }, ["taskId"]),
      },
      async run(a) {
        const me = await bx.me();
        const t = await bx.task(Number(a.taskId));
        const stages = t.stageId && t.stageId !== "0" ? await bx.stageNames(t.groupId) : {};
        return {
          ...(await brief(bx, t, me)),
          description: (t.description ?? "").slice(0, 3000),
          stage: stages[String(t.stageId)] || undefined,
          accomplices: await Promise.all((t.accomplices ?? []).map((id) => bx.personName(id))),
          auditors: await Promise.all((t.auditors ?? []).map((id) => bx.personName(id))),
          changed: kyivDateTime(t.changedDate),
          closed: kyivDateTime(t.closedDate) || undefined,
        };
      },
    },
    {
      spec: {
        name: "get_task_comments",
        description:
          "The task's discussion — its «Чат завдання» (incl. system messages about status changes) and comments: who, when, what. The real state of work is usually there.",
        parameters: object({ taskId: { type: "integer" }, limit: { type: "integer", description: "Default 15" } }, ["taskId"]),
      },
      async run(a) {
        const comments = await bx.comments(Number(a.taskId));
        return comments.slice(-(Number(a.limit) || 15)).map((c) => ({ author: c.authorName, date: kyivDateTime(c.date), text: c.text.slice(0, 1500) }));
      },
    },
    {
      spec: {
        name: "add_comment",
        description: "Add a comment to a task (colleagues see it). Only after the owner confirmed the exact text.",
        parameters: object({ taskId: { type: "integer" }, text: s("Comment text") }, ["taskId", "text"]),
      },
      async run(a) {
        return { ok: true, commentId: await bx.addComment(Number(a.taskId), str(a, "text")) };
      },
    },
    {
      spec: {
        name: "create_task",
        description:
          "Create a Bitrix24 task (the owner is its creator). Only after the owner confirmed the preview. People are user IDs from find_user; deadline in ISO with the Kyiv offset.",
        parameters: object(
          {
            title: s("Short task title"),
            description: s("What exactly to do; empty string if nothing"),
            responsibleId: { type: "integer", description: "Who does it (default: the owner)" },
            accompliceIds: ids("Co-executors"),
            auditorIds: ids("Observers"),
            deadline: s("ISO, e.g. 2026-10-02T18:00:00+03:00"),
            priority: { type: "string", enum: ["low", "normal", "high"] },
            projectId: { type: "integer", description: "Project (workgroup) ID from find_project" },
          },
          ["title"],
        ),
      },
      async run(a) {
        const me = await bx.me();
        const fields: Record<string, unknown> = { TITLE: str(a, "title"), RESPONSIBLE_ID: Number(a.responsibleId) || me.id };
        if (str(a, "description")) fields.DESCRIPTION = str(a, "description");
        if (Array.isArray(a.accompliceIds) && a.accompliceIds.length) fields.ACCOMPLICES = a.accompliceIds.map(Number);
        if (Array.isArray(a.auditorIds) && a.auditorIds.length) fields.AUDITORS = a.auditorIds.map(Number);
        if (str(a, "deadline")) fields.DEADLINE = str(a, "deadline");
        if (PRIORITY[str(a, "priority")]) fields.PRIORITY = PRIORITY[str(a, "priority")];
        if (a.projectId) fields.GROUP_ID = Number(a.projectId);
        const t = await bx.createTask(fields);
        return { id: t.id, url: bx.taskUrl(t.id, me) };
      },
    },
    {
      spec: { name: "find_project", description: "Find a Bitrix24 project (workgroup) by name.", parameters: object({ query: s("Part of the project name") }, ["query"]) },
      async run(a) {
        return bx.projects(str(a, "query"));
      },
    },
    {
      spec: {
        name: "task_stats",
        description: "Numbers for analysis: open / overdue / closed in 30 days, average days to close, by status, by responsible, most overdue tasks.",
        parameters: object({}, []),
      },
      async run() {
        return taskStats(bx);
      },
    },
  ];
}

