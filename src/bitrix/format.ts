import { formatTime, toKyivDate } from "../lib/time";
import { type BxTask, CLOSED } from "./client";

/** "02.10.2026 18:00" in Kyiv time, "" for no date. */
export function kyivDateTime(value: string | null | undefined, withTime = true): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const [y, m, day] = toKyivDate(d).split("-");
  return `${day}.${m}.${y}${withTime ? ` ${formatTime(d)}` : ""}`;
}

export function isOverdue(t: BxTask, now = Date.now()): boolean {
  return !CLOSED.has(String(t.status)) && !!t.deadline && Date.parse(t.deadline) < now;
}

export function projectName(t: BxTask): string {
  return t.group && !Array.isArray(t.group) ? t.group.name : "";
}
