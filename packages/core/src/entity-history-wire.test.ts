import { describe, expect, it } from "vitest";
import { collectEntityHistory, ENTITY_HISTORY_PAGE_SIZE, type EntityHistoryPageWire } from "./entity-history-wire.js";
import { IronflowError, ValidationError } from "./errors.js";

// Serves versions 1..total in pages of the requested limit, as the server does.
function server(total: number) {
  const seen: Array<Record<string, unknown>> = [];
  const fetchPage = async (body: Record<string, unknown>): Promise<EntityHistoryPageWire> => {
    seen.push(body);
    const from = Math.max(Number(body.fromVersion), 1);
    const last = Math.min(from + Number(body.limit) - 1, total);
    const entries = [];
    for (let v = from; v <= last; v++) entries.push({ eventName: "e", entityVersion: String(v) });
    return { entries, nextCursor: last < total ? String(last + 1) : undefined };
  };
  return { seen, fetchPage };
}

describe("collectEntityHistory", () => {
  it("pages with the large page size until the cursor is empty", async () => {
    const { seen, fetchPage } = server(1201);
    const history = await collectEntityHistory(fetchPage, "order/1");
    expect(history).toHaveLength(1201);
    expect(history.at(-1)?.version).toBe(1201);
    expect(seen.map((b) => [b.fromVersion, b.limit])).toEqual([
      [0, ENTITY_HISTORY_PAGE_SIZE],
      [501, ENTITY_HISTORY_PAGE_SIZE],
      [1001, ENTITY_HISTORY_PAGE_SIZE],
    ]);
  });

  it("stops at limit and asks only for the entries it still needs", async () => {
    const { seen, fetchPage } = server(2000);
    const history = await collectEntityHistory(fetchPage, "order/1", { limit: 700 });
    expect(history).toHaveLength(700);
    expect(seen.map((b) => b.limit)).toEqual([500, 200]);
    expect(await collectEntityHistory(fetchPage, "order/1", { limit: 0 })).toEqual([]);
  });

  it("sends a string bound unchanged and converts a Date", async () => {
    const { seen, fetchPage } = server(1);
    await collectEntityHistory(fetchPage, "order/1", {
      from: new Date("2026-10-06T00:00:00Z"),
      to: "2026-10-06T12:00:00.123456789Z",
    });
    expect(seen[0]).toMatchObject({
      fromTimestamp: "2026-10-06T00:00:00.000Z",
      toTimestamp: "2026-10-06T12:00:00.123456789Z",
    });
  });

  it("treats an empty string as unset and rejects bad bounds before any request", async () => {
    const { seen, fetchPage } = server(1);
    await collectEntityHistory(fetchPage, "order/1", { from: "" });
    expect(seen[0]?.fromTimestamp).toBeUndefined();
    await expect(collectEntityHistory(fetchPage, "order/1", { to: "yesterday" })).rejects.toBeInstanceOf(ValidationError);
    await expect(collectEntityHistory(fetchPage, "order/1", { from: new Date("nope") })).rejects.toBeInstanceOf(ValidationError);
    await expect(collectEntityHistory(fetchPage, "order/1", { limit: -1 })).rejects.toBeInstanceOf(ValidationError);
    expect(seen).toHaveLength(1);
  });

  it("throws when the cursor does not advance", async () => {
    const fetchPage = async (body: Record<string, unknown>) => ({ entries: [], nextCursor: String(body.fromVersion) });
    await expect(collectEntityHistory(fetchPage, "order/1", { fromVersion: 4 })).rejects.toThrow(IronflowError);
  });
});
