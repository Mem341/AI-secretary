import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { calendarTools } from "../src/agent/calendarTools";
import { gmailTools } from "../src/agent/gmailTools";
import { calendarPrompt, gmailPrompt } from "../src/agent/prompts";
import { runAgent, type Tool } from "../src/agent/runner";
import type { User } from "../src/bot/owner";
import type { Env } from "../src/env";
import { toKyivDate } from "../src/lib/time";

/**
 * Model comparison on the bot's real prompts and tool definitions. Each case is a typical owner request; the tools
 * do not touch Google — they return sample data and record what the model asked for. A case passes when the model
 * called the right tools with the right arguments.
 *
 *   OPENROUTER_API_KEY=sk-or-… npm run eval:models
 *   OPENROUTER_API_KEY=sk-or-… EVAL_MODELS=openai/gpt-oss-120b,qwen/qwen3.7-flash npm run eval:models
 *
 * Results: printed and saved to eval/results.md.
 */

const MODELS = (process.env.EVAL_MODELS ?? "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.7-flash,inception/mercury-2.5,openai/gpt-6-luna-pro")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const env = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
  PUBLIC_URL: "https://eval.local",
  ZOOM_ACCOUNT_ID: "x",
  ZOOM_CLIENT_ID: "x",
  ZOOM_CLIENT_SECRET: "x",
} as unknown as Env;

const OWNER: User = {
  tg_id: 1,
  tg_username: null,
  email: "owner@example.com",
  full_name: "Олександр Коваленко",
  position: null,
  phone: null,
  defaults: { duration_min: 60, format: "google_meet", address: null },
};
const DIRECTORY = [
  { name: "Іван Петренко", email: "ivan@example.com" },
  { name: "Марія Шевченко", email: "maria@example.com" },
  { name: "Олег Мельник", email: "oleg@example.com" },
];

const now = new Date();
const TOMORROW = toKyivDate(new Date(now.getTime() + 86_400_000));
const EVENT = {
  id: "ev1",
  summary: "Стендап з командою",
  start: `${TOMORROW}T10:00:00+03:00`,
  end: `${TOMORROW}T10:30:00+03:00`,
  description: "Щотижневий стендап",
  attendees: [
    { email: "owner@example.com", self: true, responseStatus: "accepted" },
    { email: "ivan@example.com", responseStatus: "accepted" },
  ],
};
const MAIL = { id: "m1", threadId: "t1", from: "Марія Шевченко <maria@example.com>", subject: "Звіт за вересень", snippet: "Надсилаю звіт…" };

/** Sample answers for the tools: whatever the model asks, it gets something realistic back. */
const SAMPLE: Record<string, unknown> = {
  get_calendar_events: [EVENT],
  get_event: EVENT,
  check_free_busy: { busy: [] },
  create_event_google_meet: { id: "new1", status: "confirmed", hangoutLink: "https://meet.google.com/abc-defg-hij" },
  create_event_zoom_link: { id: "new2", status: "confirmed" },
  create_zoom_meeting: { join_url: "https://zoom.us/j/123456789" },
  msg_get_many: [MAIL],
  msg_get: { ...MAIL, body: "Добрий день! Надсилаю звіт за вересень." },
  thread_get_many: [{ id: "t1", snippet: MAIL.snippet }],
};

type Call = { name: string; args: Record<string, unknown> };

function recording(tools: Tool[], calls: Call[]): Tool[] {
  return tools.map((t) => ({
    spec: t.spec,
    async run(args) {
      calls.push({ name: t.spec.name, args });
      return SAMPLE[t.spec.name] ?? { ok: true, id: String(args.eventId ?? args.MessageId ?? "x") };
    },
  }));
}

const called = (calls: Call[], name: string) => calls.filter((c) => c.name === name);
const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));

interface Case {
  agent: "calendar" | "gmail";
  title: string;
  input: string;
  check(calls: Call[], answer: string): string | null; // null = pass, else what went wrong
}

const REPLY = (text: string, ref: string, user: string) => `---REPLY_TO_BOT_MESSAGE---\n${text}\n[${ref}]\n---END_REPLY---\n\n${user}`;

const CASES: Case[] = [
  {
    agent: "calendar",
    title: "Створити зустріч у Meet",
    input: "Зустріч з Іваном завтра о 14 в гугл міт, тема — бюджет",
    check(calls) {
      const create = called(calls, "create_event_google_meet")[0];
      if (!create) return "не створила зустріч";
      if (!str(create.args.startDateTime).startsWith(`${TOMORROW}T14:00`)) return `час ${str(create.args.startDateTime)}`;
      const att = str(create.args.attendeesJson ?? create.args.attendees);
      if (!att.includes("ivan@example.com") || !att.includes("owner@example.com")) return `учасники ${att}`;
      if (!called(calls, "rsvp_event").length) return "не прийняла зустріч (rsvp)";
      return null;
    },
  },
  {
    agent: "calendar",
    title: "Зустріч у Zoom",
    input: "Созвон з Олегом у зумі завтра об 11 на пів години",
    check(calls) {
      if (!called(calls, "create_zoom_meeting").length) return "не створила Zoom";
      const ev = called(calls, "create_event_zoom_link")[0];
      if (!ev) return "не створила подію з Zoom";
      if (!str(ev.args.startDateTime).startsWith(`${TOMORROW}T11:00`)) return `час ${str(ev.args.startDateTime)}`;
      if (!str(ev.args.endDateTime).startsWith(`${TOMORROW}T11:30`)) return `кінець ${str(ev.args.endDateTime)}`;
      return null;
    },
  },
  {
    agent: "calendar",
    title: "Розклад на завтра",
    input: "Що в мене завтра?",
    check(calls, answer) {
      const get = called(calls, "get_calendar_events")[0];
      if (!get) return "не подивилась календар";
      if (!str(get.args.timeMin).startsWith(TOMORROW)) return `timeMin ${str(get.args.timeMin)}`;
      if (!answer.includes("Стендап")) return "у відповіді немає зустрічі";
      return null;
    },
  },
  {
    agent: "calendar",
    title: "Чи вільний я",
    input: "Чи вільний я завтра з 15 до 16?",
    check: (calls) => (called(calls, "check_free_busy").length ? null : "не перевірила зайнятість"),
  },
  {
    agent: "calendar",
    title: "Скасувати по reply",
    input: REPLY("🔄 Подію перенесено\nСтендап з командою", "eventId: ev1", "скасуй"),
    check: (calls) => (called(calls, "delete_event").some((c) => c.args.eventId === "ev1") ? null : "не видалила ev1"),
  },
  {
    agent: "calendar",
    title: "Перенести по reply",
    input: REPLY("📅 Стендап з командою, завтра 10:00–10:30", "eventId: ev1", "перенеси на 16:00"),
    check(calls) {
      const r = called(calls, "reschedule_event").find((c) => c.args.eventId === "ev1");
      if (!r) return "не перенесла ev1";
      if (!str(r.args.newStartDateTime).startsWith(`${TOMORROW}T16:00`)) return `початок ${str(r.args.newStartDateTime)}`;
      if (!str(r.args.newEndDateTime).startsWith(`${TOMORROW}T16:30`)) return `кінець ${str(r.args.newEndDateTime)} (тривалість не збережена)`;
      return null;
    },
  },
  {
    agent: "calendar",
    title: "Нотатка до зустрічі",
    input: REPLY("📅 Стендап з командою", "eventId: ev1", "додай нотатку: принести звіт"),
    check(calls) {
      const u = called(calls, "update_event_fields").find((c) => c.args.eventId === "ev1");
      if (!u) return "не оновила опис";
      const d = str(u.args.patchBody);
      if (!d.includes("звіт")) return "нотатки немає в описі";
      if (!d.includes("Щотижневий")) return "стерла старий опис";
      return null;
    },
  },
  {
    agent: "gmail",
    title: "Перевірити пошту",
    input: "перевір пошту",
    check(calls) {
      const g = called(calls, "msg_get_many")[0];
      if (!g) return "не шукала листи";
      return g.args.ReadStatus === "unread" ? null : `ReadStatus ${str(g.args.ReadStatus)}`;
    },
  },
  {
    agent: "gmail",
    title: "Листи від людини",
    input: "покажи листи від Марії за тиждень",
    check(calls) {
      const g = called(calls, "msg_get_many")[0] ?? called(calls, "thread_get_many")[0];
      if (!g) return "не шукала листи";
      const q = str(g.args.SearchQuery);
      return q.includes("maria") || q.toLowerCase().includes("марі") ? null : `запит ${q}`;
    },
  },
  {
    agent: "gmail",
    title: "Лист — лише після підтвердження",
    input: "Напиши Івану (ivan@example.com), що зустріч переноситься на п'ятницю",
    check(calls, answer) {
      if (called(calls, "msg_send").length) return "надіслала без підтвердження";
      return answer.toLowerCase().includes("п") ? null : "немає превʼю";
    },
  },
];

interface Result {
  model: string;
  case: string;
  ok: boolean;
  note: string;
  seconds: number;
  tokens: number;
  cost: number;
}

it("compares models on the bot's requests", async () => {
  expect(env.OPENROUTER_API_KEY, "set OPENROUTER_API_KEY").not.toBe("");
  const results: Result[] = [];
  for (const model of MODELS) {
    for (const c of CASES) {
      const calls: Call[] = [];
      let tokens = 0;
      let cost = 0;
      const started = Date.now();
      let note = "";
      let ok = false;
      try {
        const answer = await runAgent(env, {
          model,
          system: c.agent === "calendar" ? calendarPrompt(OWNER, DIRECTORY, now) : gmailPrompt(),
          history: [],
          input: c.input,
          tools: recording(c.agent === "calendar" ? calendarTools(env, OWNER.email) : gmailTools(env), calls),
          maxIterations: 10,
          onUsage: (u) => {
            tokens += (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
            cost += u.cost ?? 0;
          },
        });
        const problem = c.check(calls, answer);
        ok = problem === null;
        note = problem ?? "";
      } catch (err) {
        note = `помилка: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
      }
      const r = { model, case: c.title, ok, note, seconds: (Date.now() - started) / 1000, tokens, cost };
      results.push(r);
      console.log(`${ok ? "✅" : "❌"} ${model} · ${c.title} · ${r.seconds.toFixed(1)} с${note ? ` · ${note}` : ""}`);
    }
  }

  const lines = ["# Порівняння моделей", "", `Дата: ${now.toISOString().slice(0, 16)}`, "", "| Модель | Пройдено | Середній час | Токенів на запит | Вартість усіх запитів |", "|---|---|---|---|---|"];
  for (const model of MODELS) {
    const rs = results.filter((r) => r.model === model);
    const passed = rs.filter((r) => r.ok).length;
    const avg = rs.reduce((s, r) => s + r.seconds, 0) / rs.length;
    const tok = Math.round(rs.reduce((s, r) => s + r.tokens, 0) / rs.length);
    const cost = rs.reduce((s, r) => s + r.cost, 0);
    lines.push(`| ${model} | ${passed}/${rs.length} | ${avg.toFixed(1)} с | ${tok} | ${cost ? `$${cost.toFixed(4)}` : "—"} |`);
  }
  lines.push("", "## Помилки", "");
  for (const r of results.filter((x) => !x.ok)) lines.push(`- **${r.model}** · ${r.case}: ${r.note}`);
  writeFileSync("eval/results.md", `${lines.join("\n")}\n`);
  console.log(`\n${lines.join("\n")}`);
});
