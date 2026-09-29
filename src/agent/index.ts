import { loadDirectory } from "../bot/contacts";
import { loadOwner } from "../bot/owner";
import { bitrixConfigured, type Env } from "../env";
import { connectLink, hasGmailScope, hasGoogleAuth } from "../google/oauth";
import type { ContentPart } from "../llm/openrouter";
import { HttpError } from "../lib/http";
import { esc, Telegram } from "../telegram/api";
import { calendarTools } from "./calendarTools";
import { gmailTools } from "./gmailTools";
import { toTelegramHtml } from "./html";
import { history, remember } from "./memory";
import { bitrixPrompt, calendarPrompt, gmailPrompt, supervisorPrompt } from "./prompts";
import { bitrixTools } from "./bitrixTools";
import { routeByKeywords } from "./route";
import { ModelError, runAgent, str, type Tool } from "./runner";

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

type AgentName = "calendar_agent" | "gmail_agent" | "bitrix_agent";

/** One sub-agent (n8n "Calendar Agent" / "Gmail Agent" sub-workflow) on the user's message, with its own memory. */
/** One request's run: the model for it, and whether a tool already changed something (then it is never retried). */
export interface RunContext {
  model: string;
  wrote: boolean;
}

/** Tools that only read; any other tool call changes the calendar or the mailbox. */
const READ_ONLY = /^(get_|check_free_busy|msg_get|thread_get|draft_get|label_get|find_|list_tasks|task_stats)/;

function tracking(ctx: RunContext) {
  return (name: string) => {
    if (!READ_ONLY.test(name)) ctx.wrote = true;
  };
}

/**
 * Which model serves a request: pictures → VISION_MODEL (sees images), voice → LLM_MODEL (spoken requests are
 * messy), plain text → AGENT_MODEL (cheap). LLM_MODEL is also the second try when the cheap one fails.
 */
export function modelFor(env: Env, input: AgentInput): string {
  if (input.images?.length) return env.VISION_MODEL;
  if (input.inputType === "voice") return env.LLM_MODEL;
  return env.AGENT_MODEL;
}

async function runSubAgent(env: Env, name: AgentName, userMessage: string, input: AgentInput, now: Date, ctx: RunContext): Promise<string> {
  if (name === "bitrix_agent") {
    if (!bitrixConfigured(env)) return "Bitrix24 не підключено (потрібен вхідний вебхук Bitrix24 у змінній BITRIX_WEBHOOK_URL).";
    const memoryKey = `${name}:${input.chatId}`;
    const answer = await runAgent(env, {
      model: ctx.model,
      onTool: tracking(ctx),
      system: bitrixPrompt(await loadOwner(env), now),
      history: history(memoryKey),
      input: withImages(userMessage, input.images),
      tools: bitrixTools(env),
      maxIterations: 12,
    });
    remember(memoryKey, userMessage, answer);
    return answer;
  }
  if (!(await hasGoogleAuth(env))) return `Google не підключено. Нехай власник натисне /start → «Підключити Google»: ${await connectLink(env)}`;
  if (name === "gmail_agent" && !(await hasGmailScope(env))) {
    return `Немає доступу до Gmail. Нехай власник перепідключить Google (/settings) і поставить галочки для пошти: ${await connectLink(env)}`;
  }
  const memoryKey = `${name}:${input.chatId}`;
  const owner = await loadOwner(env);
  const answer =
    name === "calendar_agent"
      ? await runAgent(env, {
          model: ctx.model,
          onTool: tracking(ctx),
          system: calendarPrompt(owner, await loadDirectory(env), now),
          history: history(memoryKey),
          input: withImages(userMessage, input.images),
          tools: calendarTools(env, owner.email),
          maxIterations: 10,
        })
      : await runAgent(env, {
          model: ctx.model,
          onTool: tracking(ctx),
          system: gmailPrompt(),
          history: history(memoryKey),
          input: withImages(userMessage, input.images),
          tools: gmailTools(env),
          maxIterations: 10,
        });
  remember(memoryKey, userMessage, answer);
  return answer;
}

/** n8n sub-workflows cut the session block off and keep the user's message (with the reply context). */
function userMessageOf(chatInput: string): string {
  return chatInput.split("\n\n---SESSION---")[0]!.replace("USER: ", "").trim();
}

export async function runSupervisor(env: Env, input: AgentInput, ctx: RunContext, now = new Date()): Promise<string> {
  const chatInput = buildChatInput(input);
  const key = String(input.chatId);

  // Plain code first: an obvious calendar or mail request goes straight to its agent (the Supervisor would only
  // pass it on and repeat the answer — two model calls for nothing).
  const direct = routeByKeywords(input, bitrixConfigured(env));
  if (direct) {
    const output = await runSubAgent(env, direct, userMessageOf(chatInput), input, now, ctx);
    remember(`supervisor:${key}`, chatInput, output);
    return output;
  }

  const subAgent = (name: AgentName, description: string): Tool => ({
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
      return runSubAgent(env, name, userMessageOf(str(args, "prompt") || chatInput), input, now, ctx);
    },
  });

  const output = await runAgent(env, {
    model: ctx.model,
    system: supervisorPrompt(bitrixConfigured(env)),
    history: history(`supervisor:${key}`),
    input: withImages(chatInput, input.images),
    tools: [
      subAgent(
        "calendar_agent",
        "Calendar Agent — manages Google Calendar: create/update/delete events, check schedule, RSVP, reschedule, manage attendees. Supports Google Meet and Zoom. Call this tool for any calendar-related requests.",
      ),
      subAgent("gmail_agent", "Gmail Agent — search, read, send, reply, delete, label emails. Call with the user's full request about email."),
      ...(bitrixConfigured(env)
        ? [
            subAgent(
              "bitrix_agent",
              "Bitrix24 Task Agent — the owner's tasks: list, read, analyse (incl. status from comments), add comments, create tasks with people. Cannot close or change tasks.",
            ),
          ]
        : []),
    ],
    maxIterations: 15,
    temperature: 0.2,
  });
  remember(`supervisor:${key}`, chatInput, output);
  return output;
}

/**
 * ✅ Прийняти / ❌ Відхилити under an invitation: the n8n Calendar Agent's rule ("accept:{eventId} → RSVP tool") done
 * in code — same tool, same answer, no model call.
 */
async function answerInvitation(env: Env, accept: boolean, eventId: string): Promise<string> {
  if (!(await hasGoogleAuth(env))) return `Google не підключено: ${await connectLink(env)}`;
  const owner = await loadOwner(env);
  const tool = calendarTools(env, owner.email).find((t) => t.spec.name === "rsvp_event")!;
  await tool.run({ eventId, responseStatus: accept ? "accepted" : "declined" });
  return accept ? "✅ Зустріч підтверджена!" : "❌ Зустріч відхилена!";
}

/**
 * Runs the request on its model; if that model fails before changing anything, the same request goes to the strong
 * LLM_MODEL. After a change (an event created, an email sent) it is never repeated — that could duplicate it.
 */
export async function runWithFallback(env: Env, input: AgentInput): Promise<string> {
  const ctx: RunContext = { model: modelFor(env, input), wrote: false };
  try {
    return await runSupervisor(env, input, ctx);
  } catch (err) {
    if (!(err instanceof ModelError) || ctx.wrote || ctx.model === env.LLM_MODEL) throw err;
    console.warn(`agent: ${err.message}; retrying on ${env.LLM_MODEL}`);
    return runSupervisor(env, input, { model: env.LLM_MODEL, wrote: false });
  }
}

/** The whole flow for one update: run the agents, reply, and settle a pressed button. */
export async function handleWithAgents(env: Env, input: AgentInput): Promise<void> {
  const tg = new Telegram(env);
  const rsvp = /^(accept|decline):(.+)$/.exec(input.callbackData ?? "");
  const output = rsvp ? await answerInvitation(env, rsvp[1] === "accept", rsvp[2]!) : await runWithFallback(env, input);
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
