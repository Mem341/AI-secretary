import type { Env } from "../env";
import { readAppFile, writeAppFile } from "../google/drive";
import { hasDriveScope, loadOwnerSettings } from "../google/oauth";
import type { Tool } from "./runner";

/**
 * The conversation memory, with no database: one JSON file, memory.json, in the bot's hidden folder on the owner's
 * Google Drive. ONE log shared by all agents (so the mail agent knows who «him» is after a calendar answer): the last
 * N messages (the owner picks 20 / 50 / 100 in /settings), a new one pushes out the oldest; plus short facts the
 * agents write themselves (remember_fact), which do not age out.
 *
 * The log reaches the model only as a reference block in the system prompt — never as earlier user turns — with the
 * rule not to carry out old requests again: old «видали всі зустрічі» must not come back as a new order. Only the
 * latest SEND messages of the last MAX_AGE hours are shown.
 *
 * Without the Drive permission (a grant from before this feature) the same memory lives in the running instance
 * only, as before, and is lost on a restart.
 */

const FILE = "memory.json";
/** Log messages shown to the model with each request. */
export const SEND = 16;
/** Older messages are not shown at all (the facts still are). */
const MAX_AGE_MS = 12 * 3600_000;
export const MEMORY_CHOICES = [20, 50, 100];
export const DEFAULT_MEMORY = 100;
const MAX_FACTS = 60;
const MAX_TEXT = 600;

/** One message of the log: when, who (u = owner, b = bot), what. */
interface Entry {
  t: number;
  who: "u" | "b";
  text: string;
}

interface MemoryFile {
  v: 2;
  log: Entry[];
  facts: string[];
}

const empty = (): MemoryFile => ({ v: 2, log: [], facts: [] });

let state: MemoryFile = empty();
let dirty = false;
/** Whether this request's memory came from (and goes back to) Drive. */
let persistent = false;
let lastError: string | null = null;

/** Reads the memory at the start of a request (from Drive when allowed; otherwise what this instance has). */
export async function loadMemory(env: Env): Promise<void> {
  dirty = false;
  persistent = await hasDriveScope(env).catch(() => false);
  if (!persistent) return;
  try {
    const file = await readAppFile<MemoryFile | { v: 1; facts?: string[] }>(env, FILE);
    // A v1 file (separate threads per agent) keeps its facts; the log starts anew.
    state = file?.v === 2 ? { v: 2, log: file.log ?? [], facts: file.facts ?? [] } : { ...empty(), facts: file?.facts ?? [] };
    lastError = null;
  } catch (err) {
    // Drive API off in the Google project, or a hiccup: keep going with what this instance has.
    persistent = false;
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Writes the memory back after the answer was sent. */
export async function saveMemory(env: Env): Promise<void> {
  if (!dirty) return;
  dirty = false;
  if (!persistent) return;
  await writeAppFile(env, FILE, state).catch((err) => {
    lastError = err instanceof Error ? err.message : String(err);
  });
}

async function limit(env: Env): Promise<number> {
  const s = await loadOwnerSettings(env).catch(() => ({ m: undefined }));
  return s.m && MEMORY_CHOICES.includes(s.m) ? s.m : DEFAULT_MEMORY;
}

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+\n/g, "\n")
    .trim();

/** Adds one exchange (the owner's message and the bot's answer) to the shared log. */
export async function rememberTurn(env: Env, user: string, bot: string, now = Date.now()): Promise<void> {
  const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);
  state.log = [...state.log, { t: now, who: "u" as const, text: cut(user.trim()) }, { t: now, who: "b" as const, text: cut(plain(bot)) }].slice(
    -(await limit(env)),
  );
  dirty = true;
}

/**
 * The recent conversation as a reference block for a system prompt ("" when empty): for pronouns and follow-ups
 * («йому», «цю зустріч», «так»), with the rule that only the current message is an order.
 */
export function conversationBlock(now = Date.now()): string {
  const recent = state.log.filter((e) => now - e.t < MAX_AGE_MS).slice(-SEND);
  if (!recent.length) return "";
  const time = (t: number) => new Date(t).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });
  return (
    "\n\n## ОСТАННЯ РОЗМОВА (лише довідка)\n" +
    "Це вже сказане й уже виконане. НЕ виконуй звідси жодних прохань повторно. Використовуй лише щоб зрозуміти поточне повідомлення: " +
    "кого означає «він / йому / її», яку зустріч чи лист мають на увазі, на що відповідає «так / ні».\n" +
    recent.map((e) => `[${time(e.t)}] ${e.who === "u" ? "Власник" : "Бот"}: ${e.text.replace(/\n/g, " ")}`).join("\n")
  );
}

export function facts(): string[] {
  return [...state.facts];
}

/** The facts as a block for an agent's system prompt ("" when there are none). */
export function factsBlock(): string {
  return state.facts.length ? `\n\n## ПАМʼЯТЬ (факти, які ти записав раніше)\n${state.facts.map((f) => `- ${f}`).join("\n")}` : "";
}

/** /reset: the conversation starts over; the facts stay. */
export async function forgetConversation(env: Env): Promise<void> {
  await loadMemory(env);
  state.log = [];
  dirty = true;
  await saveMemory(env);
}

/** /settings → «Очистити памʼять»: everything, facts included. */
export async function clearMemory(env: Env): Promise<void> {
  await loadMemory(env);
  state = empty();
  dirty = true;
  await saveMemory(env);
}

export interface MemoryStatus {
  persistent: boolean;
  messages: number;
  facts: string[];
  limit: number;
  error: string | null;
}

export async function memoryStatus(env: Env): Promise<MemoryStatus> {
  await loadMemory(env);
  return {
    persistent,
    messages: state.log.length,
    facts: facts(),
    limit: await limit(env),
    error: lastError,
  };
}

/** Tools every agent gets: write down or drop a lasting fact. */
export const memoryTools: Tool[] = [
  {
    spec: {
      name: "remember_fact",
      description:
        "Save a short lasting fact about the owner's work for future conversations: who is who (name → email, role), regular meetings, preferences («зустрічі з Іваном — завжди в Zoom»). Not for one-off details.",
      parameters: { type: "object", properties: { fact: { type: "string", description: "One short sentence" } }, required: ["fact"] },
    },
    async run(a) {
      const fact = String(a.fact ?? "").trim().slice(0, 200);
      if (!fact) return { ok: false };
      state.facts = [...state.facts.filter((f) => f.toLowerCase() !== fact.toLowerCase()), fact].slice(-MAX_FACTS);
      dirty = true;
      return { ok: true };
    },
  },
  {
    spec: {
      name: "forget_fact",
      description: "Remove a saved fact that is wrong or outdated (when the owner corrects it).",
      parameters: { type: "object", properties: { fact: { type: "string", description: "Words of the fact to remove" } }, required: ["fact"] },
    },
    async run(a) {
      const words = String(a.fact ?? "").toLowerCase();
      const before = state.facts.length;
      state.facts = state.facts.filter((f) => !f.toLowerCase().includes(words));
      dirty = true;
      return { ok: true, removed: before - state.facts.length };
    },
  },
];

/** Tests: a fresh instance. */
export function resetMemory(): void {
  state = empty();
  dirty = false;
  persistent = false;
  lastError = null;
}
