import type { Env } from "../env";
import { readAppFile, writeAppFile } from "../google/drive";
import { hasDriveScope, loadOwnerSettings } from "../google/oauth";
import type { ChatMessage } from "../llm/openrouter";
import type { Tool } from "./runner";

/**
 * The conversation memory (the n8n chat memory), with no database: one JSON file, memory.json, in the bot's hidden
 * folder on the owner's Google Drive. Each agent (supervisor, calendar, mail, tasks) has its own thread of the last
 * N messages (the owner picks 20 / 50 / 100 in /settings): a new message pushes out the oldest. Only the latest
 * SEND messages go to the model, so answers stay fast and cheap; what matters for longer is kept as short facts the
 * agents write themselves (remember_fact), which do not age out with the thread.
 *
 * Without the Drive permission (a grant from before this feature) the same memory lives in the running instance
 * only, as before, and is lost on a restart.
 */

const FILE = "memory.json";
/** Messages of a thread sent to the model with each request. */
export const SEND = 24;
export const MEMORY_CHOICES = [20, 50, 100];
export const DEFAULT_MEMORY = 100;
const MAX_FACTS = 60;
const MAX_TEXT = 2000;

interface MemoryFile {
  v: 1;
  threads: Record<string, ChatMessage[]>;
  facts: string[];
}

const empty = (): MemoryFile => ({ v: 1, threads: {}, facts: [] });

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
    const file = await readAppFile<MemoryFile>(env, FILE);
    state = file?.v === 1 ? { v: 1, threads: file.threads ?? {}, facts: file.facts ?? [] } : empty();
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

/** The latest messages of a thread, for the model. */
export function history(key: string): ChatMessage[] {
  return (state.threads[key] ?? []).slice(-SEND);
}

export async function remember(env: Env, key: string, user: string, assistant: string): Promise<void> {
  const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);
  const thread = [...(state.threads[key] ?? []), { role: "user", content: cut(user) } as ChatMessage, { role: "assistant", content: cut(assistant) } as ChatMessage];
  state.threads[key] = thread.slice(-(await limit(env)));
  dirty = true;
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
  state.threads = {};
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
    messages: Object.values(state.threads).reduce((n, t) => n + t.length, 0),
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
