// All user-facing dates are in Europe/Kyiv (spec section 6).
export const TZ = "Europe/Kyiv";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const WEEKDAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];
const WEEKDAYS_SHORT = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS_GEN = [
  "січня", "лютого", "березня", "квітня", "травня", "червня",
  "липня", "серпня", "вересня", "жовтня", "листопада", "грудня",
];

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

export function kyivParts(date: Date): LocalParts {
  const p: Record<string, number> = {};
  for (const part of partsFormatter.formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const year = p.year!, month = p.month!, day = p.day!;
  return {
    year, month, day,
    hour: p.hour!, minute: p.minute!, second: p.second!,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Offset of Kyiv from UTC at the given instant, in minutes (+120 or +180). */
export function kyivOffsetMinutes(date: Date): number {
  const p = kyivParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / MINUTE);
}

/** Instant of a Kyiv wall-clock time. */
export function kyivLocalToDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset around DST switches.
  let ts = guess - kyivOffsetMinutes(new Date(guess)) * MINUTE;
  ts = guess - kyivOffsetMinutes(new Date(ts)) * MINUTE;
  return new Date(ts);
}

const pad = (n: number) => String(n).padStart(2, "0");

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 2026-10-01T15:00:00+03:00 */
export function toKyivIso(date: Date): string {
  const p = kyivParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffset(kyivOffsetMinutes(date))}`;
}

/** 2026-10-01 */
export function toKyivDate(date: Date): string {
  const p = kyivParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Context line for the LLM: "2026-09-28, неділя, 14:23 (Europe/Kyiv, UTC+03:00)". */
export function describeNow(now: Date): string {
  const p = kyivParts(now);
  return `${toKyivDate(now)}, ${WEEKDAYS[p.weekday]}, ${pad(p.hour)}:${pad(p.minute)} (${TZ}, UTC${formatOffset(kyivOffsetMinutes(now))})`;
}

/** "15:00" */
export function formatTime(date: Date): string {
  const p = kyivParts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "чт, 1 жовтня 2026" (year omitted when it is the current one). */
export function formatDay(date: Date, now = new Date()): string {
  const p = kyivParts(date);
  const year = p.year === kyivParts(now).year ? "" : ` ${p.year}`;
  return `${WEEKDAYS_SHORT[p.weekday]}, ${p.day} ${MONTHS_GEN[p.month - 1]}${year}`;
}

/** "чт, 1 жовтня, 15:00–16:00" */
export function formatRange(start: Date, end: Date, now = new Date()): string {
  const sameDay = toKyivDate(start) === toKyivDate(end);
  const endPart = sameDay ? formatTime(end) : `${formatDay(end, now)}, ${formatTime(end)}`;
  return `${formatDay(start, now)}, ${formatTime(start)}–${endPart}`;
}

/** "28.09.2026" from "2026-09-28". */
export function formatIsoDateShort(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : isoDate;
}

/** Parses an ISO date-time with an explicit offset; null when invalid or offset missing. */
export function parseIsoWithOffset(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parses a local Kyiv "YYYY-MM-DDTHH:MM" (no offset) — LLMs sometimes drop the offset. */
export function parseKyivLocal(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(:\d{2})?$/.exec(value);
  if (!m) return null;
  return kyivLocalToDate(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!);
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
