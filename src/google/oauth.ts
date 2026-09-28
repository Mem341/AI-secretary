import type { Env } from "../env";
import { decrypt, encrypt, fromBase64Url, signToken, verifyToken } from "../lib/crypto";
import { expectOk, fetchWithRetry, HttpError } from "../lib/http";

export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events"];
const STATE_TTL_MS = 30 * 60_000;

/** Thrown when the refresh token no longer works; the owner must reconnect the calendar. */
export class GoogleAuthRevokedError extends Error {
  constructor(readonly userId: number) {
    super(`Google authorization revoked for user ${userId}`);
  }
}

export function redirectUri(env: Env): string {
  return `${env.PUBLIC_URL}/oauth/google/callback`;
}

/** Link sent to the owner in Telegram; opens our /oauth/google/start which redirects to Google. */
export async function connectLink(env: Env, userId: number): Promise<string> {
  const state = await signToken(env.ENCRYPTION_KEY, { uid: userId }, STATE_TTL_MS);
  return `${env.PUBLIC_URL}/oauth/google/start?state=${encodeURIComponent(state)}`;
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
  await env.DB.prepare(
    `INSERT INTO google_auth (user_id, google_email, refresh_token_enc, access_token, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET google_email = excluded.google_email, refresh_token_enc = excluded.refresh_token_enc,
       access_token = excluded.access_token, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      email,
      await encrypt(env.ENCRYPTION_KEY, tokens.refresh_token),
      await encrypt(env.ENCRYPTION_KEY, tokens.access_token),
      now + tokens.expires_in * 1000,
      now,
    )
    .run();
  return { email, scope: tokens.scope ?? "" };
}

export async function hasGoogleAuth(env: Env, userId: number): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM google_auth WHERE user_id = ?").bind(userId).first());
}

/** Returns a valid access token, refreshing it when it expires within a minute. */
export async function getAccessToken(env: Env, userId: number, forceRefresh = false): Promise<string> {
  const row = await env.DB.prepare("SELECT refresh_token_enc, access_token, expires_at FROM google_auth WHERE user_id = ?")
    .bind(userId)
    .first<{ refresh_token_enc: string; access_token: string | null; expires_at: number | null }>();
  if (!row) throw new GoogleAuthRevokedError(userId);
  if (!forceRefresh && row.access_token && (row.expires_at ?? 0) > Date.now() + 60_000) {
    return decrypt(env.ENCRYPTION_KEY, row.access_token);
  }
  let tokens: TokenResponse;
  try {
    tokens = await tokenRequest({
      refresh_token: await decrypt(env.ENCRYPTION_KEY, row.refresh_token_enc),
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
  await env.DB.prepare("UPDATE google_auth SET access_token = ?, expires_at = ?, updated_at = ? WHERE user_id = ?")
    .bind(await encrypt(env.ENCRYPTION_KEY, tokens.access_token), Date.now() + tokens.expires_in * 1000, Date.now(), userId)
    .run();
  return tokens.access_token;
}

/** Removes stored credentials (after revocation or on reconnect failure). */
export async function forgetGoogleAuth(env: Env, userId: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM watch_channels WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM google_auth WHERE user_id = ?").bind(userId),
  ]);
}
