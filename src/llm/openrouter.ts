import type { Env } from "../env";
import { expectOk, fetchWithRetry } from "../lib/http";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** Extracts a JSON object from a model reply, tolerating ```json fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error(`LLM reply is not JSON: ${text.slice(0, 200)}`);
  }
}

async function complete(env: Env, body: Record<string, unknown>): Promise<string> {
  const res = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "HTTP-Referer": env.PUBLIC_URL,
      "X-Title": "AI-secretary",
    },
    body: JSON.stringify(body),
  });
  await expectOk("openrouter", res);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message: string } };
  if (data.error) throw new Error(`openrouter: ${data.error.message}`);
  return data.choices?.[0]?.message?.content ?? "";
}

/** Calls an OpenRouter chat model and returns its plain-text reply. */
export async function chatText(env: Env, model: string, messages: ChatMessage[]): Promise<string> {
  return complete(env, { model, messages, temperature: 0 });
}

/**
 * Calls an OpenRouter chat model and parses a JSON object reply. The model is configurable through
 * LLM_MODEL / LLM_MODEL_SUMMARY (spec section 3). One extra attempt is made when the reply is not valid JSON.
 */
export async function chatJson(env: Env, model: string, messages: ChatMessage[]): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await complete(env, { model, messages, temperature: 0, response_format: { type: "json_object" } });
    try {
      return extractJson(content);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
