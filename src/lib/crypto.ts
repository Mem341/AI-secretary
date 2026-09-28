const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomId(bytes = 12): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Derives purpose-bound key material from the single ENCRYPTION_KEY secret. */
async function derive(secret: string, purpose: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", enc.encode(`${purpose}\u0000${secret}`));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await derive(secret, "aes-gcm"), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", await derive(secret, "hmac"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

/** AES-256-GCM; output "v1.<iv>.<ciphertext>" in base64url. */
export async function encrypt(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plaintext));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

export async function decrypt(secret: string, payload: string): Promise<string> {
  const [v, iv, ct] = payload.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unsupported ciphertext format");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, await aesKey(secret), fromBase64Url(ct));
  return dec.decode(pt);
}

/** Signed, expiring token: base64url(json).base64url(hmac). */
export async function signToken(secret: string, data: Record<string, unknown>, ttlMs: number): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify({ ...data, exp: Date.now() + ttlMs })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifyToken<T extends Record<string, unknown>>(secret: string, token: string): Promise<T | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = fromBase64Url(sig);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sigBytes, enc.encode(body));
  if (!ok) return null;
  const data = JSON.parse(dec.decode(fromBase64Url(body))) as T & { exp: number };
  return data.exp > Date.now() ? data : null;
}

/** Constant-time string comparison for secrets from request headers. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
