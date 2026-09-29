import type { Env } from "../env";
import { GoogleAuthRevokedError } from "../google/oauth";
import { type AgentMessage, type ChatMessage, chatWithTools, type ContentPart, type ToolSpec } from "../llm/openrouter";

/** A tool an agent may call (an n8n "…Tool" node). */
export interface Tool {
  spec: ToolSpec;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentRun {
  model: string;
  system: string;
  /** Earlier turns of this chat (the n8n chat memory). */
  history: ChatMessage[];
  input: string | ContentPart[];
  tools: Tool[];
  maxIterations: number;
  temperature?: number;
}

const MAX_TOOL_RESULT = 12_000;

/**
 * The n8n AI Agent loop: the model answers or calls tools; tool results go back to it until it answers.
 * A failing tool returns its error to the model instead of aborting, as n8n does.
 */
export async function runAgent(env: Env, run: AgentRun): Promise<string> {
  const byName = new Map(run.tools.map((t) => [t.spec.name, t]));
  const messages: AgentMessage[] = [{ role: "system", content: run.system }, ...run.history, { role: "user", content: run.input }];
  let last = "";
  for (let i = 0; i < run.maxIterations; i++) {
    const turn = await chatWithTools(env, run.model, messages, run.tools.map((t) => t.spec), run.temperature);
    last = turn.content;
    if (!turn.toolCalls.length) return turn.content;
    messages.push({ role: "assistant", content: turn.content || null, tool_calls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      let result: unknown;
      const tool = byName.get(call.function.name);
      try {
        if (!tool) throw new Error(`Unknown tool ${call.function.name}`);
        const args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        result = await tool.run(args);
      } catch (err) {
        // A revoked Google grant ends the run: the owner is asked to reconnect (jobs.ts).
        if (err instanceof GoogleAuthRevokedError) throw err;
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      const text = typeof result === "string" ? result : JSON.stringify(result ?? { ok: true });
      messages.push({ role: "tool", tool_call_id: call.id, content: text.slice(0, MAX_TOOL_RESULT) });
    }
  }
  return last || "Не вдалося завершити запит — спробуйте сформулювати простіше.";
}

/** n8n "Think" tool: lets the model write down its reasoning; changes nothing. */
export const thinkTool: Tool = {
  spec: {
    name: "think",
    description: "Use the tool to think about something. It will not obtain new information or change anything, just append the thought to the log.",
    parameters: { type: "object", properties: { thought: { type: "string", description: "A thought to think about." } }, required: ["thought"] },
  },
  async run() {
    return "ok";
  },
};

/** A string argument, or "" (models sometimes omit optional ones). */
export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}
