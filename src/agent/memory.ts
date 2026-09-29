import type { Env } from "../env";
import { readAppFile, writeAppFile } from "../google/drive";
import { hasDriveScope, loadOwnerSettings } from "../google/oauth";
import type { ChatMessage } from "../llm/openrouter";
import type { Tool } from "./runner";

/**
 * The conversation memory — n8n's «Window Buffer Memory» (LangChain's buffer window memory), with no database: ONE
 * session per owner, kept in one JSON file, memory.json, in the bot's hidden folder on the owner's Google Drive.
 * The session holds the last N question–answer pairs (the owner picks 20 / 50 / 100 in /settings); a new pair pushes
 * out the oldest, so it never grows past N. Shared by all agents (the mail agent knows who «him» is after a calendar
 * answer). Plus short facts the agents write themselves (remember_fact), which do not age out.
 *
 * The latest SEND pairs of the last MAX_AGE hours reach the model as real chat turns, so a question the bot asked is
 * answered in the next message («Заголовок ТЕСТ» after «Яка назва задачі?»). Old requests are not carried out again:
 * the prompt says so, and a deletion needs the current message to ask for it (calendarTools.deletionAllowed).
 *
 * Without the Drive permission (a grant from before this feature) the same memory lives in the running instance
 * only, as before, and is lost on a restart.
 */

const FILE = "memory.json";
/** Question–answer pairs shown to the model with each request (as chat turns). */
export const SEND = 10;
/** A question the bot asked this recently is still waiting for the owner's answer. */
const PENDING_MS = 30 * 60_000;
/** Older messages are not shown at all (the facts still are). */
const MAX_AGE_MS = 12 * 3600_000;
export const MEMORY_CHOICES = [20, 50, 100];
export const DEFAULT_MEMORY = 100;
const MAX_FACTS = 60;
const MAX_TEXT = 600;

/** One message of the log: when, who (u = owner, b = bot), what, and which agent answered. */
interface Entry {
  t: number;
  who: "u" | "b";
  text: string;
  a?: string;
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

/** Adds one pair (the owner's message and the bot's answer, and the agent that gave it) to the session. */
export async function rememberTurn(env: Env, user: string, bot: string, now = Date.now(), agent?: string): Promise<void> {
  const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);
  const answer: Entry = { t: now, who: "b", text: cut(plain(bot)), ...(agent ? { a: agent } : {}) };
  state.log = [...state.log, { t: now, who: "u" as const, text: cut(user.trim()) }, answer].slice(-2 * (await limit(env)));
  dirty = true;
}

function recent(now: number): Entry[] {
  return state.log.filter((e) => now - e.t < MAX_AGE_MS).slice(-2 * SEND);
}

/** The session's latest pairs as chat turns, oldest first (what the model sees before the current message). */
export function conversationHistory(now = Date.now()): ChatMessage[] {
  const time = (t: number) => new Date(t).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });
  return recent(now).map((e) => (e.who === "u" ? { role: "user", content: `[${time(e.t)}] ${e.text}` } : { role: "assistant", content: e.text }));
}

/** The rule that goes with the history in the system prompt ("" when there is none). */
export function conversationBlock(now = Date.now()): string {
  if (!recent(now).length) return "";
  return (
    "\n\n## ПАМʼЯТЬ РОЗМОВИ\n" +
    "Вище — попередні повідомлення цієї розмови (одна сесія). Останнє повідомлення власника — поточне. " +
    "Якщо ти поставив питання, а власник відповів — продовжуй ту саму дію з його відповіддю (напр. «Заголовок ТЕСТ» — це назва задачі, про яку ти питав). " +
    "Прохання, які ти вже виконав, НЕ виконуй повторно, якщо поточне повідомлення прямо цього не просить."
  );
}

/** The agent whose question is still waiting for the owner's answer (null when the bot asked nothing lately). */
export function pendingAgent(now = Date.now()): string | null {
  const last = state.log.at(-1);
  if (!last || last.who !== "b" || !last.a || now - last.t > PENDING_MS) return null;
  // A question, or a request for details («Надішліть ці дані», «уточніть»).
  return /\?|уточн|надішл|вкаж|напишіть|підтверд|оберіть|назв[уі]|пришлите|укажите/i.test(last.text) ? last.a : null;
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
    messages: Math.floor(state.log.length / 2),
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
