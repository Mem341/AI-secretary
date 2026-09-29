import type { Env } from "../env";
import { expectOk, fetchWithRetry, HttpError } from "../lib/http";
import { getAccessToken } from "./oauth";

const BASE = "https://www.googleapis.com/calendar/v3";

export interface GAttendee {
  email: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
}

export interface GEvent {
  id: string;
  /** Version of the event; a write with If-Match fails (412) if someone changed it in between. */
  etag?: string;
  /** The owner's own notifications for this event (per user: guests are not affected). */
  reminders?: { useDefault?: boolean; overrides?: { method: string; minutes: number }[] };
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  created?: string;
  updated?: string;
  recurringEventId?: string;
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: GAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[]; conferenceSolution?: { name?: string } };
  eventType?: string;
}

export interface GEventList {
  items: GEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface GChannel {
  id: string;
  resourceId: string;
  expiration?: string;
}

/** Google Calendar API client for one owner's primary calendar. */
export class Calendar {
  private readonly base: string;

  /** The owner's primary calendar, or another calendar of theirs (the bot's own signal calendar, google/signals.ts). */
  constructor(
    private readonly env: Env,
    readonly calendarId = "primary",
  ) {
    this.base = `/calendars/${encodeURIComponent(calendarId)}`;
  }

  private async request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await getAccessToken(this.env, retried);
    const res = await fetchWithRetry(`${BASE}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    if (res.status === 401 && !retried) {
      await res.body?.cancel();
      return this.request<T>(path, init, true);
    }
    await expectOk(`gcal ${init.method ?? "GET"} ${path.split("?")[0]}`, res);
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  insertEvent(event: Record<string, unknown>): Promise<GEvent> {
    // sendUpdates=all: Google emails invitations to every attendee (spec 4.2).
    return this.request<GEvent>(`${this.base}/events?sendUpdates=all&conferenceDataVersion=1`, {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  getEvent(eventId: string): Promise<GEvent> {
    return this.request<GEvent>(`${this.base}/events/${encodeURIComponent(eventId)}`);
  }

  /** Partial update (reschedule, note, attendees); notifies attendees of the change. */
  patchEvent(eventId: string, patch: Record<string, unknown>): Promise<GEvent> {
    return this.request<GEvent>(`${this.base}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /**
   * Sets private properties on the owner's copy of the event, silently (no emails to guests). The bot uses them as
   * its memory of what it already reported about the event — see google/sync.ts.
   */
  setPrivate(eventId: string, props: Record<string, string>, ifMatch?: string): Promise<GEvent> {
    return this.request<GEvent>(`${this.base}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
      method: "PATCH",
      headers: ifMatch ? { "if-match": ifMatch } : {},
      body: JSON.stringify({ extendedProperties: { private: props } }),
    });
  }

  /**
   * setPrivate that only succeeds on the version of the event we read (If-Match): a claim. Two copies of the bot
   * handling the same push (Google often sends several) race here; only one wins, so a notice is sent once.
   * False = someone else already wrote it. Other errors do not block (a repeated notice beats a lost one).
   */
  async claimPrivate(ev: GEvent, props: Record<string, string>): Promise<boolean> {
    try {
      await this.setPrivate(ev.id, props, ev.etag);
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 412) return false;
      console.warn("gcal: cannot mark event", ev.id, err instanceof Error ? err.message : err);
      return true;
    }
  }

  /** The owner's own notifications for the event (or a whole recurring series), silently. */
  setReminders(eventId: string, reminders: NonNullable<GEvent["reminders"]>): Promise<GEvent> {
    return this.request<GEvent>(`${this.base}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
      method: "PATCH",
      body: JSON.stringify({ reminders }),
    });
  }

  /** A new secondary calendar of the owner's (the bot's signal calendar); returns its id. */
  async createCalendar(summary: string): Promise<string> {
    const cal = await this.request<{ id: string }>("/calendars", { method: "POST", body: JSON.stringify({ summary, timeZone: "Europe/Kyiv" }) });
    return cal.id;
  }

  /** Creates or replaces an event with a known id, silently (no guests are involved). */
  async putEvent(event: GEvent & Record<string, unknown>): Promise<GEvent> {
    try {
      return await this.request<GEvent>(`${this.base}/events/${encodeURIComponent(event.id)}?sendUpdates=none`, {
        method: "PUT",
        body: JSON.stringify(event),
      });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
      return this.request<GEvent>(`${this.base}/events?sendUpdates=none`, { method: "POST", body: JSON.stringify(event) });
    }
  }

  /** Deletes an event without telling anybody (the bot's own signal events). */
  async deleteSilently(eventId: string): Promise<void> {
    await this.request<void>(`${this.base}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: "DELETE" }).catch((err) => {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 410))) throw err;
    });
  }

  /** Deletes the event and notifies attendees. */
  async deleteEvent(eventId: string): Promise<void> {
    await this.request<void>(`${this.base}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE" });
  }

  /** Busy intervals of the primary calendar in [timeMin, timeMax]. */
  async freeBusy(timeMin: string, timeMax: string): Promise<{ start: string; end: string }[]> {
    const res = await this.request<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>("/freeBusy", {
      method: "POST",
      body: JSON.stringify({ timeMin, timeMax, timeZone: "Europe/Kyiv", items: [{ id: "primary" }] }),
    });
    return res.calendars?.primary?.busy ?? [];
  }

  listEvents(params: Record<string, string>): Promise<GEventList> {
    return this.request<GEventList>(`${this.base}/events?${new URLSearchParams(params)}`);
  }

  watch(channelId: string, token: string, address: string, ttlSeconds: number): Promise<GChannel> {
    return this.request<GChannel>(`${this.base}/events/watch`, {
      method: "POST",
      body: JSON.stringify({ id: channelId, type: "web_hook", address, token, params: { ttl: String(ttlSeconds) } }),
    });
  }

  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    try {
      await this.request<void>("/channels/stop", { method: "POST", body: JSON.stringify({ id: channelId, resourceId }) });
    } catch (err) {
      // Already expired or unknown channel: nothing to stop.
      if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return;
      throw err;
    }
  }
}
