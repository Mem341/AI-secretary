-- AI-secretary: initial schema (spec section 5).
-- All timestamps are epoch milliseconds (UTC). Audio and transcripts live in R2; D1 keeps keys only.

-- Owners (managers), internal members. Row with active = 1 is the whitelist entry.
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id         INTEGER NOT NULL UNIQUE,
  tg_username   TEXT,
  email         TEXT,
  full_name     TEXT,
  position      TEXT,
  phone         TEXT,
  role          TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  defaults_json TEXT    NOT NULL DEFAULT '{}',
  -- Current step of a multi-message dialog (onboarding, settings); NULL when idle.
  dialog_state  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_users_email ON users (lower(email));

-- Google OAuth tokens, AES-GCM encrypted.
CREATE TABLE google_auth (
  user_id           INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  google_email      TEXT,
  refresh_token_enc TEXT    NOT NULL,
  access_token      TEXT,
  expires_at        INTEGER,
  updated_at        INTEGER NOT NULL
);

-- Google Calendar push channel (events.watch) and incremental sync state; one per user.
CREATE TABLE watch_channels (
  user_id     INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  channel_id  TEXT    NOT NULL UNIQUE,
  resource_id TEXT    NOT NULL,
  token       TEXT    NOT NULL,
  expiration  INTEGER NOT NULL,
  sync_token  TEXT,
  last_sync_at INTEGER,
  updated_at  INTEGER NOT NULL
);

-- Mirror of the owner's calendar events.
CREATE TABLE meetings (
  id              TEXT    PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  gcal_event_id   TEXT    NOT NULL,
  title           TEXT,
  description     TEXT,
  start_at        INTEGER NOT NULL,
  end_at          INTEGER NOT NULL,
  location        TEXT,
  meet_url        TEXT,
  html_link       TEXT,
  attendees_json  TEXT    NOT NULL DEFAULT '[]',
  organizer_email TEXT,
  -- confirmed | cancelled
  status          TEXT    NOT NULL,
  -- bot | calendar
  source          TEXT    NOT NULL DEFAULT 'calendar',
  gcal_created_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (user_id, gcal_event_id)
);
CREATE INDEX idx_meetings_user_start ON meetings (user_id, start_at);

-- Meeting cards awaiting confirmation.
CREATE TABLE drafts (
  id              TEXT    PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  card_json       TEXT,
  -- text | voice | forward | screenshot
  source_type     TEXT    NOT NULL,
  -- Everything the card was built from, edits appended; the edit history.
  source_text     TEXT    NOT NULL DEFAULT '',
  -- collecting | parsing | clarify | pending | editing | creating | created | cancelled | failed
  state           TEXT    NOT NULL,
  -- Incremented on each message added to a collecting batch (debounce of forwarded series).
  batch_seq       INTEGER NOT NULL DEFAULT 0,
  card_message_id INTEGER,
  edits_count     INTEGER NOT NULL DEFAULT 0,
  meeting_id      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_drafts_user_state ON drafts (user_id, state, updated_at);
-- At most one batch being collected per user; forwarded messages are appended to it atomically.
CREATE UNIQUE INDEX idx_drafts_collecting ON drafts (user_id) WHERE state = 'collecting';

-- Reminders and recording requests fired by the per-minute cron (stage 2).
-- sent_at is set before sending, which protects against duplicates.
CREATE TABLE reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT    NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- before_30 | ask_recording
  kind       TEXT    NOT NULL,
  fire_at    INTEGER NOT NULL,
  sent_at    INTEGER,
  UNIQUE (meeting_id, user_id, kind)
);
CREATE INDEX idx_reminders_due ON reminders (sent_at, fire_at);

-- Uploaded recordings and processing status (stage 3).
CREATE TABLE recordings (
  id                TEXT    PRIMARY KEY,
  meeting_id        TEXT    REFERENCES meetings (id) ON DELETE SET NULL,
  user_id           INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  r2_key            TEXT    NOT NULL,
  duration_sec      INTEGER,
  status            TEXT    NOT NULL,
  transcript_r2_key TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Meeting summaries (stage 3).
CREATE TABLE summaries (
  meeting_id          TEXT    PRIMARY KEY REFERENCES meetings (id) ON DELETE CASCADE,
  summary_md          TEXT    NOT NULL,
  decisions_json      TEXT    NOT NULL DEFAULT '[]',
  tasks_json          TEXT    NOT NULL DEFAULT '[]',
  open_questions_json TEXT    NOT NULL DEFAULT '[]',
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Error log for the administrator.
CREATE TABLE errors (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  scope   TEXT    NOT NULL,
  user_id INTEGER,
  message TEXT    NOT NULL,
  payload TEXT
);
CREATE INDEX idx_errors_ts ON errors (ts);
