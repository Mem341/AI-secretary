import { createHash } from "node:crypto";
import type { Job } from "./jobs";

/**
 * Settings from environment variables. Anyone can deploy their own copy: only three variables are required,
 * everything else is optional or derived, and the bot always serves exactly one owner.
 */
export interface Config {
  /** The only Telegram user the bot talks to. Everyone else is ignored. */
  OWNER_TELEGRAM_ID: number;
  /** Public https URL of the deployment, no trailing slash (OAuth redirect, Google push, Telegram webhook). */
  PUBLIC_URL: string;
  LLM_MODEL: string;
  LLM_MODEL_SUMMARY: string;
  /** OpenRouter model with audio input that transcribes voice messages. */
  STT_MODEL: string;

  TELEGRAM_BOT_TOKEN: string;
  OPENROUTER_API_KEY: string;
  /** Header secret of the Telegram webhook; derived from the bot token unless set. */
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Encrypts the Google grant kept in the chat; derived from the bot token unless set. Changing it means reconnecting Google. */
  ENCRYPTION_KEY: string;
  /** Google Calendar; "" until the owner creates an OAuth client (see /api/setup). */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** When set, Vercel Cron must send it as a Bearer token; "" leaves the (idempotent) daily cron open. */
  CRON_SECRET: string;
  /** Zoom Server-to-Server OAuth app; "" disables Zoom as a meeting format (Google Meet still works). */
  ZOOM_ACCOUNT_ID: string;
  ZOOM_CLIENT_ID: string;
  ZOOM_CLIENT_SECRET: string;
  /**
   * Cloud Pub/Sub topic (projects/<project>/topics/<name>) for instant new-mail notifications; "" disables the
   * push and Gmail actions still work on demand (e.g. "перевір пошту").
   */
  GMAIL_PUBSUB_TOPIC: string;

  // Optional profile for event descriptions; the name defaults to the owner's Telegram name.
  OWNER_NAME: string;
  OWNER_POSITION: string;
  OWNER_PHONE: string;
  /** Meeting defaults: duration in minutes, format (offline | google_meet | zoom), address for offline meetings. */
  DEFAULT_DURATION_MIN: number;
  DEFAULT_FORMAT: "offline" | "google_meet" | "zoom";
  DEFAULT_ADDRESS: string;
}

export interface JobQueue {
  /** Runs the job in the background of the current invocation, after an optional delay. */
  send(job: Job, opts?: { delaySeconds?: number }): Promise<void>;
}

export interface Env extends Config {
  jobs: JobQueue;
}

export const DEFAULT_LLM_MODEL = "google/gemini-2.5-flash";
export const DEFAULT_LLM_MODEL_SUMMARY = "anthropic/claude-sonnet-4.5";
export const DEFAULT_STT_MODEL = "google/gemini-2.5-flash";

export const REQUIRED_VARS = ["OWNER_TELEGRAM_ID", "TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY"] as const;

export class ConfigError extends Error {}

/** Stable secret derived from the bot token, so a fresh deployment needs no extra secrets. */
function derive(botToken: string, purpose: string): string {
  return createHash("sha256").update(`ai-secretary:${purpose}:${botToken}`).digest("hex");
}

/**
 * Reads and validates the configuration; lists every missing variable at once. `fallbackPublicUrl` is used when
 * neither PUBLIC_URL nor Vercel's production URL is set (AWS: the Function URL the request arrived on).
 */
export function loadConfig(source: Record<string, string | undefined> = process.env, fallbackPublicUrl = ""): Config {
  const val = (k: string) => source[k]?.trim() ?? "";
  const missing: string[] = REQUIRED_VARS.filter((k) => !val(k));
  const publicUrl =
    val("PUBLIC_URL") ||
    (val("VERCEL_PROJECT_PRODUCTION_URL") ? `https://${val("VERCEL_PROJECT_PRODUCTION_URL")}` : "") ||
    fallbackPublicUrl;
  if (!publicUrl) missing.push("PUBLIC_URL");
  if (missing.length) throw new ConfigError(`Missing environment variables: ${missing.join(", ")}`);

  const ownerId = Number(val("OWNER_TELEGRAM_ID"));
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new ConfigError("OWNER_TELEGRAM_ID must be your numeric Telegram user id (ask @userinfobot)");
  }

  const botToken = val("TELEGRAM_BOT_TOKEN");
  return {
    OWNER_TELEGRAM_ID: ownerId,
    PUBLIC_URL: publicUrl.replace(/\/+$/, ""),
    LLM_MODEL: val("LLM_MODEL") || DEFAULT_LLM_MODEL,
    LLM_MODEL_SUMMARY: val("LLM_MODEL_SUMMARY") || DEFAULT_LLM_MODEL_SUMMARY,
    STT_MODEL: val("STT_MODEL") || DEFAULT_STT_MODEL,
    TELEGRAM_BOT_TOKEN: botToken,
    OPENROUTER_API_KEY: val("OPENROUTER_API_KEY"),
    // Telegram allows only [A-Za-z0-9_-] in the webhook secret; hex fits.
    TELEGRAM_WEBHOOK_SECRET: val("TELEGRAM_WEBHOOK_SECRET") || derive(botToken, "telegram-webhook"),
    ENCRYPTION_KEY: val("ENCRYPTION_KEY") || derive(botToken, "encryption"),
    GOOGLE_CLIENT_ID: val("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: val("GOOGLE_CLIENT_SECRET"),
    CRON_SECRET: val("CRON_SECRET"),
    ZOOM_ACCOUNT_ID: val("ZOOM_ACCOUNT_ID"),
    ZOOM_CLIENT_ID: val("ZOOM_CLIENT_ID"),
    ZOOM_CLIENT_SECRET: val("ZOOM_CLIENT_SECRET"),
    GMAIL_PUBSUB_TOPIC: val("GMAIL_PUBSUB_TOPIC"),
    OWNER_NAME: val("OWNER_NAME"),
    OWNER_POSITION: val("OWNER_POSITION"),
    OWNER_PHONE: val("OWNER_PHONE"),
    DEFAULT_DURATION_MIN: durationVal(val("DEFAULT_DURATION_MIN")),
    DEFAULT_FORMAT: formatVal(val("DEFAULT_FORMAT")),
    DEFAULT_ADDRESS: val("DEFAULT_ADDRESS"),
  };
}

function durationVal(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 5 && n <= 12 * 60 ? Math.round(n) : 60;
}

function formatVal(v: string): Config["DEFAULT_FORMAT"] {
  return v === "google_meet" || v === "zoom" ? v : "offline";
}

export function isOwner(env: Config, tgId: number | undefined): boolean {
  return tgId === env.OWNER_TELEGRAM_ID;
}

export function googleConfigured(env: Config): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function zoomConfigured(env: Config): boolean {
  return !!(env.ZOOM_ACCOUNT_ID && env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET);
}

export function gmailPushConfigured(env: Config): boolean {
  return !!env.GMAIL_PUBSUB_TOPIC;
}

/** Where Google must redirect after consent; the owner pastes it into the OAuth client. */
export function googleRedirectUri(env: Config): string {
  return `${env.PUBLIC_URL}/api/oauth/callback`;
}
