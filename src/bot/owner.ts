import { type Config, type Env, zoomConfigured } from "../env";
import { loadGrant } from "../google/oauth";
import { Telegram } from "../telegram/api";
import type { TgUser } from "../telegram/types";

export type MeetingFormat = Config["DEFAULT_FORMAT"];

export interface UserDefaults {
  duration_min: number;
  format: MeetingFormat;
  address: string | null;
}

/**
 * The bot's owner as the meeting flows see them. Nothing is stored: the name comes from OWNER_NAME or the owner's
 * Telegram profile, the email from the connected Google account, the rest from optional environment variables.
 */
export interface User {
  tg_id: number;
  tg_username: string | null;
  email: string | null;
  full_name: string | null;
  position: string | null;
  phone: string | null;
  defaults: UserDefaults;
}

export function durationOf(user: User): number {
  return user.defaults.duration_min;
}

export function formatOf(user: User): MeetingFormat {
  return user.defaults.format;
}

export function firstName(user: User): string {
  return (user.full_name ?? "").trim().split(/\s+/)[0] ?? "";
}

let profileCache: { at: number; name: string | null; username: string | null } | null = null;
const PROFILE_TTL_MS = 10 * 60_000;

/** Tests: forget the cached Telegram profile. */
export function resetOwnerCache(): void {
  profileCache = null;
}

function nameOf(u: { first_name?: string; last_name?: string }): string | null {
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null;
}

/** Builds the owner's profile. `from` (the sender of the current update) saves a Telegram call. */
export async function loadOwner(env: Env, from?: TgUser): Promise<User> {
  if (from) profileCache = { at: Date.now(), name: nameOf(from), username: from.username ?? null };
  if (!profileCache || Date.now() - profileCache.at > PROFILE_TTL_MS) {
    const chat = await new Telegram(env)
      .call<{ first_name?: string; last_name?: string; username?: string }>("getChat", { chat_id: env.OWNER_TELEGRAM_ID })
      .catch(() => null);
    profileCache = { at: Date.now(), name: chat ? nameOf(chat) : null, username: chat?.username ?? null };
  }
  const grant = await loadGrant(env).catch(() => null);
  return {
    tg_id: env.OWNER_TELEGRAM_ID,
    tg_username: profileCache.username,
    email: grant?.email ?? null,
    full_name: env.OWNER_NAME || profileCache.name,
    position: env.OWNER_POSITION || null,
    phone: env.OWNER_PHONE || null,
    defaults: {
      duration_min: env.DEFAULT_DURATION_MIN,
      // Zoom as the default only works once Zoom is configured.
      format: env.DEFAULT_FORMAT === "zoom" && !zoomConfigured(env) ? "offline" : env.DEFAULT_FORMAT,
      address: env.DEFAULT_ADDRESS || null,
    },
  };
}
