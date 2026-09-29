import type { Env } from "../env";
import { hasGoogleAuth } from "../google/oauth";
import { listMeetings, type Meeting } from "../google/sync";
import { DAY, describeNow, formatRange, kyivLocalToDate, toKyivDate } from "../lib/time";
import { chatJson, chatText } from "../llm/openrouter";
import { esc, Telegram } from "../telegram/api";
import { looksLikeMailRequest } from "./mail";
import { sendConnectGoogle } from "./onboarding";

/**
 * Free text with no reply context goes through a small, cheap model first (ROUTER_MODEL): it only decides what the
 * owner wants — a new meeting, a look at the schedule, mail, or just a conversation. The heavy work is then done by
 * LLM_MODEL. If the router fails, mail words go to Gmail and everything else is treated as a meeting request.
 */
export type Intent = "meeting" | "agenda" | "mail" | "chat";

export interface Route {
  intent: Intent;
  /** For "agenda": the period asked about, Kyiv dates (YYYY-MM-DD), inclusive. */
  from: string | null;
  to: string | null;
}

const INTENTS = new Set<Intent>(["meeting", "agenda", "mail", "chat"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function routerPrompt(now: Date): string {
  return [
    "Ти — маршрутизатор запитів до AI-секретаря керівника. Визнач намір повідомлення і поверни ЛИШЕ JSON:",
    '{"intent": "meeting" | "agenda" | "mail" | "chat", "from": "YYYY-MM-DD" | null, "to": "YYYY-MM-DD" | null}',
    "",
    `Зараз: ${describeNow(now)} (Europe/Kyiv).`,
    "",
    "- meeting: призначити, створити, запланувати зустріч, дзвінок, подію; «нагадай мені …» про справу в певний час;",
    "  переслана переписка чи опис домовленості про зустріч.",
    "- agenda: питання про розклад і календар: «що в мене завтра», «які зустрічі на тижні», «коли зустріч з Іваном»,",
    "  «чи я вільний у пʼятницю о 15». Заповни from/to — період, про який питають (сьогодні, якщо не сказано;",
    "  «коли зустріч з …» без дати — наступні 30 днів).",
    "- mail: пошта, листи, email, Gmail: перевірити, прочитати, написати, відповісти.",
    "- chat: усе інше — привітання, подяка, питання до тебе, загальні питання.",
    "Мова повідомлення може бути українська, російська чи англійська.",
  ].join("\n");
}

/** The fallback without the router: the old keyword rules. */
function fallback(text: string): Route {
  return { intent: looksLikeMailRequest(text) ? "mail" : "meeting", from: null, to: null };
}

export async function classify(env: Env, text: string, now = new Date()): Promise<Route> {
  try {
    const raw = (await chatJson(env, env.ROUTER_MODEL, [
      { role: "system", content: routerPrompt(now) },
      { role: "user", content: text },
    ])) as Record<string, unknown>;
    const intent = raw?.intent as Intent;
    if (!INTENTS.has(intent)) return fallback(text);
    const date = (v: unknown) => (typeof v === "string" && ISO_DATE.test(v) ? v : null);
    return { intent, from: date(raw.from), to: date(raw.to) };
  } catch (err) {
    console.warn("router failed, using keywords", err instanceof Error ? err.message : err);
    return fallback(text);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// "What do I have tomorrow?"

function dayStart(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return kyivLocalToDate(y, m, d).getTime();
}

export function formatAgenda(meetings: Meeting[], now: Date): string {
  return meetings
    .map((m) => {
      const where = m.meet_url ? " · онлайн" : m.location ? ` · ${esc(m.location)}` : "";
      return `• <b>${esc(formatRange(new Date(m.start_at), new Date(m.end_at), now))}</b> — ${esc(m.title ?? "без назви")}${where}`;
    })
    .join("\n");
}

/** Answers a question about the schedule from the live calendar. */
export async function answerAgenda(env: Env, text: string, route: Route, now = new Date()): Promise<void> {
  const tg = new Telegram(env);
  if (!(await hasGoogleAuth(env))) {
    await sendConnectGoogle(env);
    return;
  }
  const from = dayStart(route.from ?? toKyivDate(now));
  const to = (route.to ? dayStart(route.to) : from) + DAY;
  const meetings = await listMeetings(env, Math.max(from, now.getTime() - 3600_000), Math.min(to, from + 62 * DAY));
  const list = meetings.length ? formatAgenda(meetings, now) : "";
  // A plain "what do I have" gets the list; a question ("am I free at 3?") gets an answer based on it.
  const answer = await chatText(env, env.LLM_MODEL, [
    {
      role: "system",
      content: [
        "Ти — AI-секретар керівника. Відповідай коротко, по суті, мовою питання, простим текстом без Markdown.",
        `Зараз: ${describeNow(now)} (Europe/Kyiv).`,
        "Ось події з календаря за потрібний період (час київський):",
        meetings.length
          ? meetings.map((m) => `- ${formatRange(new Date(m.start_at), new Date(m.end_at), now)}: ${m.title ?? "без назви"}${m.attendees.length ? ` (учасники: ${m.attendees.map((a) => a.name ?? a.email).join(", ")})` : ""}`).join("\n")
          : "(подій немає)",
        "Якщо просять просто показати розклад — скажи одним реченням підсумок (список покаже бот сам). Нічого не вигадуй.",
      ].join("\n"),
    },
    { role: "user", content: text },
  ]).catch(() => "");
  await tg.send(env.OWNER_TELEGRAM_ID, [answer.trim() ? esc(answer.trim()) : meetings.length ? "📅 Ваш розклад:" : "📅 Подій немає.", list].filter(Boolean).join("\n\n"));
}

// ---------------------------------------------------------------------------------------------------------------
// Anything else

export async function answerChat(env: Env, text: string, now = new Date()): Promise<void> {
  const answer = await chatText(env, env.LLM_MODEL, [
    {
      role: "system",
      content: [
        "Ти — особистий AI-секретар у Telegram. Відповідай коротко й доброзичливо, мовою повідомлення, простим текстом.",
        `Зараз: ${describeNow(now)} (Europe/Kyiv).`,
        "Ти вмієш: створювати зустрічі в Google Calendar з тексту, голосового, пересланої переписки чи скріншота;",
        "показувати розклад («що в мене завтра?»); переносити й скасовувати зустрічі у відповідь на повідомлення про них;",
        "працювати з Gmail («перевір пошту», «напиши Івану лист»); повідомляти про зміни в календарі й нагадувати про зустрічі.",
        "Якщо просять те, чого ти не вмієш, чесно скажи й запропонуй, що можеш.",
      ].join("\n"),
    },
    { role: "user", content: text },
  ]);
  await new Telegram(env).send(env.OWNER_TELEGRAM_ID, esc(answer.trim() || "🙂"));
}
