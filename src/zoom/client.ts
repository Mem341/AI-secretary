import type { Env } from "../env";
import { expectOk, fetchWithRetry } from "../lib/http";

/**
 * Zoom Server-to-Server OAuth (Zoom retired JWT apps; this is the current way to call the Zoom API without a
 * per-user consent flow). Create a "Server-to-Server OAuth" app in the Zoom Marketplace under the account that
 * should host the meetings, and set ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET.
 */

let cachedToken: { token: string; expiresAt: number; key: string } | null = null;

export type ZoomKeys = Pick<Env, "ZOOM_ACCOUNT_ID" | "ZOOM_CLIENT_ID" | "ZOOM_CLIENT_SECRET">;

/** An access token for these keys (throws when Zoom rejects them — used to check keys given in /settings). */
export async function getAccessToken(env: ZoomKeys): Promise<string> {
  const key = `${env.ZOOM_ACCOUNT_ID}:${env.ZOOM_CLIENT_ID}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const basic = Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString("base64");
  const res = await fetchWithRetry("https://zoom.us/oauth/token", {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "account_credentials", account_id: env.ZOOM_ACCOUNT_ID }).toString(),
  });
  await expectOk("zoom.token", res);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000, key };
  return data.access_token;
}

export interface ZoomMeeting {
  id: number;
  join_url: string;
}

/**
 * Creates a scheduled Zoom meeting for the given time window. `draftId` doubles as an idempotency-ish
 * safeguard only in logs — Zoom's create-meeting endpoint has no client-supplied idempotency key, so a retried
 * call after a transient failure may leave one unused extra meeting; that is a harmless stray room, not a
 * correctness issue (the calendar event itself stays governed by the draft's own id).
 */
export async function createZoomMeeting(
  env: Env,
  opts: { topic: string; startIso: string; durationMin: number; agenda?: string },
): Promise<ZoomMeeting> {
  const token = await getAccessToken(env);
  const res = await fetchWithRetry("https://api.zoom.us/v2/users/me/meetings", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      topic: opts.topic,
      type: 2, // scheduled
      start_time: opts.startIso,
      duration: opts.durationMin,
      agenda: opts.agenda,
      settings: { join_before_host: true, waiting_room: false },
    }),
  });
  await expectOk("zoom.createMeeting", res);
  return (await res.json()) as ZoomMeeting;
}
