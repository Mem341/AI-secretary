import { Bitrix } from "../bitrix/client";
import { isOverdue } from "../bitrix/format";
import { bitrixConfigured, type Env } from "../env";
import { chatText } from "../llm/openrouter";
import { DAY, formatDay, formatRange, formatTime, kyivLocalToDate, kyivParts, MINUTE, toKyivDate } from "../lib/time";
import { esc, Telegram } from "../telegram/api";
import type { InlineKeyboard } from "../telegram/types";
import { Calendar, type GEvent } from "./calendar";
import { Gmail } from "./gmail";
import { hasGmailScope, loadOwnerSettings, type OwnerSettings } from "./oauth";
import { DIGEST_PREFIX, type Signal } from "./signals";
import { eventToChange, type Meeting } from "./sync";

/**
 * The morning report (/settings → ☀️): today's meetings with guests, links, overlaps and free windows, always; and the
 * blocks the owner ticks — invitations waiting for an answer (with ✅ / ❌), unread mail, a short AI summary of it,
 * Bitrix24 deadlines, tomorrow's first meeting, a report on a day without meetings. Sent at the owner's time: Google
 * wakes the bot with a signal in the bot's calendar (as for reminders), else the daily cron.
 */

/** Report times offered, minutes after midnight (Kyiv). */
export const DIGEST_TIMES = [420, 450, 480, 510, 540, 600];
const DEFAULT_TIME = 480;

export const DIGEST_BLOCKS = {
  inv: "📨 Запрошення без відповіді",
  mail: "📧 Непрочитана пошта",
  ai: "✨ Коротко про пошту (AI)",
  bx: "📋 Задачі Bitrix24",
  tmr: "🌅 Завтра: перша зустріч",
  empty: "📭 Звіт і в день без зустрічей",
} as const;
export type DigestBlock = keyof typeof DIGEST_BLOCKS;
/** On until the owner changes them; «AI» and «a day without meetings» are opt-in. */
const DEFAULT_BLOCKS: DigestBlock[] = ["inv", "mail", "bx", "tmr"];

export interface DigestChoice {
  on: boolean;
  time: number;
  blocks: DigestBlock[];
}

export function digestChoice(s: OwnerSettings): DigestChoice {
  return { on: s.d ?? true, time: s.dg?.t ?? DEFAULT_TIME, blocks: (s.dg?.b as DigestBlock[] | undefined) ?? DEFAULT_BLOCKS };
}

export async function loadDigestChoice(env: Env): Promise<DigestChoice> {
  return digestChoice(await loadOwnerSettings(env).catch((): OwnerSettings => ({})));
}

/** Whether Google wakes the bot for the report (the Gmail push works and the signal calendar exists). */
export async function digestByGoogle(env: Env): Promise<boolean> {
  const s = await loadOwnerSettings(env).catch((): OwnerSettings => ({}));
  return s.p === "ok" && !!s.sc;
}

export const timeText = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

/** The report's signals for today and tomorrow at the chosen time (one email each, at the minute itself). */
export function digestSignals(choice: DigestChoice, now = Date.now()): Signal[] {
  if (!choice.on) return [];
  const out: Signal[] = [];
  for (const offset of [0, 1]) {
    const p = kyivParts(new Date(now + offset * DAY));
    const start = kyivLocalToDate(p.year, p.month, p.day, Math.floor(choice.time / 60), choice.time % 60).getTime();
    // Kept an hour after its time: its email may still be on the way.
    if (start < now - 60 * MINUTE) continue;
    out.push({ key: `${DIGEST_PREFIX}${toKyivDate(new Date(start))}`, summary: "☀️ Ранковий звіт", start, end: start + 5 * MINUTE, minutes: [0] });
  }
  return out;
}

const names = (m: Meeting) => {
  const all = m.attendees.map((a) => a.name ?? a.email.split("@")[0]!);
  return all.length > 4 ? `${all.slice(0, 4).join(", ")} +${all.length - 4}` : all.join(", ");
};

/** Today's meetings: time, title, guests, link or place, overlaps; then the free windows between them. */
export function meetingsBlock(meetings: Meeting[]): string[] {
  const lines = [`📅 <b>Зустрічі (${meetings.length}):</b>`];
  let busyUntil = 0;
  let busyWith = "";
  const free: string[] = [];
  for (const m of meetings) {
    if (busyUntil && m.start_at - busyUntil >= 30 * MINUTE) free.push(`${formatTime(new Date(busyUntil))}–${formatTime(new Date(m.start_at))}`);
    lines.push(`• <b>${formatTime(new Date(m.start_at))}–${formatTime(new Date(m.end_at))}</b> ${esc(m.title ?? "без назви")}`);
    if (m.attendees.length) lines.push(`   👥 ${esc(names(m))}`);
    if (m.meet_url) lines.push(`   🔗 <a href="${esc(m.meet_url)}">Приєднатися</a>`);
    else if (m.location) lines.push(`   📍 ${esc(m.location)}`);
    if (busyUntil > m.start_at) lines.push(`   ⚠️ Перетинається з «${esc(busyWith)}»`);
    if (m.end_at > busyUntil) {
      busyUntil = m.end_at;
      busyWith = m.title ?? "без назви";
    }
  }
  if (free.length) lines.push("", `🟢 <b>Вільні вікна:</b> ${free.join(", ")}`);
  return lines;
}

function waitingForAnswer(ev: GEvent, now: number): boolean {
  if (ev.status === "cancelled" || ev.organizer?.self || !ev.start?.dateTime) return false;
  return ev.attendees?.find((a) => a.self)?.responseStatus === "needsAction" && Date.parse(ev.start.dateTime) > now;
}

async function mailBlock(env: Env, withSummary: boolean): Promise<string[]> {
  if (!(await hasGmailScope(env))) return [];
  const gmail = new Gmail(env);
  const ids = await gmail.search("in:inbox is:unread -from:me newer_than:1d", 20);
  if (!ids.length) return ["📧 <b>Пошта:</b> нових непрочитаних листів немає"];
  type Meta = { snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
  const metas = await Promise.all(
    ids.slice(0, 5).map((id) => gmail.call<Meta>(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`).catch(() => null)),
  );
  const mails = metas
    .filter((m): m is Meta => !!m)
    .map((m) => {
      const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
      return { from: h("from").replace(/\s*<[^>]+>/, "").replace(/"/g, "") || h("from"), subject: h("subject") || "Без теми", snippet: m.snippet ?? "" };
    });
  const lines = [`📧 <b>Пошта:</b> ${ids.length}${ids.length === 20 ? "+" : ""} непрочитаних за добу`];
  for (const m of mails.slice(0, 3)) lines.push(`• ${esc(m.from)} — ${esc(m.subject)}`);
  if (withSummary) {
    const summary = await chatText(env, env.AGENT_MODEL, [
      {
        role: "system",
        content:
          "Ти секретар. Українською, до 3 коротких пунктів «• …»: що з цих листів важливо власнику і що від нього чекають. Без вступу, без markdown, лише факти з листів.",
      },
      { role: "user", content: mails.map((m) => `Від: ${m.from}\nТема: ${m.subject}\n${m.snippet}`).join("\n\n") },
    ]).catch(() => "");
    if (summary.trim()) lines.push("", "✨ <b>Коротко:</b>", esc(summary.trim().slice(0, 800)));
  }
  return lines;
}

async function bitrixBlock(env: Env, now: number, dayEnd: number): Promise<string[]> {
  if (!bitrixConfigured(env)) return [];
  const bx = new Bitrix(env);
  const me = await bx.me();
  const tasks = await bx.tasks({ MEMBER: me.id, REAL_STATUS: ["1", "2", "3", "4", "6"] }, 50);
  const overdue = tasks.filter((t) => isOverdue(t, now));
  const today = tasks.filter((t) => t.deadline && Date.parse(t.deadline) >= now && Date.parse(t.deadline) < dayEnd);
  const changed = tasks.filter((t) => t.changedDate && Date.parse(t.changedDate) > now - DAY);
  const lines = [`📋 <b>Bitrix24:</b> відкрито ${tasks.length}${tasks.length === 50 ? "+" : ""}`];
  if (overdue.length) lines.push(`🔥 Прострочено ${overdue.length}: ${overdue.slice(0, 3).map((t) => `«${esc(t.title)}»`).join(", ")}${overdue.length > 3 ? "…" : ""}`);
  if (today.length) lines.push(`⏳ Дедлайн сьогодні: ${today.slice(0, 3).map((t) => `«${esc(t.title)}» до ${formatTime(new Date(t.deadline!))}`).join(", ")}${today.length > 3 ? "…" : ""}`);
  if (changed.length) lines.push(`💬 Оновлено за добу: ${changed.length}`);
  if (!overdue.length && !today.length) lines.push("✅ Прострочених і дедлайнів на сьогодні немає");
  return lines;
}

/** The report, or null on a day without meetings (unless the owner ticked «a day without meetings»). */
export async function buildDigest(env: Env, now = Date.now(), force = false): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const choice = await loadDigestChoice(env);
  const has = (b: DigestBlock) => choice.blocks.includes(b);
  const p = kyivParts(new Date(now));
  const dayEnd = kyivLocalToDate(p.year, p.month, p.day).getTime() + DAY;
  const events = (
    await new Calendar(env).listEvents({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: new Date(now).toISOString(),
      timeMax: new Date(now + 8 * DAY).toISOString(),
      maxResults: "250",
    })
  ).items;
  const meetings = events.flatMap((ev) => {
    const c = eventToChange(ev);
    return c.kind === "upsert" ? [c.meeting] : [];
  });
  const today = meetings.filter((m) => m.start_at < dayEnd && m.end_at > now);
  if (!today.length && !has("empty") && !force) return null;

  const sections: string[][] = [[`☀️ <b>Доброго ранку! ${esc(formatDay(new Date(now), new Date(now)))}</b>`]];
  sections.push(today.length ? meetingsBlock(today) : ["📅 Сьогодні зустрічей немає"]);
  const keyboard: InlineKeyboard = [];
  // A block that fails (Gmail, Bitrix unreachable) is left out; the report still goes.
  const safely = async (make: () => Promise<string[]> | string[]) => {
    try {
      const lines = await make();
      if (lines.length) sections.push(lines);
    } catch (err) {
      console.warn("digest block:", err instanceof Error ? err.message : err);
    }
  };
  if (has("inv")) {
    await safely(() => {
      const waiting = events.filter((ev) => waitingForAnswer(ev, now));
      if (!waiting.length) return [];
      for (const ev of waiting.slice(0, 5)) {
        if (Buffer.byteLength(`decline:${ev.id}`) > 64) continue;
        const title = (ev.summary ?? "зустріч").slice(0, 24);
        keyboard.push([
          { text: `✅ ${title}`, callback_data: `accept:${ev.id}` },
          { text: "❌", callback_data: `decline:${ev.id}` },
        ]);
      }
      return [
        `📨 <b>Чекають на відповідь (${waiting.length}):</b>`,
        ...waiting.map((ev) => {
          const who = ev.organizer?.displayName || ev.organizer?.email;
          return `• ${esc(formatRange(new Date(ev.start!.dateTime!), new Date(ev.end?.dateTime ?? ev.start!.dateTime!), new Date(now)))} — ${esc(ev.summary ?? "зустріч")}${who ? ` (від ${esc(who)})` : ""}`;
        }),
      ];
    });
  }
  if (has("mail") || has("ai")) await safely(() => mailBlock(env, has("ai")));
  if (has("bx")) await safely(() => bitrixBlock(env, now, dayEnd));
  if (has("tmr")) {
    await safely(() => {
      const first = meetings.find((m) => m.start_at >= dayEnd && m.start_at < dayEnd + DAY);
      return [first ? `🌅 <b>Завтра:</b> перша зустріч о ${formatTime(new Date(first.start_at))} — ${esc(first.title ?? "без назви")}` : "🌅 <b>Завтра:</b> зустрічей немає"];
    });
  }
  return { text: sections.map((s) => s.join("\n")).join("\n\n"), keyboard };
}

/** Sends the report to the owner; false when there was nothing to send. */
export async function sendDigest(env: Env, now = Date.now(), chatId = env.OWNER_TELEGRAM_ID, force = false): Promise<boolean> {
  const digest = await buildDigest(env, now, force);
  if (!digest) return false;
  await new Telegram(env).send(chatId, digest.text, digest.keyboard.length ? { keyboard: digest.keyboard } : {});
  return true;
}
