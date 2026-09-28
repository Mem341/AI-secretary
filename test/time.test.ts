import { describe, expect, it } from "vitest";
import {
  describeNow,
  formatRange,
  kyivLocalToDate,
  kyivOffsetMinutes,
  parseIsoWithOffset,
  parseKyivLocal,
  toKyivIso,
} from "../src/lib/time";

describe("Europe/Kyiv time helpers", () => {
  it("uses +03:00 in summer and +02:00 in winter", () => {
    expect(kyivOffsetMinutes(new Date("2026-07-01T12:00:00Z"))).toBe(180);
    expect(kyivOffsetMinutes(new Date("2026-12-01T12:00:00Z"))).toBe(120);
  });

  it("converts Kyiv wall-clock time to an instant across DST", () => {
    expect(kyivLocalToDate(2026, 10, 1, 15, 0).toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(kyivLocalToDate(2026, 11, 2, 15, 0).toISOString()).toBe("2026-11-02T13:00:00.000Z");
  });

  it("formats ISO with the Kyiv offset", () => {
    expect(toKyivIso(new Date("2026-10-01T12:00:00Z"))).toBe("2026-10-01T15:00:00+03:00");
    expect(toKyivIso(new Date("2026-12-01T12:00:00Z"))).toBe("2026-12-01T14:00:00+02:00");
  });

  it("parses offsets strictly and local times as Kyiv", () => {
    expect(parseIsoWithOffset("2026-10-01T15:00:00+03:00")?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(parseIsoWithOffset("2026-10-01T15:00:00")).toBeNull();
    expect(parseIsoWithOffset("завтра")).toBeNull();
    expect(parseKyivLocal("2026-10-01T15:00")?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  it("describes now and ranges in Ukrainian", () => {
    const now = new Date("2026-09-28T11:23:00Z");
    expect(describeNow(now)).toBe("2026-09-28, понеділок, 14:23 (Europe/Kyiv, UTC+03:00)");
    expect(formatRange(new Date("2026-10-01T12:00:00Z"), new Date("2026-10-01T13:00:00Z"), now)).toBe(
      "чт, 1 жовтня, 15:00–16:00",
    );
  });
});
