import { loadDirectory } from "../bot/contacts";
import { loadOwner } from "../bot/owner";
import type { Env } from "../env";
import { connectLink, hasGmailScope, hasGoogleAuth } from "../google/oauth";
import type { ContentPart } from "../llm/openrouter";
import { HttpError } from "../lib/http";
import { esc, Telegram } from "../telegram/api";
import { calendarTools } from "./calendarTools";
import { gmailTools } from "./gmailTools";
import { toTelegramHtml } from "./html";
import { history, remember } from "./memory";
import { calendarPrompt, gmailPrompt, supervisorPrompt } from "./prompts";
import { runAgent, str, thinkTool, type Tool } from "./runner";

/**
 * The n8n "AI Agent ALL" flow: Normalize Input → Build Agent Context → 🧠 Supervisor (with the Calendar Agent and
 * the Gmail Agent as tools) → Parse Agent Output → reply in Telegram (and, for a button, answer it and remove the
 * buttons).
 */
export interface AgentInput {
  chatId: number;
  inputType: "text" | "voice" | "photo" | "document" | "callback" | "forward";
  text: string;
  /** Text of the bot message the owner replied to, or of the message with the pressed button. */
  replyText?: string | null;
  /** What that bot message is about ("eventId: …" / "messageId: …"), read from its hidden data. */
  replyRef?: string | null;
  callbackData?: string | null;
  callbackId?: string | null;
  /** Message with the pressed button (its buttons are removed afterwards). */
  callbackMessageId?: number | null;
  /** Photos / image documents, for the model to see. */
  images?: ContentPart[];
}

/** n8n "Build Agent Context": reply context before the text, the session block after it. */
export function buildChatInput(input: AgentInput): string {
  let chatInput = "";
  if (input.replyText || input.replyRef) {
    const ref = input.replyRef ? `\n[${input.replyRef}]` : "";
    chatInput += `---REPLY_TO_BOT_MESSAGE---\n${(input.replyText ?? "").substring(0, 500)}${ref}\n---END_REPLY---\n\n`;
  }
  chatInput += `USER: ${input.text}`;
  chatInput += `\n\n---SESSION---\ncurrentFlow: idle\ninputType: ${input.inputType}\nchatId: ${input.chatId}`;
  if (input.callbackData) chatInput += `\ncallbackData: ${input.callbackData}`;
  if (input.images?.length) chatInput += `\nhasMedia: true`;
  return chatInput;
}

function withImages(text: string, images: ContentPart[] | undefined): string | ContentPart[] {
  return images?.length ? [{ type: "text", text }, ...images] : text;
}

export async function runSupervisor(env: Env, input: AgentInput, now = new Date()): Promise<string> {
  const chatInput = buildChatInput(input);
  const key = String(input.chatId);

  const subAgent = (name: "calendar_agent" | "gmail_agent", description: string): Tool => ({
    spec: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { prompt: { type: "string", description: "The user's full request: user message + reply context + session + callback, unchanged." } },
        required: ["prompt"],
      },
    },
    async run(args) {
      const prompt = str(args, "prompt") || chatInput;
      // n8n sub-workflows cut the session block off and keep the user's message.
      const userMessage = prompt.split("\n\n---SESSION---")[0]!.replace("USER: ", "").trim();
      if (!(await hasGoogleAuth(env))) return `Google не підключено. Нехай власник натисне /start → «Підключити Google»: ${await connectLink(env)}`;
      if (name === "gmail_agent" && !(await hasGmailScope(env))) {
        return `Немає доступу до Gmail. Нехай власник перепідключить Google (/settings) і поставить галочки для пошти: ${await connectLink(env)}`;
      }
      const memoryKey = `${name}:${key}`;
      const owner = await loadOwner(env);
      const answer =
        name === "calendar_agent"
          ? await runAgent(env, {
              model: env.AGENT_MODEL,
              system: calendarPrompt(owner, await loadDirectory(env), now),
              history: history(memoryKey),
              input: withImages(userMessage, input.images),
              tools: calendarTools(env, owner.email),
              maxIterations: 10,
            })
          : await runAgent(env, {
              model: env.AGENT_MODEL,
              system: gmailPrompt(),
              history: history(memoryKey),
              input: withImages(userMessage, input.images),
              tools: gmailTools(env),
              maxIterations: 10,
            });
      remember(memoryKey, userMessage, answer);
      return answer;
    },
  });

  const output = await runAgent(env, {
    model: env.LLM_MODEL,
    system: supervisorPrompt(),
    history: history(`supervisor:${key}`),
    input: withImages(chatInput, input.images),
    tools: [
      subAgent(
        "calendar_agent",
        "Calendar Agent — manages Google Calendar: create/update/delete events, check schedule, RSVP, reschedule, manage attendees. Supports Google Meet and Zoom. Call this tool for any calendar-related requests.",
      ),
      subAgent("gmail_agent", "Gmail Agent — search, read, send, reply, delete, label emails. Call with the user's full request about email."),
      thinkTool,
    ],
    maxIterations: 15,
    temperature: 0.2,
  });
  remember(`supervisor:${key}`, chatInput, output);
  return output;
}

/** The whole flow for one update: run the agents, reply, and settle a pressed button. */
export async function handleWithAgents(env: Env, input: AgentInput): Promise<void> {
  const tg = new Telegram(env);
  const output = await runSupervisor(env, input);
  const html = toTelegramHtml(output);
  await tg.send(input.chatId, html).catch(async (err) => {
    // Telegram rejected the markup (e.g. a broken link): the same answer as plain text.
    if (!(err instanceof HttpError && err.status === 400)) throw err;
    const plain = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    await tg.send(input.chatId, esc(plain));
  });
  if (input.callbackId) {
    await tg.call("answerCallbackQuery", { callback_query_id: input.callbackId, text: "✅" }).catch(() => undefined);
    if (input.callbackMessageId) {
      await tg
        .call("editMessageReplyMarkup", { chat_id: input.chatId, message_id: input.callbackMessageId, reply_markup: { inline_keyboard: [] } })
        .catch(() => undefined);
    }
  }
}
