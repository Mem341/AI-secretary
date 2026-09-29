import { createHash } from "node:crypto";
import type { Env } from "../env";
import { HttpError } from "../lib/http";
import { Calendar, type GEvent } from "./calendar";
import { loadGrant, loadOwnerSettings, saveOwnerSettings } from "./oauth";

/**
 * The bot's own signal calendar («AI-secretary · сигнали», scope calendar.app.created): for every upcoming meeting a
 * private shadow event at the same time carrying the email reminders that wake the bot for Telegram. So the meeting
 * itself keeps all 5 of Google's reminder places for the owner's Calendar notifications, and each chosen time gets
 * both a Telegram message and a Calendar notification. The shadows are free/busy-transparent and private; the bot
 * creates, moves and deletes them itself.
 */

const NAME = "AI-secretary · сигнали";
const FOR = "aisFor";
/** aisFor of the test signal from «🔁 Перевірити» (no meeting behind it). */
export const TEST_PREFIX = "test:";

/** The shadow's id for a meeting: fixed, so a move just rewrites it (hex fits Google's a–v, 0–9 id alphabet). */
export function shadowId(meetingId: string): string {
  return `ais${createHash("sha1").update(meetingId).digest("hex").slice(0, 26)}`;
}

/** The signal calendar's id, created on first use. Null without the permission (an older Google connection). */
export async function signalCalendar(env: Env): Promise<string | null> {
  const grant = await loadGrant(env);
  if (!grant?.scope.includes("calendar.app.created")) return null;
  const settings = await loadOwnerSettings(env);
  if (settings.sc) return settings.sc;
  const id = await new Calendar(env).createCalendar(NAME);
  await saveOwnerSettings(env, { ...settings, sc: id });
  return id;
}

/** The meeting a signal stands for (null when the id is not one of the bot's shadows). */
export async function signalTarget(env: Env, eventId: string): Promise<string | null> {
  if (!/^ais[0-9a-f]{26}$/.test(eventId)) return null;
  const sc = (await loadOwnerSettings(env).catch(() => ({ sc: undefined }))).sc;
  if (!sc) return null;
  const shadow = await new Calendar(env, sc).getEvent(eventId).catch(() => null);
  return shadow?.extendedProperties?.private?.[FOR] ?? null;
}

/**
 * Brings the shadows in step with the meetings: creates/moves those of \`upcoming\`, deletes those of \`gone\`, and — for a
 * full pass — every shadow whose meeting is no longer upcoming. Returns how many writes were made.
 */
export async function syncSignals(
  env: Env,
  calendarId: string,
  upcoming: { ev: GEvent; start: number; end: number }[],
  gone: string[],
  marks: number[],
  full: boolean,
  now = Date.now(),
): Promise<number> {
  const sig = new Calendar(env, calendarId);
  let existing: GEvent[];
  try {
    existing = (
      await sig.listEvents({
        singleEvents: "true",
        timeMin: new Date(now - 3600_000).toISOString(),
        timeMax: new Date(now + 9 * 86_400_000).toISOString(),
        maxResults: "250",
      })
    ).items;
  } catch (err) {
    // The owner deleted the signal calendar: make a new one next time.
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) {
      const settings = await loadOwnerSettings(env);
      await saveOwnerSettings(env, { ...settings, sc: undefined });
      return 0;
    }
    throw err;
  }
  const byId = new Map(existing.map((e) => [e.id, e]));
  const overrides = marks.slice(0, 5).map((minutes) => ({ method: "email", minutes }));
  const key = (start: string | undefined, r: GEvent["reminders"]) => `${start ? Date.parse(start) : ""}|${JSON.stringify(r?.overrides ?? [])}`;
  const keep = new Set<string>();
  let writes = 0;
  for (const { ev, start, end } of upcoming) {
    const id = shadowId(ev.id);
    keep.add(id);
    const body = {
      id,
      summary: `🔔 ${ev.summary ?? "зустріч"}`,
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(end).toISOString() },
      // A shadow deleted before keeps its id as a cancelled event: writing it again must bring it back.
      status: "confirmed",
      transparency: "transparent",
      visibility: "private",
      reminders: { useDefault: false, overrides },
      extendedProperties: { private: { [FOR]: ev.id } },
    };
    const have = byId.get(id);
    if (have && key(have.start?.dateTime, have.reminders) === key(body.start.dateTime, body.reminders)) continue;
    await sig.putEvent(body as GEvent & Record<string, unknown>);
    writes++;
  }
  const drop = new Set(gone.map(shadowId));
  if (full) {
    for (const e of existing) {
      const target = e.extendedProperties?.private?.[FOR];
      if (!target || keep.has(e.id)) continue;
      // A running test signal stays until its time has passed.
      if (target.startsWith(TEST_PREFIX) && Date.parse(e.end?.dateTime ?? "") > now) continue;
      drop.add(e.id);
    }
  }
  for (const id of drop) {
    if (keep.has(id)) continue;
    if (!full && !byId.has(id)) continue;
    await sig.deleteSilently(id);
    writes++;
  }
  return writes;
}
