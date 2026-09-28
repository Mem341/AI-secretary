import { type Db, exec, all } from "./client";

/**
 * Schema migrations, applied automatically on the first request of a cold instance (and by `npm run db:migrate`).
 * All timestamps are epoch milliseconds (UTC). Append new migrations; never edit applied ones.
 */
export const MIGRATIONS: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      // The single owner of the bot (OWNER_TELEGRAM_ID).
      `CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        tg_id         BIGINT NOT NULL UNIQUE,
        tg_username   TEXT,
        email         TEXT,
        full_name     TEXT,
        position      TEXT,
        phone         TEXT,
        defaults_json TEXT   NOT NULL DEFAULT '{}',
        dialog_state  TEXT,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
      )`,
      // Address book: names → emails, learned from created meetings and /contact.
      `CREATE TABLE IF NOT EXISTS contacts (
        id         SERIAL PRIMARY KEY,
        name       TEXT   NOT NULL,
        email      TEXT   NOT NULL UNIQUE,
        updated_at BIGINT NOT NULL
      )`,
      // Google OAuth tokens, AES-GCM encrypted.
      `CREATE TABLE IF NOT EXISTS google_auth (
        user_id           INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        google_email      TEXT,
        refresh_token_enc TEXT   NOT NULL,
        access_token      TEXT,
        expires_at        BIGINT,
        updated_at        BIGINT NOT NULL
      )`,
      // Google Calendar push channel (events.watch) and incremental sync state.
      `CREATE TABLE IF NOT EXISTS watch_channels (
        user_id      INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        channel_id   TEXT   NOT NULL UNIQUE,
        resource_id  TEXT   NOT NULL,
        token        TEXT   NOT NULL,
        expiration   BIGINT NOT NULL,
        sync_token   TEXT,
        last_sync_at BIGINT,
        updated_at   BIGINT NOT NULL
      )`,
      // Mirror of the owner's calendar events.
      `CREATE TABLE IF NOT EXISTS meetings (
        id              TEXT    PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        gcal_event_id   TEXT    NOT NULL,
        title           TEXT,
        description     TEXT,
        start_at        BIGINT  NOT NULL,
        end_at          BIGINT  NOT NULL,
        location        TEXT,
        meet_url        TEXT,
        html_link       TEXT,
        attendees_json  TEXT    NOT NULL DEFAULT '[]',
        organizer_email TEXT,
        status          TEXT    NOT NULL,
        source          TEXT    NOT NULL DEFAULT 'calendar',
        gcal_created_at BIGINT,
        created_at      BIGINT  NOT NULL,
        updated_at      BIGINT  NOT NULL,
        UNIQUE (user_id, gcal_event_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_meetings_user_start ON meetings (user_id, start_at)`,
      // Meeting cards awaiting confirmation; source_text keeps the edit history.
      `CREATE TABLE IF NOT EXISTS drafts (
        id              TEXT    PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        card_json       TEXT,
        source_type     TEXT    NOT NULL,
        source_text     TEXT    NOT NULL DEFAULT '',
        state           TEXT    NOT NULL,
        batch_seq       INTEGER NOT NULL DEFAULT 0,
        card_message_id BIGINT,
        edits_count     INTEGER NOT NULL DEFAULT 0,
        meeting_id      TEXT,
        created_at      BIGINT  NOT NULL,
        updated_at      BIGINT  NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_drafts_user_state ON drafts (user_id, state, updated_at)`,
      // At most one batch being collected per user; forwarded messages are appended to it atomically.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_collecting ON drafts (user_id) WHERE state = 'collecting'`,
      // Reminders and recording requests (stage 2). sent_at is set before sending — protects from duplicates.
      `CREATE TABLE IF NOT EXISTS reminders (
        id         SERIAL  PRIMARY KEY,
        meeting_id TEXT    NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        kind       TEXT    NOT NULL,
        fire_at    BIGINT  NOT NULL,
        sent_at    BIGINT,
        UNIQUE (meeting_id, user_id, kind)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (sent_at, fire_at)`,
      // Recordings and summaries (stage 3).
      `CREATE TABLE IF NOT EXISTS recordings (
        id                TEXT    PRIMARY KEY,
        meeting_id        TEXT    REFERENCES meetings (id) ON DELETE SET NULL,
        user_id           INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        blob_url          TEXT    NOT NULL,
        duration_sec      INTEGER,
        status            TEXT    NOT NULL,
        transcript_url    TEXT,
        created_at        BIGINT  NOT NULL,
        updated_at        BIGINT  NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS summaries (
        meeting_id          TEXT    PRIMARY KEY REFERENCES meetings (id) ON DELETE CASCADE,
        summary_md          TEXT    NOT NULL,
        decisions_json      TEXT    NOT NULL DEFAULT '[]',
        tasks_json          TEXT    NOT NULL DEFAULT '[]',
        open_questions_json TEXT    NOT NULL DEFAULT '[]',
        version             INTEGER NOT NULL DEFAULT 1,
        created_at          BIGINT  NOT NULL,
        updated_at          BIGINT  NOT NULL
      )`,
      // Error log, sent to the owner as well.
      `CREATE TABLE IF NOT EXISTS errors (
        id      SERIAL PRIMARY KEY,
        ts      BIGINT NOT NULL,
        scope   TEXT   NOT NULL,
        user_id INTEGER,
        message TEXT   NOT NULL,
        payload TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_errors_ts ON errors (ts)`,
    ],
  },
  {
    version: 2,
    statements: [
      // Which draft flow this row belongs to: a meeting card, an action on an existing meeting
      // (reschedule/cancel/note), or a Gmail action. `card_json` holds the JSON payload for any kind.
      `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'meeting'`,
      // The OAuth scopes Google actually granted (space-separated) — lets the bot tell whether Gmail access
      // was consented to without a second OAuth client.
      `ALTER TABLE google_auth ADD COLUMN IF NOT EXISTS granted_scope TEXT`,
      // Marks a Google Calendar event the bot itself just wrote (create/reschedule/cancel), so the push that
      // Google sends back for that very write is not mistaken for an externally-made change.
      `CREATE TABLE IF NOT EXISTS recent_writes (
        gcal_event_id TEXT   PRIMARY KEY,
        until         BIGINT NOT NULL
      )`,
      // Points a sent Telegram message back to the meeting or Gmail message it is about, so a reply to it
      // (e.g. "перенеси на завтра", "відповідай: добре") can act on the right thing.
      `CREATE TABLE IF NOT EXISTS message_links (
        message_id BIGINT PRIMARY KEY,
        ref_type   TEXT   NOT NULL,
        ref_id     TEXT   NOT NULL,
        created_at BIGINT NOT NULL
      )`,
      // Gmail push (users.watch) subscription and incremental sync state, one per owner — mirrors watch_channels.
      `CREATE TABLE IF NOT EXISTS gmail_state (
        user_id    INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        history_id TEXT,
        expiration BIGINT,
        updated_at BIGINT NOT NULL
      )`,
    ],
  },
];

/** Applies pending migrations. Idempotent and safe to run concurrently (IF NOT EXISTS / ON CONFLICT). */
export async function migrate(db: Db): Promise<number[]> {
  await exec(db, "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)");
  const applied = new Set((await all<{ version: number }>(db, "SELECT version FROM schema_migrations")).map((r) => r.version));
  const done: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    for (const statement of m.statements) await exec(db, statement);
    await exec(db, "INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING", [m.version, Date.now()]);
    done.push(m.version);
  }
  return done;
}
