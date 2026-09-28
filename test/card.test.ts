import { describe, expect, it } from "vitest";
import {
  buildDescription,
  buildEventBody,
  findFreeSlots,
  findInDirectory,
  formatLabel,
  normalizeCard,
  renderCard,
} from "../src/bot/card";
import { kyivLocalToDate } from "../src/lib/time";
import { makeOwner } from "./helpers";

const directory = [
  { name: "Олег Мельник", email: "o.melnyk@acme.ua" },
  { name: "Ірина Шевченко", email: "i.shevchenko@acme.ua" },
];

describe("normalizeCard", () => {
  const owner = makeOwner();

  it("fills defaults from the profile and resolves staff emails from the directory", () => {
    const card = normalizeCard(
      {
        title: null,
        start: "2026-10-01T15:00:00+03:00",
        duration_min: null,
        format: null,
        location: null,
        attendees: [
          { name: "Іван Петренко", email: "Ivan@Example.com", internal: false },
          { name: "Олег", email: null, internal: false },
          { name: "Олександр Коваленко", email: null, internal: true },
        ],
        agenda: ["Кошторис", "", "Терміни"],
        confidence: 0.9,
      },
      owner,
      directory,
    );
    expect(card.duration_min).toBe(60);
    expect(card.format).toBe("offline");
    expect(card.location).toBe("вул. Хрещатик, 1, Київ");
    expect(card.attendees).toEqual([
      { name: "Іван Петренко", email: "ivan@example.com", internal: false },
      { name: "Олег", email: "o.melnyk@acme.ua", internal: true },
    ]);
    expect(card.title).toBe("Іван Петренко + Олександр");
    expect(card.agenda).toEqual(["Кошторис", "Терміни"]);
  });

  it("never invents data: invalid email and unknown time stay empty", () => {
    const card = normalizeCard(
      { start: "у четвер", date: "2026-10-01", attendees: [{ name: "Партнер", email: "not-an-email" }], confidence: "x" },
      owner,
      directory,
    );
    expect(card.start).toBeNull();
    expect(card.date).toBe("2026-10-01");
    expect(card.attendees[0]!.email).toBeNull();
    expect(card.confidence).toBe(0);
  });

  it("accepts a local time without offset as Kyiv time", () => {
    const card = normalizeCard({ start: "2026-12-01T10:00", confidence: 1 }, owner, directory);
    expect(card.start).toBe("2026-12-01T10:00:00+02:00");
  });

  it("drops location for Google Meet", () => {
    const card = normalizeCard({ format: "google_meet", location: "офіс", confidence: 1 }, owner, directory);
    expect(card.location).toBeNull();
  });

  it("accepts zoom as a format and drops its location too", () => {
    const card = normalizeCard({ format: "zoom", location: "офіс", confidence: 1 }, owner, directory);
    expect(card.format).toBe("zoom");
    expect(card.location).toBeNull();
  });
});

describe("findInDirectory", () => {
  it("matches full name, unique first name, ignores apostrophes and case", () => {
    expect(findInDirectory(directory, "ірина шевченко")?.email).toBe("i.shevchenko@acme.ua");
    expect(findInDirectory(directory, "Олег")?.email).toBe("o.melnyk@acme.ua");
    expect(findInDirectory([...directory, { name: "Олег Бондар", email: "b@r.ua" }], "Олег")).toBeNull();
  });
});

describe("findFreeSlots", () => {
  // Monday 2026-09-28 08:00 Kyiv
  const now = kyivLocalToDate(2026, 9, 28, 8, 0);

  it("offers the first free slot of each working day", () => {
    const busy = [{ start: kyivLocalToDate(2026, 9, 28, 9).getTime(), end: kyivLocalToDate(2026, 9, 28, 11).getTime() }];
    const slots = findFreeSlots({ now, durationMin: 60, busy });
    expect(slots.map((d) => d.toISOString())).toEqual([
      kyivLocalToDate(2026, 9, 28, 11).toISOString(),
      kyivLocalToDate(2026, 9, 29, 9).toISOString(),
      kyivLocalToDate(2026, 9, 30, 9).toISOString(),
    ]);
  });

  it("skips weekends and respects a fixed date", () => {
    const friday = kyivLocalToDate(2026, 10, 2, 17, 0);
    const slots = findFreeSlots({ now: friday, durationMin: 30, busy: [] });
    expect(slots[0]!.toISOString()).toBe(kyivLocalToDate(2026, 10, 5, 9).toISOString());

    const onDate = findFreeSlots({ now, durationMin: 60, busy: [], date: "2026-10-01" });
    expect(onDate.map((d) => d.toISOString())).toEqual([
      kyivLocalToDate(2026, 10, 1, 9).toISOString(),
      kyivLocalToDate(2026, 10, 1, 9, 30).toISOString(),
      kyivLocalToDate(2026, 10, 1, 10).toISOString(),
    ]);
  });
});

describe("Google event", () => {
  const owner = makeOwner();
  const card = normalizeCard(
    {
      title: "Іван Петренко + Олександр",
      start: "2026-10-01T15:00:00+03:00",
      duration_min: 45,
      format: "google_meet",
      attendees: [
        { name: "Іван Петренко", email: "ivan@example.com" },
        { name: "Партнер", email: null },
      ],
      initiator: "Іван Петренко",
      purpose: "Обговорити бюджет на ремонт номерів",
      agenda: ["Кошторис", "Терміни"],
      agreed_via: "Telegram",
      agreed_at: "2026-09-28",
      confidence: 0.9,
    },
    owner,
    [],
  );

  it("invites attendees with email, lets guests edit and creates a Meet link", () => {
    const body = buildEventBody(card, owner, "draft1") as Record<string, any>;
    expect(body.start).toEqual({ dateTime: "2026-10-01T15:00:00+03:00", timeZone: "Europe/Kyiv" });
    expect(body.end.dateTime).toBe("2026-10-01T15:45:00+03:00");
    expect(body.attendees).toEqual([{ email: "ivan@example.com", displayName: "Іван Петренко" }]);
    expect(body.guestsCanModify).toBe(true);
    expect(body.guestsCanInviteOthers).toBe(true);
    expect(body.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
    expect(body.location).toBeUndefined();
  });

  it("describes initiator, agenda, agreement and owner contacts", () => {
    const text = buildDescription(card, owner);
    expect(text).toContain("Ініціатор: Іван Петренко");
    expect(text).toContain("• Кошторис");
    expect(text).toContain("Домовились: 28.09.2026 у Telegram");
    expect(text).toContain("Контакти організатора: Олександр Коваленко, Директор з розвитку");
    expect(text).toContain("тел. +380671234567 · Telegram @oleksandr_k — краще писати, ніж дзвонити.");
  });

  it("renders warnings for missing email and conflicts, escaping HTML", () => {
    const html = renderCard(
      { ...card, title: "<b>x</b>", missing: ["email Партнера"] },
      {
        now: new Date("2026-09-28T10:00:00Z"),
        conflicts: [
          {
            title: "Планерка",
            start_at: Date.parse("2026-10-01T12:30:00Z"),
            end_at: Date.parse("2026-10-01T13:30:00Z"),
          } as never,
        ],
      },
    );
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("Партнер — ⚠️ немає email");
    expect(html).toContain("⚠️ Перетин з «Планерка» 15:30–16:30");
    expect(html).toContain("⚠️ Не вистачає: email Партнера");
  });

  it("puts the Zoom join link in the event location and description once created", () => {
    const zoomCard = { ...card, format: "zoom" as const };
    const body = buildEventBody(zoomCard, owner, "draft1", "https://zoom.us/j/123") as Record<string, any>;
    expect(body.location).toBe("https://zoom.us/j/123");
    expect(body.conferenceData).toBeUndefined();
    expect(body.description).toContain("Приєднатися до Zoom: https://zoom.us/j/123");
    expect(formatLabel(zoomCard)).toContain("Zoom");
  });

  it("has no location for Zoom before the meeting is created", () => {
    const body = buildEventBody({ ...card, format: "zoom" as const }, owner, "draft1") as Record<string, any>;
    expect(body.location).toBeUndefined();
  });
});
