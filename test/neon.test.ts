import { afterEach, describe, expect, it, vi } from "vitest";
import { neonDb } from "../src/db/client";

afterEach(() => vi.restoreAllMocks());

describe("neonDb", () => {
  it("sends $n parameters over HTTP and parses BIGINT columns as numbers", async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sent = { url: String(input), body: JSON.parse(String(init?.body)) };
      return Response.json({
        command: "SELECT",
        rowCount: 1,
        rowAsArray: true,
        fields: [
          { name: "tg_id", dataTypeID: 20 },
          { name: "name", dataTypeID: 25 },
          { name: "n", dataTypeID: 23 },
        ],
        rows: [["1790600000123", "Іван", "7"]],
      });
    });
    const db = neonDb("postgresql://user:pass@ep-test-123.eu-central-1.aws.neon.tech/neondb?sslmode=require");
    const res = await db.query("SELECT tg_id, name, n FROM users WHERE id = $1", [5]);
    expect(sent!.url).toMatch(/^https:\/\/[^/]*neon\.tech\/sql$/);
    expect(sent!.body).toMatchObject({ query: "SELECT tg_id, name, n FROM users WHERE id = $1", params: ["5"] });
    expect(res).toEqual({ rows: [{ tg_id: 1790600000123, name: "Іван", n: 7 }], rowCount: 1 });
  });
});
