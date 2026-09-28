import type { Meeting } from "../google/sync";
import { PROP_DRAFT, PROP_START } from "../google/sync";
import { durationOf, firstName, formatOf, type MeetingFormat, type User } from "./owner";
import { esc } from "../telegram/api";
import {
  DAY,
  formatDay,
  formatIsoDateShort,
  formatRange,
  formatTime,
  isIsoDate,
  kyivLocalToDate,
  kyivParts,
  MINUTE,
  parseIsoWithOffset,
  parseKyivLocal,
  toKyivDate,
  toKyivIso,
  TZ,
} from "../lib/time";

export interface CardAttendee {
  name: string | null;
  email: string | null;
  internal: boolean;
}

/** Meeting card: the LLM output format from spec section 5, plus bot-side fields. */
export interface Card {
  title: string | null;
  /** ISO date-time with offset; null when the time is unknown. */
  start: string | null;
  /** Known date without a time (YYYY-MM-DD): free slots are offered on that day. */
  date: string | null;
  duration_min: number;
  format: MeetingFormat;
  location: string | null;
  attendees: CardAttendee[];
  initiator: string | null;
  purpose: string | null;
  agenda: string[];
  agreed_via: string | null;
  agreed_at: string | null;
  missing: string[];
  confidence: number;
  clarify_question: string | null;
  /** Free slots offered when start is unknown (ISO). */
  slots?: string[];
}

/** Address-book entry (name → email). */
export interface DirectoryEntry {
  name: string;
  email: string;
}

export const CONFIDENCE_THRESHOLD = 0.7;

const PUBLIC_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com", "ukr.net", "i.ua", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "meta.ua"]);

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function normName(s: string): string {
  return s.toLowerCase().replace(/[ʼ'’`]/g, "").replace(/\s+/g, " ").trim();
}

/** Finds a contact by full name, or by a unique first name / surname. */
export function findInDirectory(directory: DirectoryEntry[], name: string): DirectoryEntry | null {
  const n = normName(name);
  if (!n) return null;
  const exact = directory.filter((d) => normName(d.name) === n);
  if (exact.length === 1) return exact[0]!;
  const tokens = n.split(" ");
  const partial = directory.filter((d) => {
    const dTokens = normName(d.name).split(" ");
    return tokens.every((t) => dTokens.includes(t));
  });
  return partial.length === 1 ? partial[0]! : null;
}

/**
 * Validates and completes a card returned by the LLM: defaults from the owner's profile, emails from the
 * address book, no duplicates, the owner never listed as an attendee. Never invents data.
 */
export function normalizeCard(raw: unknown, owner: User, directory: DirectoryEntry[]): Card {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const startDate = parseIsoWithOffset(r.start) ?? parseKyivLocal(r.start);
  const duration = Number(r.duration_min);
  const format: MeetingFormat =
    r.format === "google_meet" || r.format === "offline" || r.format === "zoom" ? r.format : formatOf(owner);

  const ownerEmail = owner.email?.toLowerCase() ?? null;
  const domain = ownerEmail?.split("@")[1] ?? null;
  // Public mailboxes do not mark anyone as a colleague.
  const ownerDomain = domain && !PUBLIC_MAIL_DOMAINS.has(domain) ? domain : null;
  const ownerName = owner.full_name ? normName(owner.full_name) : null;
  const seen = new Set<string>();
  const attendees: CardAttendee[] = [];
  for (const a of Array.isArray(r.attendees) ? r.attendees : []) {
    if (!a || typeof a !== "object") continue;
    const item = a as Record<string, unknown>;
    const name = str(item.name);
    let email = str(item.email)?.toLowerCase() ?? null;
    if (email && !EMAIL_RE.test(email)) email = null;
    const known = name ? findInDirectory(directory, name) : null;
    const knownByEmail = email ? directory.find((d) => d.email.toLowerCase() === email) : undefined;
    if (!email && known) email = known.email.toLowerCase();
    // Colleague: the model says so, or the email shares the owner's corporate domain.
    const internal = item.internal === true || (!!email && !!ownerDomain && email.endsWith(`@${ownerDomain}`));
    if ((email && email === ownerEmail) || (name && ownerName && normName(name) === ownerName)) continue;
    const key = email ?? `name:${normName(name ?? "")}`;
    if (!name && !email) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    attendees.push({ name: name ?? knownByEmail?.name ?? null, email, internal });
  }

  let location = str(r.location);
  if (format === "offline" && !location) location = owner.defaults.address ?? null;
  if (format === "google_meet" || format === "zoom") location = null;

  const agenda = Array.isArray(r.agenda) ? r.agenda.map(str).filter((x): x is string => !!x) : [];
  const missing = Array.isArray(r.missing) ? r.missing.map(str).filter((x): x is string => !!x) : [];
  const confidence = Number(r.confidence);

  const card: Card = {
    title: str(r.title),
    start: startDate ? toKyivIso(startDate) : null,
    date: !startDate && isIsoDate(r.date) ? r.date : null,
    duration_min: Number.isFinite(duration) && duration >= 5 && duration <= 12 * 60 ? Math.round(duration) : durationOf(owner),
    format,
    location,
    attendees,
    initiator: str(r.initiator),
    purpose: str(r.purpose),
    agenda,
    agreed_via: str(r.agreed_via),
    agreed_at: isIsoDate(r.agreed_at) ? r.agreed_at : null,
    missing,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    clarify_question: str(r.clarify_question),
  };
  if (!card.title) card.title = defaultTitle(card, owner);
  return card;
}

/** Spec 4.2: "Name Surname of the counterpart + owner's first name"; for internal meetings the topic. */
export function defaultTitle(card: Card, owner: User): string {
  const external = card.attendees.filter((a) => !a.internal && a.name).map((a) => a.name!);
  const owner1 = firstName(owner);
  if (external.length) return owner1 ? `${external.join(", ")} + ${owner1}` : external.join(", ");
  return card.purpose ?? "Зустріч";
}

export function cardStart(card: Card): Date | null {
  return card.start ? parseIsoWithOffset(card.start) : null;
}

export function cardEnd(card: Card): Date | null {
  const start = cardStart(card);
  return start ? new Date(start.getTime() + card.duration_min * MINUTE) : null;
}

export function attendeesWithoutEmail(card: Card): CardAttendee[] {
  return card.attendees.filter((a) => !a.email);
}

// ---------------------------------------------------------------------------------------------------------------
// Free slots

export interface SlotOptions {
  now: Date;
  durationMin: number;
  busy: { start: number; end: number }[];
  /** Restrict to one Kyiv date (YYYY-MM-DD). */
  date?: string | null;
  count?: number;
  workStartHour?: number;
  workEndHour?: number;
  daysAhead?: number;
}

/**
 * Finds free slots in working hours (Mon–Fri, 09:00–18:00 Kyiv, 30-minute grid), at least one hour from now.
 * Without a date, slots are spread over different days: the earliest free slot of each day.
 */
export function findFreeSlots(o: SlotOptions): Date[] {
  const { now, durationMin, busy, count = 3, workStartHour = 9, workEndHour = 18, daysAhead = 10 } = o;
  const earliest = now.getTime() + 60 * MINUTE;
  const result: Date[] = [];
  const overlaps = (s: number, e: number) => busy.some((b) => b.start < e && b.end > s);

  const days: { y: number; m: number; d: number }[] = [];
  if (o.date) {
    const [y, m, d] = o.date.split("-").map(Number) as [number, number, number];
    days.push({ y, m, d });
  } else {
    for (let i = 0; i < daysAhead; i++) {
      const p = kyivParts(new Date(now.getTime() + i * DAY));
      if (p.weekday === 0 || p.weekday === 6) continue;
      days.push({ y: p.year, m: p.month, d: p.day });
    }
  }

  for (const { y, m, d } of days) {
    const dayEnd = kyivLocalToDate(y, m, d, workEndHour).getTime();
    for (let t = kyivLocalToDate(y, m, d, workStartHour).getTime(); t + durationMin * MINUTE <= dayEnd; t += 30 * MINUTE) {
      if (t < earliest || overlaps(t, t + durationMin * MINUTE)) continue;
      result.push(new Date(t));
      if (result.length >= count) return result;
      // Spread over days unless the user named the day.
      if (!o.date) break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Google Calendar event

/** Event description per spec 4.2: initiator, agenda, where the meeting was agreed, owner's contacts. */
export function buildDescription(card: Card, owner: User, zoomJoinUrl?: string): string {
  const lines: string[] = [];
  if (zoomJoinUrl) lines.push(`Приєднатися до Zoom: ${zoomJoinUrl}`, "");
  if (card.initiator) lines.push(`Ініціатор: ${card.initiator}`);
  if (card.purpose) lines.push(`Мета: ${card.purpose}`);
  if (card.agenda.length) {
    lines.push("", "Агенда:", ...card.agenda.map((a) => `• ${a}`));
  }
  const agreed = [card.agreed_at ? formatIsoDateShort(card.agreed_at) : null, card.agreed_via ? `у ${card.agreed_via}` : null]
    .filter(Boolean)
    .join(" ");
  if (agreed) lines.push("", `Домовились: ${agreed}`);

  const contacts: string[] = [];
  if (owner.phone) contacts.push(`тел. ${owner.phone}`);
  if (owner.tg_username) contacts.push(`Telegram @${owner.tg_username}`);
  const who = [owner.full_name, owner.position].filter(Boolean).join(", ");
  if (who || contacts.length) {
    lines.push("", `Контакти організатора: ${who}`.trim());
    if (contacts.length) lines.push(`${contacts.join(" · ")} — краще писати, ніж дзвонити.`);
  }
  lines.push("", "— Створено AI-секретарем");
  return lines.join("\n").replace(/^\n+/, "");
}

/**
 * `zoomJoinUrl` is the join link of a Zoom meeting created ahead of this call (Zoom is not a Calendar
 * conference provider, unlike Google Meet, so its link has to be created first and passed in).
 */
export function buildEventBody(card: Card, owner: User, draftId: string, zoomJoinUrl?: string): Record<string, unknown> {
  const start = cardStart(card);
  const end = cardEnd(card);
  if (!start || !end) throw new Error("Card has no start time");
  const event: Record<string, unknown> = {
    summary: card.title,
    description: buildDescription(card, owner, zoomJoinUrl),
    start: { dateTime: toKyivIso(start), timeZone: TZ },
    end: { dateTime: toKyivIso(end), timeZone: TZ },
    attendees: card.attendees
      .filter((a) => a.email)
      .map((a) => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}) })),
    // Spec 4.2: guests may edit the event and invite their own people.
    guestsCanModify: true,
    guestsCanInviteOthers: true,
    reminders: { useDefault: true },
    // The start is remembered on the event, so the push for this very write is not reported as someone else's change.
    extendedProperties: { private: { [PROP_DRAFT]: draftId, [PROP_START]: String(start.getTime()) } },
  };
  if (card.format === "google_meet") {
    event.conferenceData = {
      createRequest: { requestId: draftId, conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  } else if (card.format === "zoom" && zoomJoinUrl) {
    event.location = zoomJoinUrl;
  } else if (card.location) {
    event.location = card.location;
  }
  return event;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

/** One line describing the meeting's format for the card and the created-confirmation message. */
export function formatLabel(card: Card): string {
  if (card.format === "google_meet") return "онлайн, Google Meet (посилання створить календар)";
  if (card.format === "zoom") return "онлайн, Zoom (посилання створить бот)";
  return `офлайн${card.location ? ` · ${esc(card.location)}` : " · місце не вказано"}`;
}

export interface CardContext {
  now: Date;
  /** Meetings overlapping the card's time (conflict warning). */
  conflicts: Meeting[];
}

export function renderCard(card: Card, ctx: CardContext): string {
  const start = cardStart(card);
  const end = cardEnd(card);
  const lines: string[] = ["📅 <b>Нова зустріч</b>", ""];
  lines.push(`<b>Назва:</b> ${esc(card.title)}`);
  if (start && end) {
    lines.push(`<b>Коли:</b> ${esc(formatRange(start, end, ctx.now))} (${card.duration_min} хв)`);
  } else if (card.date) {
    const [y, m, d] = card.date.split("-").map(Number) as [number, number, number];
    lines.push(`<b>Коли:</b> ${esc(formatDay(kyivLocalToDate(y, m, d, 12), ctx.now))}, час не вказано`);
  } else {
    lines.push("<b>Коли:</b> час не вказано");
  }
  lines.push(`<b>Формат:</b> ${formatLabel(card)}`);

  lines.push("<b>Учасники:</b>");
  if (!card.attendees.length) lines.push("  — лише ви");
  for (const a of card.attendees) {
    const label = esc(a.name ?? a.email ?? "");
    const tag = a.internal ? " (свій)" : "";
    lines.push(a.email ? `  • ${label}${tag} — ${esc(a.email)}` : `  • ${label}${tag} — ⚠️ немає email`);
  }

  if (card.initiator) lines.push(`<b>Ініціатор:</b> ${esc(card.initiator)}`);
  if (card.purpose) lines.push(`<b>Мета:</b> ${esc(card.purpose)}`);
  if (card.agenda.length) {
    lines.push("<b>Агенда:</b>", ...card.agenda.map((a, i) => `  ${i + 1}. ${esc(a)}`));
  }
  if (card.agreed_via || card.agreed_at) {
    const when = card.agreed_at ? formatIsoDateShort(card.agreed_at) : "";
    lines.push(`<b>Домовились:</b> ${esc([when, card.agreed_via ? `у ${card.agreed_via}` : ""].filter(Boolean).join(" "))}`);
  }

  const warnings: string[] = [];
  if (start && start.getTime() < ctx.now.getTime()) warnings.push("Час уже минув — перевірте дату.");
  for (const m of ctx.conflicts) {
    warnings.push(
      `Перетин з «${esc(m.title ?? "без назви")}» ${formatTime(new Date(m.start_at))}–${formatTime(new Date(m.end_at))}`,
    );
  }
  for (const miss of card.missing) warnings.push(`Не вистачає: ${esc(miss)}`);
  if (warnings.length) lines.push("", ...warnings.map((w) => `⚠️ ${w}`));

  if (!start && card.slots?.length) lines.push("", "Оберіть вільний час:");
  else if (!start) lines.push("", "Вільних слотів не знайшлось — напишіть бажаний час у «Змінити».");
  return lines.join("\n");
}

/** One-line label for a slot button: "вт, 29 вересня, 10:00". */
export function slotLabel(slot: Date, now: Date): string {
  const sameDay = toKyivDate(slot) === toKyivDate(now);
  return `${sameDay ? "сьогодні" : formatDay(slot, now)}, ${formatTime(slot)}`;
}
