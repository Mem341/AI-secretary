import type { Env } from "../env";
import { expectOk, fetchWithRetry, HttpError } from "../lib/http";
import { getAccessToken } from "./oauth";

const BASE = "https://www.googleapis.com/calendar/v3";

export interface GAttendee {
  email: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
}

export interface GEvent {
  id: string;
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
  organizer?: { email?: string; self?: boolean };
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] };
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
  constructor(private readonly env: Env) {}

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
    return this.request<GEvent>("/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1", {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  getEvent(eventId: string): Promise<GEvent> {
    return this.request<GEvent>(`/calendars/primary/events/${encodeURIComponent(eventId)}`);
  }

  /** Partial update (reschedule, note, attendees); notifies attendees of the change. */
  patchEvent(eventId: string, patch: Record<string, unknown>): Promise<GEvent> {
    return this.request<GEvent>(`/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /**
   * Sets private properties on the owner's copy of the event, silently (no emails to guests). The bot uses them as
   * its memory of what it already reported about the event — see google/sync.ts.
   */
  setPrivate(eventId: string, props: Record<string, string>): Promise<GEvent> {
    return this.request<GEvent>(`/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
      method: "PATCH",
      body: JSON.stringify({ extendedProperties: { private: props } }),
    });
  }

  /** Deletes the event and notifies attendees. */
  async deleteEvent(eventId: string): Promise<void> {
    await this.request<void>(`/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE" });
  }

  listEvents(params: Record<string, string>): Promise<GEventList> {
    return this.request<GEventList>(`/calendars/primary/events?${new URLSearchParams(params)}`);
  }

  watch(channelId: string, token: string, address: string, ttlSeconds: number): Promise<GChannel> {
    return this.request<GChannel>("/calendars/primary/events/watch", {
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
