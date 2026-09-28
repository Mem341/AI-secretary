import type { Job } from "./jobs";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  JOBS: Queue<Job>;

  PUBLIC_URL: string;
  ADMIN_TG_IDS: string;
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
}

export function adminIds(env: Env): number[] {
  return env.ADMIN_TG_IDS.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

export function isAdmin(env: Env, tgId: number): boolean {
  return adminIds(env).includes(tgId);
}
