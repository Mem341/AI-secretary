import { type Env, gmailTopic } from "../env";
import { fetchWithRetry, HttpError } from "../lib/http";
import { getAccessToken, hasGmailScope, loadGrant, loadOwnerSettings, saveOwnerSettings } from "./oauth";
import { applyEmailReminders } from "./reminders";
import { gmailPushEndpoint, startGmailWatch } from "./gmailPush";

/**
 * "Gmail → bot" push, set up by the bot itself in the owner's own Google Cloud project (the one of the OAuth client),
 * with the owner's permission (scope pubsub): a topic, Gmail's right to publish to it, and a push subscription to
 * /api/gmail-push. New mail — and the calendar's reminder emails — then wake the bot the moment they arrive. The only
 * thing the owner does once is enable the Cloud Pub/Sub API in the project.
 */

const API = "https://pubsub.googleapis.com/v1";
const GMAIL_PUBLISHER = "serviceAccount:gmail-api-push@system.gserviceaccount.com";

export type PushSetup = { ok: true } | { ok: false; reason: "no_project" | "no_scope" | "api_disabled" | "error"; detail?: string };

async function call(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  const token = await getAccessToken(env);
  return fetchWithRetry(`${API}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ok(res: Response, allow: number[] = []): Promise<Record<string, unknown>> {
  if (res.ok || allow.includes(res.status)) return ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const text = await res.text();
  // Google's HTML error pages say nothing useful: keep the status and the address.
  throw new HttpError("pubsub", res.status, text.trimStart().startsWith("<") ? `${new URL(res.url || API).pathname}` : text);
}

export async function ensureGmailPush(env: Env): Promise<PushSetup> {
  const topic = gmailTopic(env);
  if (!topic) return { ok: false, reason: "no_project" };
  // A topic given in GMAIL_PUBSUB_TOPIC is the owner's own setup: nothing to create.
  if (env.GMAIL_PUBSUB_TOPIC) return { ok: true };
  if (!(await loadGrant(env))?.scope.includes("pubsub")) return { ok: false, reason: "no_scope" };
  const subscription = topic.replace("/topics/", "/subscriptions/") + "-push";
  try {
    await ok(await call(env, "PUT", topic, {}), [409]);
    // Pub/Sub reads a policy with GET (a POST there is a 404).
    const policy = await ok(await call(env, "GET", `${topic}:getIamPolicy`));
    const bindings = (policy.bindings as { role: string; members: string[] }[] | undefined) ?? [];
    const publisher = bindings.find((b) => b.role === "roles/pubsub.publisher");
    if (!publisher?.members.includes(GMAIL_PUBLISHER)) {
      if (publisher) publisher.members.push(GMAIL_PUBLISHER);
      else bindings.push({ role: "roles/pubsub.publisher", members: [GMAIL_PUBLISHER] });
      await ok(await call(env, "POST", `${topic}:setIamPolicy`, { policy: { ...policy, bindings } }));
    }
    const pushConfig = { pushEndpoint: gmailPushEndpoint(env) };
    const created = await call(env, "PUT", subscription, { topic, pushConfig, ackDeadlineSeconds: 20 });
    // Exists already (a new deployment URL, or just again): point it at this deployment.
    if (created.status === 409) await ok(await call(env, "POST", `${subscription}:modifyPushConfig`, { pushConfig }));
    else await ok(created);
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/SERVICE_DISABLED|has not been used|is disabled/i.test(detail)) return { ok: false, reason: "api_disabled", detail };
    return { ok: false, reason: "error", detail };
  }
}

/** The link that enables the Pub/Sub API in the owner's project (for the one step the owner does). */
export function pubsubApiLink(env: Env): string {
  return `https://console.cloud.google.com/apis/library/pubsub.googleapis.com${env.GOOGLE_PROJECT_ID ? `?project=${encodeURIComponent(env.GOOGLE_PROJECT_ID)}` : ""}`;
}

/**
 * Makes Google the bot's clock: Gmail push set up (above), the mailbox watched, and the owner's meetings given reminder
 * emails. Run on connecting Google, daily (the watch lasts 7 days) and from /settings. The outcome is kept in the
 * owner's settings (p) for /settings to show.
 */
export async function setupGoogleWake(env: Env, first = false): Promise<PushSetup> {
  const result: PushSetup = (await hasGmailScope(env)) ? await ensureGmailPush(env) : { ok: false, reason: "no_scope" };
  const settings = await loadOwnerSettings(env);
  const p = result.ok ? "ok" : result.reason;
  if (settings.p !== p) await saveOwnerSettings(env, { ...settings, p });
  if (result.ok) await startGmailWatch(env, first);
  // Calendar notifications go on either way; Telegram signals only once Google wakes the bot.
  await applyEmailReminders(env);
  return result;
}

/** Whether Google wakes the bot (then meetings get reminder emails as they appear or move). */
export async function wakeReady(env: Env): Promise<boolean> {
  return (await loadOwnerSettings(env).catch(() => ({ p: undefined }))).p === "ok";
}
