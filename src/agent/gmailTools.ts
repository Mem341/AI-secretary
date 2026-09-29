import type { Env } from "../env";
import { addressOf, buildRawMessage, type GLabel, type GMessage, Gmail, replySubject, toMailMessage } from "../google/gmail";
import { str, type Tool } from "./runner";

/**
 * The tools of the n8n "Gmail Agent" sub-workflow (MSG / THREAD / DRAFT / LABEL). Permanent deletion is not
 * possible with the bot's Gmail permission (gmail.modify), so "delete" is Trash — recoverable for 30 days.
 */

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
const s = (description: string) => ({ type: "string", description });
const list = (v: string) => v.split(/[,;]/).map((x) => x.trim()).filter(Boolean);

function brief(m: GMessage, full = false): Record<string, unknown> {
  const mail = toMailMessage(m);
  return {
    id: mail.id,
    threadId: mail.threadId,
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    date: mail.date,
    unread: mail.unread,
    snippet: mail.snippet,
    ...(full ? { body: mail.bodyText.slice(0, 6000) } : {}),
    link: `https://mail.google.com/mail/u/0/#inbox/${mail.id}`,
  };
}

function query(a: Record<string, unknown>): string {
  const q = str(a, "SearchQuery");
  const status = str(a, "ReadStatus");
  const read = status === "unread" ? "is:unread" : status === "read" ? "is:read" : "";
  return [q, read].filter(Boolean).join(" ");
}

export function gmailTools(env: Env): Tool[] {
  const gmail = new Gmail(env);
  const get = (id: string) => gmail.call<GMessage>(`/messages/${encodeURIComponent(id)}?format=full`);

  /** Label names or ids → ids; unknown names are created. */
  async function labelIds(value: unknown): Promise<string[]> {
    const wanted = Array.isArray(value) ? value.map(String) : list(typeof value === "string" ? value : "");
    const labels = (await gmail.call<{ labels?: GLabel[] }>("/labels")).labels ?? [];
    const ids: string[] = [];
    for (const w of wanted) {
      const found = labels.find((l) => l.id === w || l.name.toLowerCase() === w.toLowerCase());
      ids.push(found ? found.id : (await gmail.createLabel(w)).id);
    }
    return ids;
  }

  async function reply(messageId: string, text: string, a: Record<string, unknown>, threadId?: string) {
    const target = toMailMessage(await get(messageId));
    const raw = buildRawMessage({
      to: [addressOf(target.from)],
      cc: list(str(a, "CC")),
      bcc: list(str(a, "BCC")),
      subject: replySubject(target.subject),
      body: text,
      inReplyTo: target.messageId,
      references: target.references,
    });
    return gmail.call("/messages/send", { method: "POST", body: JSON.stringify({ raw, threadId: threadId || target.threadId }) });
  }

  const searchProps = {
    SearchQuery: s("Gmail search query like from: to: subject: has:attachment newer_than:2d etc. Empty string for all."),
    ReadStatus: { type: "string", enum: ["unread", "read", "both"], description: "Filter by read status" },
  };
  const ccProps = { CC: s("CC recipients comma separated, empty if not needed"), BCC: s("BCC recipients comma separated, empty if not needed") };

  return [
    {
      spec: { name: "msg_get_many", description: "Search messages (max 10).", parameters: object(searchProps, []) },
      async run(a) {
        const ids = await gmail.search(query(a), 10);
        return Promise.all(ids.map(async (id) => brief(await gmail.call<GMessage>(`/messages/${id}?format=full`))));
      },
    },
    {
      spec: { name: "msg_get", description: "Get one message with its text.", parameters: object({ MessageId: s("The ID of the message to retrieve") }, ["MessageId"]) },
      async run(a) {
        return brief(await get(str(a, "MessageId")), true);
      },
    },
    {
      spec: {
        name: "msg_send",
        description: "Send a new email. Show a preview to the user and send only after they confirm.",
        parameters: object({ To: s("Recipient email address(es), comma separated"), Subject: s("Email subject line"), Message: s("Email body content"), ...ccProps }, [
          "To",
          "Subject",
          "Message",
        ]),
      },
      async run(a) {
        const raw = buildRawMessage({ to: list(str(a, "To")), cc: list(str(a, "CC")), bcc: list(str(a, "BCC")), subject: str(a, "Subject"), body: str(a, "Message") });
        return gmail.call("/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
      },
    },
    {
      spec: {
        name: "msg_reply",
        description: "Reply to a message (in its thread). Show a preview and send only after the user confirms.",
        parameters: object({ MessageId: s("The ID of the message to reply to"), Message: s("Reply body content"), ...ccProps }, ["MessageId", "Message"]),
      },
      async run(a) {
        return reply(str(a, "MessageId"), str(a, "Message"), a);
      },
    },
    {
      spec: { name: "msg_trash", description: "Move a message to Trash (recoverable). Only after the user confirms.", parameters: object({ MessageId: s("The ID of the message") }, ["MessageId"]) },
      async run(a) {
        await gmail.trash(str(a, "MessageId"));
        return { ok: true };
      },
    },
    {
      spec: {
        name: "msg_add_label",
        description: "Add labels to a message.",
        parameters: object({ MessageId: s("Message ID"), Labels: s("Label names or IDs, comma separated") }, ["MessageId", "Labels"]),
      },
      async run(a) {
        await gmail.modify(str(a, "MessageId"), await labelIds(a.Labels), []);
        return { ok: true };
      },
    },
    {
      spec: {
        name: "msg_remove_label",
        description: "Remove labels from a message.",
        parameters: object({ MessageId: s("Message ID"), Labels: s("Label names or IDs, comma separated") }, ["MessageId", "Labels"]),
      },
      async run(a) {
        await gmail.modify(str(a, "MessageId"), [], await labelIds(a.Labels));
        return { ok: true };
      },
    },
    {
      spec: { name: "msg_mark_read", description: "Mark a message as read.", parameters: object({ MessageId: s("Message ID") }, ["MessageId"]) },
      async run(a) {
        await gmail.modify(str(a, "MessageId"), [], ["UNREAD"]);
        return { ok: true };
      },
    },
    {
      spec: { name: "msg_mark_unread", description: "Mark a message as unread.", parameters: object({ MessageId: s("Message ID") }, ["MessageId"]) },
      async run(a) {
        await gmail.modify(str(a, "MessageId"), ["UNREAD"], []);
        return { ok: true };
      },
    },
    {
      spec: { name: "thread_get", description: "Get a whole thread (conversation).", parameters: object({ ThreadId: s("Thread ID") }, ["ThreadId"]) },
      async run(a) {
        const t = await gmail.call<{ id: string; messages?: GMessage[] }>(`/threads/${encodeURIComponent(str(a, "ThreadId"))}?format=full`);
        return { id: t.id, messages: (t.messages ?? []).map((m) => brief(m, true)) };
      },
    },
    {
      spec: { name: "thread_get_many", description: "Search threads (max 10).", parameters: object(searchProps, []) },
      async run(a) {
        const params = new URLSearchParams({ q: query(a), maxResults: "10" });
        return (await gmail.call<{ threads?: { id: string; snippet?: string }[] }>(`/threads?${params}`)).threads ?? [];
      },
    },
    {
      spec: {
        name: "thread_reply",
        description: "Reply in a thread to a specific message. Show a preview and send only after the user confirms.",
        parameters: object({ ThreadId: s("Thread ID"), MessageId: s("The message in the thread to reply to"), Message: s("Reply body"), ...ccProps }, [
          "ThreadId",
          "MessageId",
          "Message",
        ]),
      },
      async run(a) {
        return reply(str(a, "MessageId"), str(a, "Message"), a, str(a, "ThreadId"));
      },
    },
    ...(["add", "remove"] as const).map(
      (op): Tool => ({
        spec: {
          name: `thread_${op}_label`,
          description: `${op === "add" ? "Add labels to" : "Remove labels from"} a thread.`,
          parameters: object({ ThreadId: s("Thread ID"), Labels: s("Label names or IDs, comma separated") }, ["ThreadId", "Labels"]),
        },
        async run(a) {
          const ids = await labelIds(a.Labels);
          await gmail.call(`/threads/${encodeURIComponent(str(a, "ThreadId"))}/modify`, {
            method: "POST",
            body: JSON.stringify(op === "add" ? { addLabelIds: ids } : { removeLabelIds: ids }),
          });
          return { ok: true };
        },
      }),
    ),
    ...(["trash", "untrash"] as const).map(
      (op): Tool => ({
        spec: {
          name: `thread_${op}`,
          description: op === "trash" ? "Move a thread to Trash (after the user confirms)." : "Restore a thread from Trash.",
          parameters: object({ ThreadId: s("Thread ID") }, ["ThreadId"]),
        },
        async run(a) {
          await gmail.call(`/threads/${encodeURIComponent(str(a, "ThreadId"))}/${op}`, { method: "POST" });
          return { ok: true };
        },
      }),
    ),
    {
      spec: {
        name: "draft_create",
        description: "Create a draft.",
        parameters: object({ To: s("Recipients, comma separated (optional)"), Subject: s("Draft subject line"), Message: s("Draft body content"), ...ccProps }, [
          "Subject",
          "Message",
        ]),
      },
      async run(a) {
        const raw = buildRawMessage({ to: list(str(a, "To")), cc: list(str(a, "CC")), bcc: list(str(a, "BCC")), subject: str(a, "Subject"), body: str(a, "Message") });
        return gmail.call("/drafts", { method: "POST", body: JSON.stringify({ message: { raw } }) });
      },
    },
    {
      spec: { name: "draft_get_many", description: "List drafts (max 10).", parameters: object({}, []) },
      async run() {
        return (await gmail.call<{ drafts?: unknown[] }>("/drafts?maxResults=10")).drafts ?? [];
      },
    },
    {
      spec: { name: "draft_get", description: "Get a draft.", parameters: object({ DraftId: s("Draft ID") }, ["DraftId"]) },
      async run(a) {
        const d = await gmail.call<{ id: string; message: GMessage }>(`/drafts/${encodeURIComponent(str(a, "DraftId"))}?format=full`);
        return { id: d.id, message: brief(d.message, true) };
      },
    },
    {
      spec: { name: "draft_delete", description: "Delete a draft.", parameters: object({ DraftId: s("Draft ID") }, ["DraftId"]) },
      async run(a) {
        await gmail.call(`/drafts/${encodeURIComponent(str(a, "DraftId"))}`, { method: "DELETE" });
        return { ok: true };
      },
    },
    {
      spec: { name: "label_create", description: "Create a label.", parameters: object({ LabelName: s("Name for the new label") }, ["LabelName"]) },
      async run(a) {
        return gmail.createLabel(str(a, "LabelName"));
      },
    },
    {
      spec: { name: "label_get_many", description: "List labels.", parameters: object({}, []) },
      async run() {
        return (await gmail.call<{ labels?: GLabel[] }>("/labels")).labels ?? [];
      },
    },
    {
      spec: { name: "label_delete", description: "Delete a label.", parameters: object({ LabelId: s("Label ID") }, ["LabelId"]) },
      async run(a) {
        await gmail.call(`/labels/${encodeURIComponent(str(a, "LabelId"))}`, { method: "DELETE" });
        return { ok: true };
      },
    },
  ];
}
