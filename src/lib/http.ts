export class HttpError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${service} HTTP ${status}: ${body.slice(0, 500)}`);
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * fetch with retries for network errors, 429 and 5xx (spec: 3 attempts with a pause).
 * Non-retryable HTTP errors are returned as-is for the caller to handle.
 */
export async function fetchWithRetry(
  input: string,
  init: RequestInit,
  { attempts = 3, baseDelayMs = 1000 }: RetryOptions = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(input, init);
      if (!RETRYABLE.has(res.status) || attempt === attempts) return res;
      lastError = new Error(`HTTP ${res.status}`);
      await res.body?.cancel();
    } catch (err) {
      lastError = err;
      if (attempt === attempts) throw err;
    }
    await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
  }
  throw lastError;
}

export async function expectOk(service: string, res: Response): Promise<Response> {
  if (!res.ok) throw new HttpError(service, res.status, await res.text());
  return res;
}
