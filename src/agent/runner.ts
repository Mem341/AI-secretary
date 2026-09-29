import type { Env } from "../env";
import { GoogleAuthRevokedError } from "../google/oauth";
import { type AgentMessage, type ChatMessage, chatWithTools, type ContentPart, type TokenUsage, type ToolSpec } from "../llm/openrouter";

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
  /** Called before each tool call (used to know whether anything was changed). */
  onTool?(name: string): void;
  /** Called with each model call's token usage (the model comparison script adds them up). */
  onUsage?(usage: TokenUsage): void;
}

/** The model failed (API error, or no answer within maxIterations): the caller may retry on a stronger model. */
export class ModelError extends Error {}

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
    const turn = await chatWithTools(env, run.model, messages, run.tools.map((t) => t.spec), run.temperature).catch((err: unknown) => {
      throw new ModelError(`${run.model}: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (turn.usage) run.onUsage?.(turn.usage);
    last = turn.content;
    if (!turn.toolCalls.length) return turn.content;
    messages.push({ role: "assistant", content: turn.content || null, tool_calls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      let result: unknown;
      const tool = byName.get(call.function.name);
      try {
        if (!tool) throw new Error(`Unknown tool ${call.function.name}`);
        const args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        run.onTool?.(call.function.name);
        result = await tool.run(args);
      } catch (err) {
        // A revoked Google grant ends the run: the owner is asked to reconnect (jobs.ts). A nested agent's model
        // failure ends it too, so the whole request can be retried on the stronger model.
        if (err instanceof GoogleAuthRevokedError || err instanceof ModelError) throw err;
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      const text = typeof result === "string" ? result : JSON.stringify(result ?? { ok: true });
      messages.push({ role: "tool", tool_call_id: call.id, content: text.slice(0, MAX_TOOL_RESULT) });
    }
  }
  if (last) return last;
  throw new ModelError(`${run.model}: no answer after ${run.maxIterations} steps`);
}

/** A string argument, or "" (models sometimes omit optional ones). */
export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}
