import type { Env } from "../env";
import { googleConfigured, googleRedirectUri } from "../env";
import { decrypt, encrypt, fromBase64Url, signToken, verifyToken } from "../lib/crypto";
import { expectOk, fetchWithRetry, HttpError } from "../lib/http";
import { esc, Telegram } from "../telegram/api";
import { hiddenData, readHidden } from "../telegram/hidden";
import type { TgMessage } from "../telegram/types";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  // Only calendars the bot creates itself: its signal calendar for Telegram reminders (google/signals.ts).
  "https://www.googleapis.com/auth/calendar.app.created",
  // Read/write/send Gmail except permanently deleting; plus managing label definitions.
  // NOTE: these are Google "restricted" scopes. A published but unverified app still works for its single owner
  // (Google shows an "unverified app" warning); a consent screen left in "Testing" expires grants after 7 days.
  // See /api/setup for the options.
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  // The bot's own hidden folder on the owner's Drive (not their files): the long conversation memory (agent/memory.ts).
  "https://www.googleapis.com/auth/drive.appdata",
  // Pub/Sub in the owner's own Google Cloud project: the bot sets up "Gmail → bot" push itself (google/pubsub.ts).
  // New mail and calendar reminder emails wake the bot through it — no cron and no outside service.
  "https://www.googleapis.com/auth/pubsub",
];
const STATE_TTL_MS = 30 * 60_000;

/**
 * The permissions beyond the calendar, as Google's consent screen words them — it shows each as its own checkbox,
 * unticked. Returns those missing from a granted scope string.
 */
export function missingScopes(scope: string): string[] {
  const all: [string, string][] = [
    ["gmail.modify", "пошта — «Читати, створювати, надсилати й видаляти листи Gmail» (Read, compose, and send emails)"],
    ["pubsub", "сигнали — «Pub/Sub» (View and manage Pub/Sub topics and subscriptions)"],
    ["calendar.app.created", "календар сигналів — «Створювати додаткові календарі» (Make secondary Google calendars…)"],
    ["drive.appdata", "памʼять — «Дані застосунку на Диску» (See, create, and delete its own configuration data in your Google Drive)"],
  ];
  return all.filter(([s]) => !scope.includes(s)).map(([, text]) => text);
}

/** Thrown when the refresh token no longer works; the owner must reconnect Google. */
export class GoogleAuthRevokedError extends Error {
  constructor() {
    super("Google authorization revoked");
  }
}

export function redirectUri(env: Env): string {
  return googleRedirectUri(env);
}

/**
 * Link sent to the owner in Telegram; opens /api/oauth/start which redirects to Google. Until the deployment has a
 * Google OAuth client configured, it leads to the /api/setup page that explains how to create one.
 */
export async function connectLink(env: Env): Promise<string> {
  if (!googleConfigured(env)) return `${env.PUBLIC_URL}/api/setup`;
  const state = await signToken(env.ENCRYPTION_KEY, { owner: env.OWNER_TELEGRAM_ID }, STATE_TTL_MS);
  return `${env.PUBLIC_URL}/api/oauth/start?state=${encodeURIComponent(state)}`;
}

export function googleAuthUrl(env: Env, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    // Forces a refresh token on reconnect as well.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** True when the signed state was issued by this deployment for its owner and has not expired. */
export async function verifyState(env: Env, state: string): Promise<boolean> {
  const data = await verifyToken<{ owner: number }>(env.ENCRYPTION_KEY, state);
  return data?.owner === env.OWNER_TELEGRAM_ID;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  await expectOk("google.token", res);
  return (await res.json()) as TokenResponse;
}

function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { email?: string };
    return data.email ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The Google grant — the only thing the bot keeps between requests

/** What Google granted: kept encrypted in one pinned message of the owner's chat with the bot. */
export interface GoogleGrant {
  email: string | null;
  refresh_token: string;
  scope: string;
}

/**
 * The owner's choices from /settings, kept (unencrypted, nothing secret) next to the grant in the same pinned
 * message. Missing = the defaults.
 */
export interface OwnerSettings {
  /** Minutes before a meeting to remind; [] = no reminders. */
  r?: number[];
  /** Morning list of the day's meetings; false = off. */
  d?: boolean;
  /** Conversation memory per agent, in messages (20 / 50 / 100). */
  m?: number;
  /** Whether Google wakes the bot (Gmail push set up): "ok", or why not (google/pubsub.ts). */
  p?: string;
  /** Where reminders go: t = Telegram, c = Google Calendar notifications (both by default). */
  n?: { t?: boolean; c?: boolean };
  /** The bot's signal calendar (google/signals.ts). */
  sc?: string;
}

/** Keys the owner gave the bot in /settings (Bitrix24, Zoom); kept encrypted in the same pinned message. */
export interface Integrations {
  bitrix?: string;
  zoom?: { accountId: string; clientId: string; clientSecret: string };
}

/**
 * The bot's only storage: the hidden data of ONE pinned message in the owner's chat — the encrypted Google grant
 * (t), the /settings choices (s) and the encrypted integration keys (x). Any of them may be missing.
 */
interface GrantData {
  k: "google";
  t?: string;
  s?: OwnerSettings;
  x?: string;
}

let grantCache: { at: number; grant: GoogleGrant | null; messageId: number | null; data: GrantData | null } | null = null;
let accessCache: { token: string; expiresAt: number } | null = null;
const GRANT_TTL_MS = 60_000;

/** Test hook and reconnect: forget what this instance remembers. */
export function resetGoogleCache(): void {
  grantCache = null;
  accessCache = null;
}

/**
 * The Google grant, read from the chat's pinned message (Telegram returns it with getChat). Null when Google is not
 * connected — or the message was deleted, which is how the owner disconnects.
 */
export async function loadGrant(env: Env): Promise<GoogleGrant | null> {
  if (grantCache && Date.now() - grantCache.at < GRANT_TTL_MS) return grantCache.grant;
  let pinned: TgMessage | undefined;
  try {
    pinned = (await new Telegram(env).call<{ pinned_message?: TgMessage }>("getChat", { chat_id: env.OWNER_TELEGRAM_ID }))
      .pinned_message;
  } catch (err) {
    // No chat yet: the owner has not opened the bot.
    if (err instanceof HttpError && err.status === 400) pinned = undefined;
    else throw err;
  }
  const found = readHidden<GrantData>(pinned);
  const data = found?.k === "google" ? found : null;
  let grant: GoogleGrant | null = null;
  if (data?.t) {
    // Encrypted with another key (the bot token or ENCRYPTION_KEY changed): treated as not connected.
    grant = await decrypt(env.ENCRYPTION_KEY, data.t)
      .then((json) => JSON.parse(json) as GoogleGrant)
      .catch(() => null);
  }
  grantCache = { at: Date.now(), grant, messageId: data ? pinned!.message_id : null, data };
  return grant;
}

/** Bitrix24 / Zoom keys given in /settings (empty when none, or when they cannot be decrypted). */
export async function loadIntegrations(env: Env): Promise<Integrations> {
  await loadGrant(env);
  const x = grantCache?.data?.x;
  if (!x) return {};
  return decrypt(env.ENCRYPTION_KEY, x)
    .then((json) => JSON.parse(json) as Integrations)
    .catch(() => ({}));
}

/** Keeps the integration keys (encrypted) in the pinned message; empty ones are dropped. */
export async function saveIntegrations(env: Env, integrations: Integrations): Promise<void> {
  const clean = Object.fromEntries(Object.entries(integrations).filter(([, v]) => v)) as Integrations;
  await loadGrant(env);
  const data: GrantData = { ...(grantCache?.data ?? { k: "google" }) };
  if (Object.keys(clean).length) data.x = await encrypt(env.ENCRYPTION_KEY, JSON.stringify(clean));
  else delete data.x;
  await writeVault(env, data);
}

/** Writes the pinned message: edited in place when there is one, else sent and pinned. */
async function writeVault(env: Env, data: GrantData): Promise<void> {
  const tg = new Telegram(env);
  const grant = grantCache?.grant ?? null;
  const messageId = grantCache?.messageId;
  if (messageId) {
    await tg.edit(env.OWNER_TELEGRAM_ID, messageId, vaultMessage(data, grant?.email ?? null));
    grantCache = { at: Date.now(), grant, messageId, data };
    return;
  }
  const msg = await tg.send(env.OWNER_TELEGRAM_ID, vaultMessage(data, grant?.email ?? null));
  await tg.call("pinChatMessage", { chat_id: env.OWNER_TELEGRAM_ID, message_id: msg.message_id, disable_notification: true });
  grantCache = { at: Date.now(), grant, messageId: msg.message_id, data };
}

/** The owner's /settings choices (empty until Google is connected, as they live in its pinned message). */
export async function loadOwnerSettings(env: Env): Promise<OwnerSettings> {
  await loadGrant(env);
  return { ...(grantCache?.data?.s ?? {}) };
}

function vaultMessage(data: GrantData, email: string | null): string {
  const head = data.t ? `🔐 <b>Google підключено</b>${email ? `: ${esc(email)}` : ""}` : "🔐 <b>Сховище бота</b>";
  return (
    hiddenData(data) +
    `${head}\n\n` +
    "У цьому закріпленому повідомленні зашифровані доступи бота (Google, Bitrix24, Zoom) і ваші налаштування — " +
    "бот нічого не зберігає деінде. Не відкріплюйте й не видаляйте його: без нього доведеться підключати все заново."
  );
}

/** Saves the owner's /settings choices into the pinned message (edited in place, it stays pinned). */
export async function saveOwnerSettings(env: Env, settings: OwnerSettings): Promise<boolean> {
  await loadGrant(env);
  await writeVault(env, { ...(grantCache?.data ?? { k: "google" }), s: settings });
  return true;
}

export async function hasGoogleAuth(env: Env): Promise<boolean> {
  return !!(await loadGrant(env));
}

/** Whether the grant includes the bot's hidden Drive folder (grants from before the memory feature do not). */
export async function hasDriveScope(env: Env): Promise<boolean> {
  return !!(await loadGrant(env))?.scope.includes("drive.appdata");
}

/** Whether the grant includes Gmail (the owner may have unticked it on Google's screen). */
export async function hasGmailScope(env: Env): Promise<boolean> {
  return !!(await loadGrant(env))?.scope.includes("gmail.modify");
}

async function saveGrant(env: Env, grant: GoogleGrant): Promise<void> {
  const tg = new Telegram(env);
  await loadGrant(env).catch(() => null);
  const previous = grantCache?.messageId;
  // Reconnecting keeps the owner's settings and integration keys.
  const data: GrantData = { ...(grantCache?.data ?? { k: "google" }), t: await encrypt(env.ENCRYPTION_KEY, JSON.stringify(grant)) };
  const msg = await tg.send(env.OWNER_TELEGRAM_ID, vaultMessage(data, grant.email));
  await tg.call("pinChatMessage", { chat_id: env.OWNER_TELEGRAM_ID, message_id: msg.message_id, disable_notification: true });
  grantCache = { at: Date.now(), grant, messageId: msg.message_id, data };
  accessCache = null;
  if (previous && previous !== msg.message_id) {
    await tg.call("deleteMessage", { chat_id: env.OWNER_TELEGRAM_ID, message_id: previous }).catch(() => undefined);
  }
}

/** Exchanges the OAuth code and keeps the grant in the chat. Returns the Google account email and granted scopes. */
export async function completeAuth(env: Env, code: string): Promise<{ email: string | null; scope: string }> {
  const tokens = await tokenRequest({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(env),
    grant_type: "authorization_code",
  });
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token");
  const email = emailFromIdToken(tokens.id_token)?.toLowerCase() ?? null;
  const scope = tokens.scope ?? "";
  await saveGrant(env, { email, refresh_token: tokens.refresh_token, scope });
  accessCache = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  return { email, scope };
}

/**
 * Desktop app flow: after consent Google sends the browser to the loopback address, and the owner pastes that
 * address (or just the code) into the chat. Returns null when the text is not such an answer.
 */
export function parseGoogleAnswer(text: string): { code: string | null; state: string | null; error: string | null } | null {
  const t = text.trim();
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/?]/i.test(t)) {
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      return null;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (!code && !error) return null;
    return { code, state: url.searchParams.get("state"), error };
  }
  // A bare authorization code (Google's codes start with "4/").
  if (/^4\/[0-9A-Za-z_-]{20,}$/.test(t)) return { code: t, state: null, error: null };
  return null;
}

/** Returns a valid access token, refreshing it when it expires within a minute (kept in this instance only). */
export async function getAccessToken(env: Env, forceRefresh = false): Promise<string> {
  if (!forceRefresh && accessCache && accessCache.expiresAt > Date.now() + 60_000) return accessCache.token;
  const grant = await loadGrant(env);
  if (!grant) throw new GoogleAuthRevokedError();
  let tokens: TokenResponse;
  try {
    tokens = await tokenRequest({
      refresh_token: grant.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 400 && err.body.includes("invalid_grant")) throw new GoogleAuthRevokedError();
    throw err;
  }
  accessCache = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  return tokens.access_token;
}

/**
 * Drops the grant (revoked or unusable). The pinned message is deleted — unless it also keeps settings or
 * integration keys: then only the grant is removed from it.
 */
export async function forgetGoogleAuth(env: Env): Promise<void> {
  await loadGrant(env).catch(() => null);
  const messageId = grantCache?.messageId;
  const data = grantCache?.data;
  if (messageId && data && (data.s || data.x)) {
    const { t: _dropped, ...rest } = data;
    grantCache = { at: Date.now(), grant: null, messageId, data: rest };
    accessCache = null;
    await writeVault(env, rest).catch(() => undefined);
    return;
  }
  if (messageId) {
    const tg = new Telegram(env);
    await tg
      .call("deleteMessage", { chat_id: env.OWNER_TELEGRAM_ID, message_id: messageId })
      .catch(() => tg.call("unpinChatMessage", { chat_id: env.OWNER_TELEGRAM_ID, message_id: messageId }).catch(() => undefined));
  }
  grantCache = { at: Date.now(), grant: null, messageId: null, data: null };
  accessCache = null;
}
