import type { AgentInput } from "./index";

/**
 * The Supervisor's routing table from the n8n prompt ("визнач агента за ключовими словами"), done in code: when a
 * request clearly belongs to one agent, it goes there without a model call. Anything unclear — both topics, small
 * talk, a forwarded chat without keywords — still goes to the Supervisor.
 */
const CALENDAR = [
  /зустр|мітинг|митинг|встреч|созвон|дзвін|звонок|розклад|расписан|календар|calendar|meeting|schedule/,
  /\bmeet\b|\bzoom\b|(^|\s)зум|гугл міт|google meet/,
  /перенес|скасу|отмен|відмін|rsvp/,
  /сьогодні|сегодня|завтра|післязавтра|послезавтра|понеділ|понедел|вівтор|вторник|серед|четвер|пʼятниц|п'ятниц|пятниц|субот|неділ|воскресен/,
  /вільн|свобод|зайнят|занят|подія|подію|події|событи/,
];
const MAIL = [
  /пошт|почт|лист|письм|e-?mail|\bmail|gmail|inbox|вхідн|входящ/,
  /чернет|черновик|draft|мітк|метк|label|спам|spam/,
  /напиши|відправ|отправ|надішли|пришли|відпиши|ответь на/,
];

const matches = (patterns: RegExp[], text: string) => patterns.some((p) => p.test(text));

const TASKS = [
  /задач|задан|таск|\btask|бітрікс|битрикс|bitrix|б24|b24|дедлайн|доручен|поручен|доручи|поручи|прострочен|просрочен/,
  /спостеріга|спостерега|наблюдател|співвиконав|соисполнит|постановник|виконавц|исполнител|чат задач|по задач/,
];

/**
 * The words that surely start a new request of that kind: a meeting, an email. Dates («післязавтра») and «напиши»
 * are not among them — they also come in the answer to the bot's question about a task.
 */
const SURE: Record<"calendar_agent" | "gmail_agent" | "bitrix_agent", RegExp[]> = {
  calendar_agent: CALENDAR.slice(0, 3),
  gmail_agent: MAIL.slice(0, 2),
  bitrix_agent: TASKS,
};

/**
 * Where the owner's answer goes while an agent waits for it (it asked a question): back to that agent, unless the
 * message is plainly a new request for another one.
 */
export function routeFollowUp(input: AgentInput, waiting: "calendar_agent" | "gmail_agent" | "bitrix_agent", bitrix = false): "calendar_agent" | "gmail_agent" | "bitrix_agent" | null {
  const other = routeByKeywords(input, bitrix);
  if (!other || other === waiting) return waiting;
  return matches(SURE[other], input.text.toLowerCase()) && !matches(SURE[waiting], input.text.toLowerCase()) ? other : waiting;
}

export function routeByKeywords(input: AgentInput, bitrix = false): "calendar_agent" | "gmail_agent" | "bitrix_agent" | null {
  // A reply to the bot's own notice names its subject exactly.
  if (input.replyRef?.startsWith("eventId:")) return "calendar_agent";
  if (input.replyRef?.startsWith("messageId:")) return "gmail_agent";
  if (input.replyRef?.startsWith("taskId:")) return bitrix ? "bitrix_agent" : null;
  if (input.inputType === "forward" || input.images?.length) return null;
  const text = input.text.toLowerCase();
  // A task is often about a day ("задача на завтра") or a person to write to: task words decide first.
  if (bitrix && matches(TASKS, text)) return matches(MAIL.slice(0, 1), text) ? null : "bitrix_agent";
  const calendar = matches(CALENDAR, text);
  const mail = matches(MAIL, text);
  if (calendar === mail) return null;
  return calendar ? "calendar_agent" : "gmail_agent";
}
