import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { createDraft, getDraft } from "../src/db/drafts";
import { cancelMeetingByEvent, getMeetingByEvent, updateMeetingFields, upsertMeeting } from "../src/db/meetings";
import { findMessageLink, linkMessage } from "../src/db/messageLinks";
import { isSelfWrite, markSelfWrite, pruneSelfWrites } from "../src/db/selfWrites";
import { pgliteDb, resetDb } from "./helpers";

let db: Db;
beforeAll(async () => {
  db = await pgliteDb();
});
beforeEach(async () => {
  await resetDb(db);
});

const meetingInput = {
  title: "Зустріч",
  description: null,
  start_at: 1_800_000_000_000,
  end_at: 1_800_003_600_000,
  location: null,
  meet_url: null,
  html_link: null,
  attendees: [],
  organizer_email: null,
  gcal_created_at: null,
};

async function seedUser(): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO users (tg_id, created_at, updated_at) VALUES (1, 0, 0) RETURNING id",
  );
  return rows[0]!.id;
}

describe("upsertMeeting", () => {
  it("reports a fresh insert, then reports the same id as an update on conflict", async () => {
    const userId = await seedUser();
    const first = await upsertMeeting(db, userId, "ev1", meetingInput);
    expect(first.inserted).toBe(true);
    const second = await upsertMeeting(db, userId, "ev1", { ...meetingInput, title: "Оновлено" });
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    const row = await getMeetingByEvent(db, userId, "ev1");
    expect(row?.title).toBe("Оновлено");
  });

  it("keeps the original source across an update (does not let a push overwrite a bot-created meeting)", async () => {
    const userId = await seedUser();
    const { id } = await upsertMeeting(db, userId, "ev1", meetingInput, "bot");
    await upsertMeeting(db, userId, "ev1", meetingInput, "calendar");
    const row = await getMeetingByEvent(db, userId, "ev1");
    expect(row?.id).toBe(id);
    expect(row?.source).toBe("bot");
  });
});

describe("cancelMeetingByEvent", () => {
  it("returns true only for a genuine transition to cancelled", async () => {
    const userId = await seedUser();
    await upsertMeeting(db, userId, "ev1", meetingInput);
    expect(await cancelMeetingByEvent(db, userId, "ev1")).toBe(true);
    expect(await cancelMeetingByEvent(db, userId, "ev1")).toBe(false);
    expect(await cancelMeetingByEvent(db, userId, "unknown")).toBe(false);
  });
});

describe("updateMeetingFields", () => {
  it("updates only the given fields", async () => {
    const userId = await seedUser();
    const { id } = await upsertMeeting(db, userId, "ev1", meetingInput);
    await updateMeetingFields(db, id, { start_at: 1_800_100_000_000, end_at: 1_800_103_600_000 });
    const row = await getMeetingByEvent(db, userId, "ev1");
    expect(row).toMatchObject({ start_at: 1_800_100_000_000, end_at: 1_800_103_600_000, title: "Зустріч" });
  });
});

describe("self-writes", () => {
  it("marks a write, reports it while fresh, and prune removes expired markers", async () => {
    await markSelfWrite(db, "ev1");
    expect(await isSelfWrite(db, "ev1")).toBe(true);
    expect(await isSelfWrite(db, "ev2")).toBe(false);
    await db.query("UPDATE recent_writes SET until = $1 WHERE gcal_event_id = 'ev1'", [Date.now() - 1]);
    expect(await isSelfWrite(db, "ev1")).toBe(false);
    await pruneSelfWrites(db);
    const { rows } = await db.query("SELECT 1 FROM recent_writes");
    expect(rows).toHaveLength(0);
  });
});

describe("message links", () => {
  it("links a message to a meeting or a mail message and can be overwritten", async () => {
    await linkMessage(db, 42, "meeting", "m1");
    expect(await findMessageLink(db, 42)).toEqual({ ref_type: "meeting", ref_id: "m1" });
    await linkMessage(db, 42, "mail", "msg-2");
    expect(await findMessageLink(db, 42)).toEqual({ ref_type: "mail", ref_id: "msg-2" });
    expect(await findMessageLink(db, 999)).toBeNull();
  });
});

describe("draft kind", () => {
  it("defaults to 'meeting' and stores 'action'/'mail' kinds with their target meeting", async () => {
    const userId = await seedUser();
    const meetingDraftId = await createDraft(db, userId, "text", "hi", "parsing");
    expect((await getDraft(db, meetingDraftId))?.kind).toBe("meeting");

    const actionDraftId = await createDraft(db, userId, "text", "перенеси", "parsing", null, {
      kind: "action",
      meetingId: "m1",
    });
    const actionDraft = await getDraft(db, actionDraftId);
    expect(actionDraft?.kind).toBe("action");
    expect(actionDraft?.meeting_id).toBe("m1");
  });
});
