import { afterEach, describe, expect, it } from "vitest";
import { appendBatch, expectAnswer, firstTime, resetSession, takeAnswer, takeBatch } from "../src/session";
import { hiddenData, hiddenEntity, hiddenSize, MAX_HIDDEN, readHidden } from "../src/telegram/hidden";
import type { TgMessage } from "../src/telegram/types";

afterEach(() => resetSession());

const asMessage = (html: string): TgMessage => ({
  message_id: 1,
  date: 0,
  chat: { id: 1, type: "private" },
  text: html,
  entities: [hiddenEntity(html)!],
});

describe("data hidden in a message", () => {
  it("round-trips through the invisible link Telegram returns as an entity", () => {
    const data = { k: "card", id: "abc", card: { title: "Іван Петренко + Олександр", attendees: [{ email: "ivan@example.com" }] } };
    const html = hiddenData(data) + "📅 <b>Нова зустріч</b>";
    expect(html).toMatch(/^<a href="https:\/\/t\.me\/\?ais=[A-Za-z0-9_-]+">​<\/a>/);
    expect(readHidden(asMessage(html))).toEqual(data);
  });

  it("ignores messages without it, and ordinary links", () => {
    expect(readHidden(undefined)).toBeNull();
    expect(readHidden({ message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "hi" })).toBeNull();
    expect(
      readHidden({ message_id: 1, date: 0, chat: { id: 1, type: "private" }, entities: [{ type: "text_link", offset: 0, length: 1, url: "https://example.com" }] }),
    ).toBeNull();
  });

  it("a typical card fits well within the limit", () => {
    const card = {
      title: "Іван Петренко, Марія Коваль + Олександр",
      start: "2026-10-01T15:00:00+03:00",
      attendees: Array.from({ length: 5 }, (_, i) => ({ name: `Учасник ${i}`, email: `person${i}@example.com`, internal: false })),
      purpose: "Обговорити бюджет проєкту та терміни запуску",
      agenda: ["Бюджет", "Терміни", "Команда"],
      missing: [],
    };
    expect(hiddenSize({ k: "card", id: "abcdefghijkl", card })).toBeLessThan(MAX_HIDDEN);
  });
});

describe("instance session", () => {
  it("debounces a burst: only the latest sequence number takes the batch", () => {
    appendBatch(1, "a", "forward");
    const batch = appendBatch(1, "b", "forward");
    expect(takeBatch(1, 1)).toBeNull();
    expect(takeBatch(1, batch.seq)!.lines).toEqual(["a", "b"]);
    expect(takeBatch(1, batch.seq)).toBeNull();
  });

  it("remembers the last question once, and dedupes keys", () => {
    expectAnswer(1, { k: "clarify" });
    expect(takeAnswer(1)).toEqual({ k: "clarify" });
    expect(takeAnswer(1)).toBeNull();
    expect(firstTime("x", 1000)).toBe(true);
    expect(firstTime("x", 1000)).toBe(false);
  });
});
