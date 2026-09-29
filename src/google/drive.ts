import type { Env } from "../env";
import { expectOk, fetchWithRetry, HttpError } from "../lib/http";
import { getAccessToken } from "./oauth";

/**
 * One JSON file in the bot's hidden folder on the owner's Google Drive (appDataFolder): invisible in Drive, reachable
 * only by this app. Used for the conversation memory.
 */

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

const fileIds = new Map<string, string>();

export function resetDriveCache(): void {
  fileIds.clear();
}

async function authed(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken(env);
  const res = await fetchWithRetry(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  return expectOk(`drive ${init.method ?? "GET"}`, res);
}

async function findFile(env: Env, name: string): Promise<string | null> {
  const cached = fileIds.get(name);
  if (cached) return cached;
  const params = new URLSearchParams({ spaces: "appDataFolder", q: `name = '${name}'`, fields: "files(id)", pageSize: "1" });
  const { files } = (await (await authed(env, `${API}?${params}`)).json()) as { files?: { id: string }[] };
  const id = files?.[0]?.id ?? null;
  if (id) fileIds.set(name, id);
  return id;
}

/** The file's JSON, or null when there is none yet. */
export async function readAppFile<T>(env: Env, name: string): Promise<T | null> {
  const id = await findFile(env, name);
  if (!id) return null;
  try {
    return (await (await authed(env, `${API}/${id}?alt=media`)).json()) as T;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      fileIds.delete(name);
      return null;
    }
    throw err;
  }
}

export async function writeAppFile(env: Env, name: string, data: unknown): Promise<void> {
  const body = JSON.stringify(data);
  const id = await findFile(env, name);
  if (id) {
    await authed(env, `${UPLOAD}/${id}?uploadType=media`, { method: "PATCH", headers: { "content-type": "application/json" }, body });
    return;
  }
  const boundary = `ais${Date.now()}`;
  const multipart =
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ["appDataFolder"] })}\r\n` +
    `--${boundary}\r\ncontent-type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await authed(env, `${UPLOAD}?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  fileIds.set(name, ((await res.json()) as { id: string }).id);
}
