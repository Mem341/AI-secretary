import type { Env } from "../env";
import { Calendar } from "../google/calendar";
import { hasGoogleAuth } from "../google/oauth";
import { DAY } from "../lib/time";

/** Address-book entry (name → email). */
export interface DirectoryEntry {
  name: string;
  email: string;
}

let cache: { at: number; list: DirectoryEntry[] } | null = null;
const TTL_MS = 10 * 60_000;

/**
 * Names → emails the owner already meets with, so "зустріч з Іваном" finds Ivan's address. Nothing is stored: the
 * list is read from the attendees of the owner's calendar events (half a year back, two months ahead).
 */
export async function loadDirectory(env: Env, now = Date.now()): Promise<DirectoryEntry[]> {
  if (cache && now - cache.at < TTL_MS) return cache.list;
  if (!(await hasGoogleAuth(env))) return [];
  const byEmail = new Map<string, DirectoryEntry>();
  try {
    const page = await new Calendar(env).listEvents({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: new Date(now - 180 * DAY).toISOString(),
      timeMax: new Date(now + 60 * DAY).toISOString(),
      maxResults: "2500",
    });
    // Later events win, so a renamed contact shows its latest name.
    for (const ev of page.items) {
      for (const a of ev.attendees ?? []) {
        if (a.self || !a.displayName || !a.email) continue;
        byEmail.set(a.email.toLowerCase(), { name: a.displayName, email: a.email.toLowerCase() });
      }
    }
  } catch (err) {
    console.warn("directory: calendar unavailable", err instanceof Error ? err.message : err);
    return [];
  }
  const list = [...byEmail.values()].reverse().slice(0, 300);
  cache = { at: now, list };
  return list;
}

/** Tests: forget the cached list. */
export function resetDirectory(): void {
  cache = null;
}
