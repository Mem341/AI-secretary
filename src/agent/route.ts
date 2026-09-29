import type { AgentInput } from "./index";

/**
 * The Supervisor's routing table from the n8n prompt ("визнач агента за ключовими словами"), done in code: when a
 * request clearly belongs to one agent, it goes there without a model call. Anything unclear — both topics, small
 * talk, a forwarded chat without keywords — still goes to the Supervisor.
 */
const CALENDAR = [
  /зустр|мітинг|митинг|встреч|созвон|дзвін|звонок|розклад|расписан|календар|calendar|meeting|schedule/,
  /\bmeet\b|\bzoom\b|\bзум\b|гугл міт|google meet/,
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

export function routeByKeywords(input: AgentInput): "calendar_agent" | "gmail_agent" | null {
  // A reply to the bot's own notice names its subject exactly.
  if (input.replyRef?.startsWith("eventId:")) return "calendar_agent";
  if (input.replyRef?.startsWith("messageId:")) return "gmail_agent";
  if (input.inputType === "forward" || input.images?.length) return null;
  const text = input.text.toLowerCase();
  const calendar = matches(CALENDAR, text);
  const mail = matches(MAIL, text);
  if (calendar === mail) return null;
  return calendar ? "calendar_agent" : "gmail_agent";
}
