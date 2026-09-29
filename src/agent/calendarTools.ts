import { type Env, zoomConfigured } from "../env";
import { Calendar, type GEvent } from "../google/calendar";
import { PROP_BOT_CANCEL, PROP_DRAFT, PROP_START } from "../google/sync";
import { randomId } from "../lib/crypto";
import { mark } from "../session";
import { createZoomMeeting } from "../zoom/client";
import { str, type Tool } from "./runner";

/**
 * The tools of the n8n "Calendar MCP Server", one to one. Descriptions are the n8n ones. Invisible to the model:
 * every write the bot makes also records `aisStart` / `aisBotCancel` on the event, so the instant "calendar →
 * Telegram" notices never echo the bot's own changes.
 */

const ISO = "ISO 8601 with Europe/Kyiv offset, e.g. 2026-10-01T14:00:00+03:00";

/** n8n passes attendees as comma-separated JSON objects ({"email":"a@x"},{"email":"b@y"}); plain lists work too. */
export function parseAttendees(value: unknown): { email: string; displayName?: string; responseStatus?: string }[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? { email: v } : (v as { email?: string; displayName?: string; responseStatus?: string })))
      .filter((a): a is { email: string } => !!a?.email && a.email.includes("@"));
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return [];
  try {
    const parsed = JSON.parse(text.startsWith("[") ? text : `[${text}]`) as unknown[];
    return parseAttendees(parsed);
  } catch {
    return [...new Set(text.match(/[^\s,;"'{}<>:]+@[^\s,;"'{}<>]+\.[a-z]{2,}/gi) ?? [])].map((email) => ({ email }));
  }
}

/** "через 25 хв" / "через 2 год 10 хв" / "йде зараз" — so answers can say how soon a meeting starts. */
export function startsIn(start: string | undefined, end: string | undefined, now = Date.now()): string | undefined {
  const s = start ? Date.parse(start) : NaN;
  if (Number.isNaN(s)) return undefined;
  const e = end ? Date.parse(end) : s;
  if (s <= now) return e > now ? "йде зараз" : "вже минула";
  const min = Math.round((s - now) / 60_000);
  if (min < 60) return `через ${min} хв`;
  if (min < 24 * 60) return `через ${Math.floor(min / 60)} год${min % 60 ? ` ${min % 60} хв` : ""}`;
  const days = Math.round(min / (24 * 60));
  return `через ${days} ${days === 1 ? "день" : days < 5 ? "дні" : "днів"}`;
}

/** A compact event for the model (no raw noise). */
function brief(ev: GEvent): Record<string, unknown> {
  return {
    id: ev.id,
    status: ev.status,
    summary: ev.summary,
    startsIn: startsIn(ev.start?.dateTime, ev.end?.dateTime),
    start: ev.start?.dateTime ?? ev.start?.date,
    end: ev.end?.dateTime ?? ev.end?.date,
    location: ev.location,
    description: ev.description?.slice(0, 1000),
    hangoutLink: ev.hangoutLink,
    htmlLink: ev.htmlLink,
    organizer: ev.organizer,
    attendees: ev.attendees?.map((a) => ({ email: a.email, name: a.displayName, responseStatus: a.responseStatus, self: a.self })),
  };
}

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });

/** Words that ask to remove a meeting, and short confirmations (the owner answering «Видалити? (так / ні)»). */
const DELETE_WORDS = /видал|удал|скасу|отмен|відмін|прибер|cancel|delete|remove/i;
const CONFIRM = /^\s*(так|да|yes|ок|ok|давай|підтверджую|подтверждаю)(?=$|[\s,.!])/i;
const ALL_WORDS = /(^|\s)(все|всі|усі|всё|all)(\s|$)/i;

/**
 * Whether the owner's current message allows deleting: a meeting is removed only when THIS message asks for it (never
 * because of something said earlier), and several at once — or «all» — only after an explicit «так».
 */
export function deletionAllowed(currentText: string | undefined, deletedAlready: number): string | null {
  if (currentText === undefined) return null;
  const text = currentText.trim();
  const confirmed = CONFIRM.test(text);
  if (!confirmed && !DELETE_WORDS.test(text)) {
    return "The owner's current message does not ask to delete anything. Do NOT delete. Ask what they want.";
  }
  if (!confirmed && (deletedAlready > 0 || ALL_WORDS.test(text))) {
    return "Deleting several meetings needs the owner's explicit confirmation first: list them and ask «Видалити? (так / ні)». Do not delete now.";
  }
  return null;
}

export function calendarTools(env: Env, ownerEmail: string | null, opts: { currentText?: string } = {}): Tool[] {
  const cal = new Calendar(env);
  let deleted = 0;

  const createBody = (a: Record<string, unknown>, extra: Record<string, unknown>) => {
    const start = str(a, "startDateTime");
    const startMs = Date.parse(start);
    if (Number.isNaN(startMs)) throw new Error(`startDateTime must be ${ISO}`);
    const end = str(a, "endDateTime") || new Date(startMs + 60 * 60_000).toISOString();
    return {
      summary: str(a, "summary"),
      start: { dateTime: start, timeZone: "Europe/Kyiv" },
      end: { dateTime: end, timeZone: "Europe/Kyiv" },
      attendees: parseAttendees(a.attendeesJson ?? a.attendees),
      guestsCanModify: false,
      guestsCanInviteOthers: true,
      guestsCanSeeOtherGuests: true,
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
      extendedProperties: { private: { [PROP_DRAFT]: randomId(9), [PROP_START]: String(startMs) } },
      ...extra,
    };
  };

  const tools: Tool[] = [
    {
      spec: {
        name: "get_calendar_events",
        description:
          "Get events from the primary Google Calendar ordered by start time (max 20). Use to show the schedule, or to find an event by its title before changing it. Optional: timeMin, timeMax (" + ISO + "), q (text search, e.g. part of the title).",
        parameters: object({ timeMin: s("Start of the range. Default: now."), timeMax: s("End of the range."), q: s("Free-text search") }, []),
      },
      async run(a) {
        const params: Record<string, string> = {
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "20",
          timeMin: str(a, "timeMin") || new Date().toISOString(),
        };
        if (str(a, "timeMax")) params.timeMax = str(a, "timeMax");
        if (str(a, "q")) params.q = str(a, "q");
        return (await cal.listEvents(params)).items.map(brief);
      },
    },
    {
      spec: {
        name: "get_event",
        description:
          "Get a single Google Calendar event by its ID. Use when you need full details about a specific event — attendees, time, conference link, description. ALWAYS call this before updating an event to get the current state. Required param: eventId.",
        parameters: object({ eventId: s("The Google Calendar event ID to retrieve") }, ["eventId"]),
      },
      async run(a) {
        return brief(await cal.getEvent(str(a, "eventId")));
      },
    },
    {
      spec: {
        name: "check_free_busy",
        description:
          "Check free/busy status for a time range. Use when user asks 'Am I free at...?' or before creating a meeting to check for conflicts. Required params: timeMin and timeMax in " + ISO + ".",
        parameters: object({ timeMin: s("Start of time range to check"), timeMax: s("End of time range to check") }, ["timeMin", "timeMax"]),
      },
      async run(a) {
        return { busy: await cal.freeBusy(str(a, "timeMin"), str(a, "timeMax")) };
      },
    },
    {
      spec: {
        name: "create_event_google_meet",
        description:
          "Create a Google Calendar event WITH a Google Meet video conferencing link. Use this tool by DEFAULT for any meeting creation unless user explicitly asks for Zoom. Required params: summary (title), startDateTime, endDateTime (" + ISO + "), description (can be empty string). Optional: attendeesJson (comma-separated JSON objects like {\"email\":\"user@mail.com\"},{\"email\":\"user2@mail.com\"} — omit entirely if no attendees).",
        parameters: object(
          {
            summary: s("Meeting title or topic. Example: Зустріч з Дмитром"),
            description: s("Event description. Use empty string if not specified by user"),
            startDateTime: s("Start time, " + ISO),
            endDateTime: s("End time, " + ISO + ". Default duration 1 hour"),
            attendeesJson: s('Comma-separated JSON attendee objects. Example: {"email":"dmytro@example.com"},{"email":"user@mail.com"}'),
          },
          ["summary", "startDateTime", "endDateTime"],
        ),
      },
      async run(a) {
        const body = createBody(a, {
          description: str(a, "description"),
          conferenceData: { createRequest: { requestId: `meet-${randomId(8)}`, conferenceSolutionKey: { type: "hangoutsMeet" } } },
        });
        return brief(await cal.insertEvent(body));
      },
    },
    {
      spec: {
        name: "create_event_zoom_link",
        description:
          "Create a Google Calendar event with a Zoom meeting link. Use this ONLY when user explicitly asks for Zoom. First call 'create_zoom_meeting' to get the join URL, then call this tool. Required params: summary, startDateTime, endDateTime, zoomJoinUrl. Optional: descriptionWithZoom, attendeesJson.",
        parameters: object(
          {
            summary: s("Meeting title or topic"),
            descriptionWithZoom: s("Event description that MUST include the Zoom join URL. Format: Zoom: https://zoom.us/j/... followed by any other notes"),
            zoomJoinUrl: s("The Zoom meeting join URL from create_zoom_meeting"),
            startDateTime: s("Start time, " + ISO),
            endDateTime: s("End time, " + ISO),
            attendeesJson: s('Comma-separated JSON attendee objects. Example: {"email":"user@mail.com"}'),
          },
          ["summary", "zoomJoinUrl", "startDateTime", "endDateTime"],
        ),
      },
      async run(a) {
        const url = str(a, "zoomJoinUrl");
        const body = createBody(a, { description: str(a, "descriptionWithZoom") || `Zoom: ${url}`, location: url });
        return brief(await cal.insertEvent(body));
      },
    },
    {
      spec: {
        name: "update_event_fields",
        description:
          "Update any field of an existing Google Calendar event — description, summary (title), location, or any combination. Only the specified fields change. ALWAYS call 'get_event' first if you need current values. Required: eventId, patchBody.",
        parameters: object(
          {
            eventId: s("The Google Calendar event ID to update"),
            patchBody: {
              type: "object",
              description: 'ONLY the fields to update, e.g. {"description":"Updated notes"} or {"summary":"New title"}',
              properties: { summary: { type: "string" }, description: { type: "string" }, location: { type: "string" } },
            },
          },
          ["eventId", "patchBody"],
        ),
      },
      async run(a) {
        const p = (typeof a.patchBody === "string" ? JSON.parse(a.patchBody) : a.patchBody ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const k of ["summary", "description", "location"]) if (typeof p[k] === "string") patch[k] = p[k];
        return brief(await cal.patchEvent(str(a, "eventId"), patch));
      },
    },
    {
      spec: {
        name: "reschedule_event",
        description:
          "Reschedule (move) an existing Google Calendar event to a new date/time. Preserves all other event properties (attendees, description, conference link). Required params: eventId, newStartDateTime, newEndDateTime (" + ISO + "). Keep the same duration unless the user said otherwise.",
        parameters: object(
          { eventId: s("The Google Calendar event ID to reschedule"), newStartDateTime: s("New start, " + ISO), newEndDateTime: s("New end, " + ISO) },
          ["eventId", "newStartDateTime", "newEndDateTime"],
        ),
      },
      async run(a) {
        const id = str(a, "eventId");
        const current = await cal.getEvent(id);
        const start = str(a, "newStartDateTime");
        return brief(
          await cal.patchEvent(id, {
            start: { dateTime: start, timeZone: "Europe/Kyiv" },
            end: { dateTime: str(a, "newEndDateTime"), timeZone: "Europe/Kyiv" },
            extendedProperties: { private: { ...(current.extendedProperties?.private ?? {}), [PROP_START]: String(Date.parse(start)) } },
          }),
        );
      },
    },
    {
      spec: {
        name: "manage_event_attendees",
        description:
          "Add or remove attendees of an existing event. IMPORTANT: first call 'get_event' to get current attendees, then pass the FULL updated list here (this REPLACES the entire list). Required params: eventId, attendeesJson.",
        parameters: object(
          {
            eventId: s("The Google Calendar event ID"),
            attendeesJson: s('FULL list of ALL attendees (existing + new), e.g. {"email":"existing@mail.com"},{"email":"new@mail.com"}'),
          },
          ["eventId", "attendeesJson"],
        ),
      },
      async run(a) {
        return brief(await cal.patchEvent(str(a, "eventId"), { attendees: parseAttendees(a.attendeesJson) }));
      },
    },
    {
      spec: {
        name: "rsvp_event",
        description:
          "Accept or decline a Google Calendar event invitation (RSVP) for the owner. Required params: eventId, responseStatus (exactly 'accepted' or 'declined').",
        parameters: object(
          { eventId: s("The Google Calendar event ID"), responseStatus: { type: "string", enum: ["accepted", "declined"] } },
          ["eventId", "responseStatus"],
        ),
      },
      async run(a) {
        const status = str(a, "responseStatus") === "declined" ? "declined" : "accepted";
        const ev = await cal.getEvent(str(a, "eventId"));
        // Only the owner's own answer changes; the rest of the list is kept (a PATCH replaces the whole list).
        const attendees = ev.attendees ?? [];
        const self = attendees.find((x) => x.self || (ownerEmail && x.email.toLowerCase() === ownerEmail));
        if (!self) return { ok: true, note: "The owner organizes this event, so it is already accepted." };
        self.responseStatus = status;
        return brief(await cal.patchEvent(ev.id, { attendees }));
      },
    },
    {
      spec: {
        name: "delete_event",
        description: "Delete an event from the primary Google Calendar; attendees are notified. Required: eventId.",
        parameters: object({ eventId: s("The Google Calendar event ID to delete") }, ["eventId"]),
      },
      async run(a) {
        const refusal = deletionAllowed(opts.currentText, deleted);
        if (refusal) return { error: refusal };
        const id = str(a, "eventId");
        mark(`bot-cancel:${id}`, 10 * 60_000);
        const ev = await cal.getEvent(id);
        await cal.setPrivate(id, { ...(ev.extendedProperties?.private ?? {}), [PROP_BOT_CANCEL]: "1" }).catch(() => undefined);
        await cal.deleteEvent(id);
        deleted++;
        return { ok: true, deleted: id };
      },
    },
  ];

  if (zoomConfigured(env)) {
    tools.push({
      spec: {
        name: "create_zoom_meeting",
        description: "Create a Zoom meeting and get its join URL. Only when the user explicitly asks for Zoom; then call create_event_zoom_link.",
        parameters: object(
          { topic: s("Meeting title"), startDateTime: s("Start, " + ISO), durationMin: { type: "number", description: "Duration in minutes (default 60)" } },
          ["topic", "startDateTime"],
        ),
      },
      async run(a) {
        const zoom = await createZoomMeeting(env, {
          topic: str(a, "topic") || "Зустріч",
          startIso: new Date(Date.parse(str(a, "startDateTime"))).toISOString(),
          durationMin: Number(a.durationMin) > 0 ? Number(a.durationMin) : 60,
        });
        return { join_url: zoom.join_url };
      },
    });
  }
  return tools;
}
