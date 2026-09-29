import type { Env } from "../env";
import { buildXlsx, type Cell } from "../lib/xlsx";
import { chatJson } from "../llm/openrouter";
import { toKyivDate } from "../lib/time";
import { Bitrix, type BxComment, type BxTask, CLOSED, STATUS } from "./client";
import { isOverdue, kyivDateTime, projectName } from "./format";

/**
 * The Excel report of the owner's Bitrix24 tasks: every open task and those closed in the last 30 days, with the
 * project, Kanban stage, Bitrix24 status, the real state read from the task's comments (a short AI summary),
 * responsible, creator, dates and link; plus an analytics sheet. Read-only: nothing in Bitrix24 changes.
 */

const MAX_TASKS = 150;
/** Tasks summarised by AI per model call; the calls run in parallel. */
const AI_CHUNK = 12;

/** What the Excel report can hold — the owner picks it in /bitrix → «📊 Excel-звіт». */
export const REPORT_SCOPES = {
  all: "🗂 Усе: відкриті й закриті за 30 днів",
  open: "📋 Лише відкриті",
  overdue: "🔥 Прострочені",
  week: "⏳ Дедлайн цього тижня",
  mine: "👤 Де я відповідальний",
  given: "📤 Які я поставив",
  closed: "✅ Закриті за 30 днів",
} as const;
export type ReportScope = keyof typeof REPORT_SCOPES;

export interface TaskReport {
  file: Uint8Array;
  filename: string;
  caption: string;
}

/** "Стан за коментарями" for many tasks: one short line each, from the latest comments. */
async function statusFromComments(env: Env, tasks: BxTask[], comments: Record<string, BxComment[]>): Promise<Record<string, string>> {
  const withComments = tasks.filter((t) => comments[t.id]?.length);
  const chunks: BxTask[][] = [];
  for (let i = 0; i < withComments.length; i += AI_CHUNK) chunks.push(withComments.slice(i, i + AI_CHUNK));
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const input = chunk.map((t) => ({
        id: t.id,
        title: t.title,
        status: STATUS[String(t.status)] ?? t.status,
        deadline: kyivDateTime(t.deadline),
        comments: (comments[t.id] ?? []).slice(-8).map((c) => `${kyivDateTime(c.date)} ${c.authorName}: ${c.text.slice(0, 400)}`),
      }));
      try {
        const out = (await chatJson(env, env.AGENT_MODEL, [
          {
            role: "system",
            content:
              "Ти аналізуєш задачі Bitrix24. Для кожної задачі за її коментарями одним реченням (до 200 символів, українською) опиши " +
              "справжній стан: що зроблено, що заважає або чого чекають, наступний крок. Нічого не вигадуй: якщо з коментарів " +
              'незрозуміло — так і напиши. Відповідь — JSON-обʼєкт {"<id>": "<стан>"}.',
          },
          { role: "user", content: JSON.stringify(input) },
        ])) as Record<string, unknown>;
        return Object.fromEntries(Object.entries(out ?? {}).map(([k, v]) => [String(k), String(v ?? "")]));
      } catch {
        return {};
      }
    }),
  );
  return Object.assign({}, ...results);
}

const OPEN = ["1", "2", "3", "4", "6"];

/** The report of the chosen tasks; null when there are none. */
export async function buildTaskReport(env: Env, now = Date.now(), scope: ReportScope = "all"): Promise<TaskReport | null> {
  const bx = new Bitrix(env);
  const me = await bx.me();
  const iso = (t: number) => new Date(t).toISOString();
  const openFilter: Record<string, unknown> =
    scope === "mine"
      ? { RESPONSIBLE_ID: me.id, REAL_STATUS: OPEN }
      : scope === "given"
        ? { CREATED_BY: me.id, REAL_STATUS: OPEN }
        : scope === "overdue"
          ? { MEMBER: me.id, REAL_STATUS: OPEN, "<DEADLINE": iso(now) }
          : scope === "week"
            ? { MEMBER: me.id, REAL_STATUS: OPEN, ">=DEADLINE": iso(now), "<DEADLINE": iso(now + 7 * 86_400_000) }
            : { MEMBER: me.id, REAL_STATUS: OPEN };
  const active = scope === "closed" ? [] : await bx.tasks(openFilter, MAX_TASKS);
  const closed =
    scope === "all" || scope === "closed"
      ? await bx.tasks({ MEMBER: me.id, REAL_STATUS: ["5"], ">=CLOSED_DATE": iso(now - 30 * 86_400_000) }, 50, { CLOSED_DATE: "desc" })
      : [];
  const tasks = [...active, ...closed];
  if (!tasks.length) return null;
  const comments = tasks.length ? await bx.commentsOf(tasks.map((t) => t.id)) : {};
  const stages: Record<string, Record<string, string>> = {};
  for (const g of [...new Set(tasks.filter((t) => t.stageId && t.stageId !== "0").map((t) => t.groupId ?? "0"))].slice(0, 20)) {
    stages[g] = await bx.stageNames(g);
  }
  const state = await statusFromComments(env, tasks, comments);
  const name = async (t: BxTask, who: "responsible" | "creator") =>
    who === "responsible" ? t.responsible?.name || (await bx.personName(t.responsibleId)) : t.creator?.name || (await bx.personName(t.createdBy));

  const header: Cell[] = [
    "ID", "Задача", "Проєкт", "Стадія", "Статус у Bitrix24", "Стан за коментарями", "Відповідальний", "Постановник",
    "Поставлено", "Дедлайн", "Прострочено", "Останній коментар", "Посилання",
  ];
  const rows: Cell[][] = [header];
  const highlight: number[] = [];
  for (const t of tasks) {
    const last = comments[t.id]?.at(-1);
    const overdue = isOverdue(t, now);
    if (overdue) highlight.push(rows.length);
    rows.push([
      Number(t.id),
      t.title,
      projectName(t),
      t.stageId && t.stageId !== "0" ? (stages[t.groupId ?? "0"]?.[String(t.stageId)] ?? "") : "",
      STATUS[String(t.status)] ?? String(t.status),
      state[t.id] || (comments[t.id]?.length ? "" : "Коментарів немає"),
      await name(t, "responsible"),
      await name(t, "creator"),
      kyivDateTime(t.createdDate, false),
      kyivDateTime(t.deadline),
      overdue ? "так" : "",
      last ? `${kyivDateTime(last.date)} · ${last.authorName}` : "",
      bx.taskUrl(t.id, me),
    ]);
  }

  // Analytics
  const openTasks = tasks.filter((t) => !CLOSED.has(String(t.status)));
  const overdueCount = openTasks.filter((t) => isOverdue(t, now)).length;
  const byPerson = new Map<string, { active: number; overdue: number; closed: number }>();
  for (const t of tasks) {
    const p = await name(t, "responsible");
    const row = byPerson.get(p) ?? { active: 0, overdue: 0, closed: 0 };
    if (CLOSED.has(String(t.status))) row.closed++;
    else {
      row.active++;
      if (isOverdue(t, now)) row.overdue++;
    }
    byPerson.set(p, row);
  }
  const byStatus = new Map<string, number>();
  for (const t of openTasks) byStatus.set(STATUS[String(t.status)] ?? String(t.status), (byStatus.get(STATUS[String(t.status)] ?? String(t.status)) ?? 0) + 1);
  const durations = closed
    .map((t) => (t.closedDate && t.createdDate ? (Date.parse(t.closedDate) - Date.parse(t.createdDate)) / 86_400_000 : NaN))
    .filter((d) => Number.isFinite(d) && d >= 0);
  const avg = durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : "";
  const analytics: Cell[][] = [
    ["Показник", "Значення", "", ""],
    ["Звіт сформовано", kyivDateTime(new Date(now).toISOString()), "", ""],
    ["Відкритих задач", openTasks.length, "", ""],
    ["З них прострочено", overdueCount, "", ""],
    ["Закрито за 30 днів", closed.length, "", ""],
    ["Середній час виконання, днів", avg, "", ""],
    ["", "", "", ""],
    ["Статус", "Задач", "", ""],
    ...[...byStatus].sort((a, b) => b[1] - a[1]).map(([s, n]): Cell[] => [s, n, "", ""]),
    ["", "", "", ""],
    ["Відповідальний", "Відкрито", "Прострочено", "Закрито за 30 днів"],
    ...[...byPerson].sort((a, b) => b[1].overdue - a[1].overdue || b[1].active - a[1].active).map(([p, r]): Cell[] => [p, r.active, r.overdue, r.closed]),
  ];

  const file = buildXlsx([
    { name: "Задачі", rows, widths: [8, 42, 20, 18, 18, 60, 22, 22, 12, 17, 12, 30, 40], highlight },
    { name: "Аналітика", rows: analytics, widths: [32, 14, 14, 20] },
  ]);
  return {
    file,
    filename: `zadachi-${scope === "all" ? "" : `${scope}-`}${toKyivDate(new Date(now))}.xlsx`,
    caption:
      `📊 <b>Звіт по задачах Bitrix24</b>\n${REPORT_SCOPES[scope]}\n\n` +
      `📋 Відкрито: <b>${openTasks.length}</b> · 🔥 прострочено: <b>${overdueCount}</b>\n` +
      `✅ Закрито за 30 днів: <b>${closed.length}</b>${avg !== "" ? ` · ⏱ в середньому ${avg} дн.` : ""}\n\n` +
      `<i>Прострочені задачі підсвічено червоним. «Стан за коментарями» — коротко з переписки в задачі.</i>`,
  };
}
