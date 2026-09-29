import type { Env } from "../env";
import { hasGoogleAuth } from "../google/oauth";
import { listMeetings, type Meeting } from "../google/sync";
import { DAY, formatDay, formatRange, formatTime, kyivLocalToDate, kyivParts } from "../lib/time";
import { esc, Telegram } from "../telegram/api";
import { findFreeSlots } from "./card";
import { sendConnectGoogle } from "./onboarding";

/** Commands that read the calendar: no AI involved, straight from Google. */
export type AgendaPeriod = "today" | "tomorrow" | "week";

export function formatAgenda(meetings: Meeting[], now: Date): string {
  return meetings
    .map((m) => {
      const where = m.meet_url ? " · онлайн" : m.location ? ` · ${esc(m.location)}` : "";
      return `• <b>${esc(formatRange(new Date(m.start_at), new Date(m.end_at), now))}</b> — ${esc(m.title ?? "без назви")}${where}`;
    })
    .join("\n");
}

function startOfKyivDay(t: number): number {
  const p = kyivParts(new Date(t));
  return kyivLocalToDate(p.year, p.month, p.day).getTime();
}

const TITLES: Record<AgendaPeriod, string> = { today: "Сьогодні", tomorrow: "Завтра", week: "Найближчі 7 днів" };

/** /today, /tomorrow, /week */
export async function showAgenda(env: Env, period: AgendaPeriod, now = Date.now()): Promise<void> {
  if (!(await hasGoogleAuth(env))) return sendConnectGoogle(env);
  const today = startOfKyivDay(now);
  const [from, to] =
    period === "today" ? [now, today + DAY] : period === "tomorrow" ? [today + DAY, today + 2 * DAY] : [now, today + 7 * DAY];
  const meetings = await listMeetings(env, from, to);
  const body = meetings.length ? formatAgenda(meetings, new Date(now)) : "Зустрічей немає 🙂";
  await new Telegram(env).send(env.OWNER_TELEGRAM_ID, `📅 <b>${TITLES[period]}</b>\n\n${body}`);
}

/** /free — the nearest free slots in working hours, for the default meeting length. */
export async function showFreeSlots(env: Env, now = Date.now()): Promise<void> {
  if (!(await hasGoogleAuth(env))) return sendConnectGoogle(env);
  const busy = await listMeetings(env, now, now + 14 * DAY);
  const slots = findFreeSlots({
    now: new Date(now),
    durationMin: env.DEFAULT_DURATION_MIN,
    busy: busy.map((m) => ({ start: m.start_at, end: m.end_at })),
    count: 6,
  });
  const lines = slots.map((s) => `• ${esc(formatDay(s, new Date(now)))}, ${formatTime(s)}`);
  await new Telegram(env).send(
    env.OWNER_TELEGRAM_ID,
    slots.length
      ? `🕒 <b>Вільні вікна на ${env.DEFAULT_DURATION_MIN} хв</b>\n\n${lines.join("\n")}\n\nЩоб поставити зустріч — «📝 Поставити зустріч» або просто опишіть її.`
      : "Найближчими днями вільних вікон у робочий час немає.",
  );
}
