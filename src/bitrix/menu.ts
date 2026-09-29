import { taskStats } from "../agent/bitrixTools";
import { bitrixConfigured, type Env } from "../env";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { Bitrix, type BxTask, STATUS } from "./client";
import { isOverdue, kyivDateTime } from "./format";
import { buildTaskReport, REPORT_SCOPES, type ReportScope } from "./report";

/** /bitrix: the task menu. Its buttons ("bx:…") work in plain code — no AI, nothing in Bitrix24 changes. */

export type BitrixAction = "my" | "overdue" | "stats" | `report:${ReportScope}`;

/** «📊 Excel-звіт»: first what to put in it. */
export async function showReportMenu(env: Env, chatId: number): Promise<void> {
  const scopes = Object.entries(REPORT_SCOPES).map(([k, text]) => ({ text, callback_data: `bx:report:${k}` }));
  await new Telegram(env).send(chatId, "📊 <b>Що вивантажити в Excel?</b>\n\nУ файлі: задача, проєкт, стадія, статус, стан за коментарями, відповідальний, постановник, дати, посилання й аналітика.", {
    keyboard: [scopes.slice(0, 1), scopes.slice(1, 3), scopes.slice(3, 5), scopes.slice(5, 7)],
  });
}

const MENU: InlineKeyboard = [
  [
    { text: "📋 Мої задачі", callback_data: "bx:my" },
    { text: "🔥 Прострочені", callback_data: "bx:overdue" },
  ],
  [
    { text: "📈 Аналітика", callback_data: "bx:stats" },
    { text: "📊 Excel-звіт", callback_data: "bx:report" },
  ],
];

export async function showBitrixMenu(env: Env, chatId: number): Promise<void> {
  const tg = new Telegram(env);
  if (!bitrixConfigured(env)) {
    await tg.send(
      chatId,
      "📋 <b>Bitrix24 не підключено</b>\n\nНатисніть кнопку — я підкажу, що скопіювати з Bitrix24.",
      { keyboard: [[{ text: "🔗 Підключити Bitrix24", callback_data: "set:on:bitrix" }]] },
    );
    return;
  }
  await tg.send(
    chatId,
    "📋 <b>Bitrix24 — задачі</b>\n\nОберіть нижче або просто напишіть:\n" +
      "• «мої задачі на тиждень» · «що горить?»\n" +
      "• «що із задачею про звіт?» — стан за коментарями\n" +
      "• «постав Івану Петренку задачу підготувати договір до пʼятниці»\n" +
      "• «напиши в задачу 123, що документи вже надіслали»",
    { keyboard: MENU },
  );
}

function taskLine(bx: Bitrix, t: BxTask, meId: number): string {
  const overdue = isOverdue(t);
  const deadline = t.deadline ? ` — до ${esc(kyivDateTime(t.deadline))}${overdue ? " (прострочено)" : ""}` : "";
  const who = t.responsible?.name ? `👤 ${esc(t.responsible.name)} · ` : "";
  return (
    `${overdue ? "🔥" : "⏳"} <b>${esc(t.title)}</b>${deadline}\n` +
    `    ${who}${esc(STATUS[String(t.status)] ?? String(t.status))} · <a href="${esc(bx.taskUrl(t.id, { id: meId, name: "", lastName: "" }))}">#${esc(t.id)}</a>`
  );
}

/** Runs a menu button (in a background job). */
export async function runBitrixAction(env: Env, chatId: number, action: BitrixAction): Promise<void> {
  const tg = new Telegram(env);
  const bx = new Bitrix(env);
  const me = await bx.me();
  if (action.startsWith("report:")) {
    const scope = action.slice("report:".length) as ReportScope;
    const report = await buildTaskReport(env, Date.now(), scope);
    if (!report) await tg.send(chatId, `${REPORT_SCOPES[scope]}: задач немає.`);
    else await tg.sendDocument(chatId, report.filename, report.file, report.caption);
    return;
  }
  if (action === "stats") {
    const s = (await taskStats(bx)) as {
      active: number;
      overdue: number;
      closedLast30Days: number;
      averageDaysToClose: number | null;
      byResponsible: Record<string, { active: number; overdue: number; closed30d: number }>;
    };
    const people = Object.entries(s.byResponsible)
      .sort((a, b) => b[1].overdue - a[1].overdue || b[1].active - a[1].active)
      .slice(0, 8)
      .map(([p, r]) => `• ${esc(p)} — ${r.active} відкрито${r.overdue ? `, 🔥 ${r.overdue} прострочено` : ""}${r.closed30d ? `, ✅ ${r.closed30d} закрито` : ""}`);
    await tg.send(
      chatId,
      [
        "📈 <b>Аналітика задач</b>",
        "",
        `📋 Відкрито: <b>${s.active}</b> · 🔥 прострочено: <b>${s.overdue}</b>`,
        `✅ Закрито за 30 днів: <b>${s.closedLast30Days}</b>${s.averageDaysToClose !== null ? ` · ⏱ в середньому ${s.averageDaysToClose} дн.` : ""}`,
        ...(people.length ? ["", "<b>За відповідальними</b>", ...people] : []),
        "",
        "<i>Детально — «📊 Excel-звіт».</i>",
      ].join("\n"),
      { keyboard: [[{ text: "📊 Excel-звіт", callback_data: "bx:report" }]] },
    );
    return;
  }
  const active = ["1", "2", "3", "4", "6"];
  const filter: Record<string, unknown> =
    action === "overdue" ? { MEMBER: me.id, REAL_STATUS: active, "<DEADLINE": new Date().toISOString() } : { MEMBER: me.id, REAL_STATUS: active };
  const tasks = await bx.tasks(filter, 20);
  const title = action === "overdue" ? "🔥 <b>Прострочені задачі</b>" : "📋 <b>Мої задачі</b>";
  await tg.send(
    chatId,
    tasks.length
      ? `${title} (${tasks.length}${tasks.length === 20 ? "+" : ""})\n\n${tasks.map((t) => taskLine(bx, t, me.id)).join("\n\n")}`
      : action === "overdue"
        ? "🎉 Прострочених задач немає."
        : "Відкритих задач немає.",
  );
}
