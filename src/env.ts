import type { Db } from "./db/client";
import type { Job } from "./jobs";

/** Settings from environment variables (Vercel project settings). */
export interface Config {
  /** The only Telegram user the bot talks to. Everyone else is ignored. */
  OWNER_TELEGRAM_ID: number;
  /** Public https URL of the deployment, no trailing slash (OAuth redirect, Google push address). */
  PUBLIC_URL: string;
  LLM_MODEL: string;
  LLM_MODEL_SUMMARY: string;
  STT_MODEL: string;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OPENROUTER_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  ENCRYPTION_KEY: string;
  /** Vercel sends it as a Bearer token with cron invocations. */
  CRON_SECRET: string;
}

export interface JobQueue {
  /** Runs the job in the background of the current invocation, after an optional delay. */
  send(job: Job, opts?: { delaySeconds?: number }): Promise<void>;
}

export interface Env extends Config {
  db: Db;
  jobs: JobQueue;
}

export const DEFAULT_LLM_MODEL = "google/gemini-2.5-flash";
export const DEFAULT_LLM_MODEL_SUMMARY = "anthropic/claude-sonnet-4.5";
export const DEFAULT_STT_MODEL = "scribe_v1";

const REQUIRED = [
  "OWNER_TELEGRAM_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "OPENROUTER_API_KEY",
  "ELEVENLABS_API_KEY",
  "ENCRYPTION_KEY",
  "CRON_SECRET",
] as const;

export class ConfigError extends Error {}

/** Reads and validates the configuration; lists every missing variable at once. */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const missing: string[] = REQUIRED.filter((k) => !source[k]?.trim());
  const publicUrl =
    source.PUBLIC_URL?.trim() || (source.VERCEL_PROJECT_PRODUCTION_URL ? `https://${source.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  if (!publicUrl) missing.push("PUBLIC_URL");
  if (missing.length) throw new ConfigError(`Missing environment variables: ${missing.join(", ")}`);

  const ownerId = Number(source.OWNER_TELEGRAM_ID);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new ConfigError("OWNER_TELEGRAM_ID must be a numeric Telegram user id");

  const get = (k: (typeof REQUIRED)[number]) => source[k]!.trim();
  return {
    OWNER_TELEGRAM_ID: ownerId,
    PUBLIC_URL: publicUrl.replace(/\/+$/, ""),
    LLM_MODEL: source.LLM_MODEL?.trim() || DEFAULT_LLM_MODEL,
    LLM_MODEL_SUMMARY: source.LLM_MODEL_SUMMARY?.trim() || DEFAULT_LLM_MODEL_SUMMARY,
    STT_MODEL: source.STT_MODEL?.trim() || DEFAULT_STT_MODEL,
    TELEGRAM_BOT_TOKEN: get("TELEGRAM_BOT_TOKEN"),
    TELEGRAM_WEBHOOK_SECRET: get("TELEGRAM_WEBHOOK_SECRET"),
    GOOGLE_CLIENT_ID: get("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: get("GOOGLE_CLIENT_SECRET"),
    OPENROUTER_API_KEY: get("OPENROUTER_API_KEY"),
    ELEVENLABS_API_KEY: get("ELEVENLABS_API_KEY"),
    ENCRYPTION_KEY: get("ENCRYPTION_KEY"),
    CRON_SECRET: get("CRON_SECRET"),
  };
}

export function isOwner(env: Config, tgId: number | undefined): boolean {
  return tgId === env.OWNER_TELEGRAM_ID;
}
