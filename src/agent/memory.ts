import type { ChatMessage } from "../llm/openrouter";

/**
 * The n8n chat memory (Window Buffer / MongoDB), kept in the running instance only — there is no database. Replies
 * to the bot's messages carry their text as context, so a lost memory rarely matters. Expires on its own.
 */
const WINDOW = 30;
const TTL_MS = 12 * 3600_000;
const memories = new Map<string, { messages: ChatMessage[]; at: number }>();

export function history(key: string): ChatMessage[] {
  const m = memories.get(key);
  if (!m || Date.now() - m.at > TTL_MS) {
    memories.delete(key);
    return [];
  }
  return m.messages;
}

export function remember(key: string, user: string, assistant: string): void {
  const messages = [...history(key), { role: "user", content: user } as ChatMessage, { role: "assistant", content: assistant } as ChatMessage];
  memories.set(key, { messages: messages.slice(-WINDOW), at: Date.now() });
}

export function forget(prefix: string): void {
  for (const key of memories.keys()) if (key.startsWith(prefix)) memories.delete(key);
}

export function resetMemory(): void {
  memories.clear();
}
