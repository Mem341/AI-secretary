/** Messages of the background queue (Cloudflare Queues). */
export type Job =
  /** Debounced batch of forwarded messages / screenshots; processed only if `seq` is still the latest. */
  | { type: "batch"; draftId: string; seq: number }
  /** Build a card from the draft's source text. */
  | { type: "parse"; draftId: string }
  /** Apply a free-text correction to the card. */
  | { type: "edit"; draftId: string; instruction: string }
  /** Transcribe a voice message, then treat it as text. */
  | { type: "voice"; userId: number; chatId: number; fileId: string; messageId: number; replyTo: number | null }
  /** Incremental calendar sync after a Google push. */
  | { type: "sync"; userId: number }
  /** Full window sync (after OAuth, every 6 h). `notify` tells the owner the result. */
  | { type: "full_sync"; userId: number; notify?: boolean }
  /** Renew the Google push channel. */
  | { type: "renew"; userId: number };
