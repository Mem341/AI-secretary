import { exec, one } from "../db/client";
import { type Env, googleConfigured, googleRedirectUri } from "../env";
import { decrypt, encrypt, fromBase64Url, signToken, verifyToken } from "../lib/crypto";
import { expectOk, fetchWithRetry, HttpError } from "../lib/http";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  // Read/write/send Gmail except permanently deleting; plus managing label definitions.
  // NOTE: these are Google "restricted" scopes. A published but unverified app still works for its single owner
  // (Google shows an "unverified app" warning); a consent screen left in "Testing" expires grants after 7 days.
  // See /api/setup for the options.
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
];
const STATE_TTL_MS = 30 * 60_000;

/** Thrown when the refresh token no longer works; the owner must reconnect the calendar. */
export class GoogleAuthRevokedError extends Error {
  constructor(readonly userId: number) {
    super(`Google authorization revoked for user ${userId}`);
  }
}

export function redirectUri(env: Env): string {
  return googleRedirectUri(env);
}

/**
 * Link sent to the owner in Telegram; opens /api/oauth/start which redirects to Google. Until the deployment has a
 * Google OAuth client configured, it leads to the /api/setup page that explains how to create one.
 */
export async function connectLink(env: Env, userId: number): Promise<string> {
  if (!googleConfigured(env)) return `${env.PUBLIC_URL}/api/setup`;
  const state = await signToken(env.ENCRYPTION_KEY, { uid: userId }, STATE_TTL_MS);
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

export async function verifyState(env: Env, state: string): Promise<number | null> {
  const data = await verifyToken<{ uid: number }>(env.ENCRYPTION_KEY, state);
  return data && Number.isSafeInteger(data.uid) ? data.uid : null;
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

/** Exchanges the OAuth code and stores encrypted tokens. Returns the Google account email. */
export async function completeAuth(env: Env, userId: number, code: string): Promise<{ email: string | null; scope: string }> {
  const tokens = await tokenRequest({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(env),
    grant_type: "authorization_code",
  });
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token");
  const email = emailFromIdToken(tokens.id_token);
  const now = Date.now();
  await exec(
    env.db,
    `INSERT INTO google_auth (user_id, google_email, refresh_token_enc, access_token, expires_at, granted_scope, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET google_email = EXCLUDED.google_email, refresh_token_enc = EXCLUDED.refresh_token_enc,
       access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at, granted_scope = EXCLUDED.granted_scope,
       updated_at = EXCLUDED.updated_at`,
    [
      userId,
      email,
      await encrypt(env.ENCRYPTION_KEY, tokens.refresh_token),
      await encrypt(env.ENCRYPTION_KEY, tokens.access_token),
      now + tokens.expires_in * 1000,
      tokens.scope ?? "",
      now,
    ],
  );
  return { email, scope: tokens.scope ?? "" };
}

export async function hasGoogleAuth(env: Env, userId: number): Promise<boolean> {
  return !!(await one(env.db, "SELECT 1 FROM google_auth WHERE user_id = $1", [userId]));
}

/** Whether the owner's current Google grant includes Gmail access (they may have connected before it existed). */
export async function hasGmailScope(env: Env, userId: number): Promise<boolean> {
  const row = await one<{ granted_scope: string | null }>(env.db, "SELECT granted_scope FROM google_auth WHERE user_id = $1", [
    userId,
  ]);
  return !!row?.granted_scope?.includes("gmail.modify");
}

/** Returns a valid access token, refreshing it when it expires within a minute. */
export async function getAccessToken(env: Env, userId: number, forceRefresh = false): Promise<string> {
  const row = await one<{ refresh_token_enc: string; access_token: string | null; expires_at: number | null }>(
    env.db,
    "SELECT refresh_token_enc, access_token, expires_at FROM google_auth WHERE user_id = $1",
    [userId],
  );
  if (!row) throw new GoogleAuthRevokedError(userId);
  if (!forceRefresh && row.access_token && (row.expires_at ?? 0) > Date.now() + 60_000) {
    const cached = await decrypt(env.ENCRYPTION_KEY, row.access_token).catch(() => null);
    if (cached) return cached;
  }
  // Undecryptable token: ENCRYPTION_KEY (or the bot token it is derived from) changed — reconnect is needed.
  const refreshToken = await decrypt(env.ENCRYPTION_KEY, row.refresh_token_enc).catch(() => null);
  if (!refreshToken) throw new GoogleAuthRevokedError(userId);
  let tokens: TokenResponse;
  try {
    tokens = await tokenRequest({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 400 && err.body.includes("invalid_grant")) {
      throw new GoogleAuthRevokedError(userId);
    }
    throw err;
  }
  await exec(env.db, "UPDATE google_auth SET access_token = $1, expires_at = $2, updated_at = $3 WHERE user_id = $4", [
    await encrypt(env.ENCRYPTION_KEY, tokens.access_token),
    Date.now() + tokens.expires_in * 1000,
    Date.now(),
    userId,
  ]);
  return tokens.access_token;
}

/** Removes stored credentials (after revocation or on reconnect failure). */
export async function forgetGoogleAuth(env: Env, userId: number): Promise<void> {
  await exec(env.db, "DELETE FROM watch_channels WHERE user_id = $1", [userId]);
  await exec(env.db, "DELETE FROM gmail_state WHERE user_id = $1", [userId]);
  await exec(env.db, "DELETE FROM google_auth WHERE user_id = $1", [userId]);
}
