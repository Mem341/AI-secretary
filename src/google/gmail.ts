import type { Env } from "../env";
import { fromBase64Url, toBase64Url } from "../lib/crypto";
import { expectOk, fetchWithRetry } from "../lib/http";
import { getAccessToken } from "./oauth";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GHeader {
  name: string;
  value: string;
}

interface GPart {
  mimeType?: string;
  headers?: GHeader[];
  body?: { data?: string; size?: number };
  parts?: GPart[];
}

export interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GPart;
}

export interface GLabel {
  id: string;
  name: string;
  type?: "system" | "user";
}

/** A Gmail message reduced to what the bot shows and needs for replying. */
export interface MailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  /** RFC 2822 Message-ID and References — needed to thread a reply. */
  messageId: string | null;
  references: string | null;
  bodyText: string;
}

const decoder = new TextDecoder();

function header(part: GPart | undefined, name: string): string {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBody(data: string | undefined): string {
  return data ? decoder.decode(fromBase64Url(data)) : "";
}

/** Plain text from HTML: drops tags, scripts and styles, decodes the common entities, collapses blank lines. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefers the text/plain part anywhere in the MIME tree; falls back to text/html converted to text. */
export function extractBody(part: GPart | undefined): string {
  if (!part) return "";
  const find = (p: GPart, mime: string): string | null => {
    if (p.mimeType === mime && p.body?.data) return decodeBody(p.body.data);
    for (const child of p.parts ?? []) {
      const found = find(child, mime);
      if (found !== null) return found;
    }
    return null;
  };
  const plain = find(part, "text/plain");
  if (plain !== null) return plain.trim();
  const html = find(part, "text/html");
  if (html !== null) return htmlToText(html);
  return decodeBody(part.body?.data).trim();
}

export function toMailMessage(m: GMessage): MailMessage {
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m.payload, "From"),
    to: header(m.payload, "To"),
    subject: header(m.payload, "Subject"),
    date: header(m.payload, "Date"),
    snippet: m.snippet ?? "",
    unread: m.labelIds?.includes("UNREAD") ?? false,
    messageId: header(m.payload, "Message-ID") || header(m.payload, "Message-Id") || null,
    references: header(m.payload, "References") || null,
    bodyText: extractBody(m.payload),
  };
}

/** RFC 2047 encoded-word for non-ASCII header values (subjects, display names). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export interface OutgoingMail {
  to: string[];
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  cc?: string[];
  bcc?: string[];
}

/** An RFC 2822 message, base64url-encoded as Gmail's `raw` field expects. */
export function buildRawMessage(mail: OutgoingMail): string {
  const headers = [
    `To: ${mail.to.join(", ")}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.join(", ")}`] : []),
    ...(mail.bcc?.length ? [`Bcc: ${mail.bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  if (mail.inReplyTo) {
    headers.push(`In-Reply-To: ${mail.inReplyTo}`);
    headers.push(`References: ${[mail.references, mail.inReplyTo].filter(Boolean).join(" ")}`);
  }
  // Body lines wrapped at 76 characters as base64 transfer encoding requires.
  const body = (Buffer.from(mail.body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
  return toBase64Url(new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n${body}`));
}

/** "Re: …" without piling up prefixes. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

/** The bare address from a "Name <addr>" header. */
export function addressOf(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
}

/** The display name from a "Name <addr>" header, or the address. */
export function nameOf(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>/.exec(from);
  return (m?.[1] ?? from).trim();
}

/** Gmail API client for the owner's mailbox. */
export class Gmail {
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
    await expectOk(`gmail ${init.method ?? "GET"} ${path.split("?")[0]}`, res);
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /** Any Gmail API call under users/me (the agent tools use it for threads, drafts and labels). */
  call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.request<T>(path, init);
  }

  /** Message ids for a Gmail search query (same syntax as the Gmail search box). */
  async search(query: string, maxResults = 5): Promise<string[]> {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    const res = await this.request<{ messages?: { id: string }[] }>(`/messages?${params}`);
    return (res.messages ?? []).map((m) => m.id);
  }

  async get(id: string): Promise<MailMessage> {
    return toMailMessage(await this.request<GMessage>(`/messages/${encodeURIComponent(id)}?format=full`));
  }

  async send(mail: OutgoingMail, threadId?: string): Promise<{ id: string; threadId: string }> {
    return this.request("/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw: buildRawMessage(mail), ...(threadId ? { threadId } : {}) }),
    });
  }

  async createDraft(mail: OutgoingMail, threadId?: string): Promise<{ id: string }> {
    return this.request("/drafts", {
      method: "POST",
      body: JSON.stringify({ message: { raw: buildRawMessage(mail), ...(threadId ? { threadId } : {}) } }),
    });
  }

  async modify(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    await this.request(`/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
  }

  /** Moves to Trash (recoverable for 30 days) — the bot never deletes mail permanently. */
  async trash(id: string): Promise<void> {
    await this.request(`/messages/${encodeURIComponent(id)}/trash`, { method: "POST" });
  }

  async labels(): Promise<GLabel[]> {
    return (await this.request<{ labels?: GLabel[] }>("/labels")).labels ?? [];
  }

  async createLabel(name: string, hidden = false): Promise<GLabel> {
    return this.request<GLabel>("/labels", {
      method: "POST",
      body: JSON.stringify(
        hidden
          ? { name, labelListVisibility: "labelHide", messageListVisibility: "hide" }
          : { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
      ),
    });
  }

  /** Finds a user label by name (case-insensitive) or creates it. */
  async ensureLabel(name: string, hidden = false): Promise<GLabel> {
    const existing = (await this.labels()).find((l) => l.name.toLowerCase() === name.toLowerCase());
    return existing ?? this.createLabel(name, hidden);
  }

  /** Push notifications about mailbox changes to a Cloud Pub/Sub topic (expires after ~7 days). */
  async watch(topicName: string): Promise<{ historyId: string; expiration: string }> {
    return this.request("/watch", {
      method: "POST",
      body: JSON.stringify({ topicName, labelIds: ["INBOX"], labelFilterBehavior: "include" }),
    });
  }

  async stop(): Promise<void> {
    await this.request("/stop", { method: "POST" });
  }
}
