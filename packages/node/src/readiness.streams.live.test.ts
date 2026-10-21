/**
 * Live test: the entity-streams group (#3003) through the Node client. The
 * group needs no seed: this SDK creates and deletes its own stream, so no other
 * SDK's stream and not the shared seed entity can be reached.
 * Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";
import { ConflictError, ContendedError } from "./index.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

describe.skipIf(!SEED_PATH)("readiness streams — live server", () => {
  const client = new IronflowClient({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    apiKey: process.env["IRONFLOW_TEST_API_KEY"],
  });
  const { streams } = client;
  const id = `readiness-streams-node-${process.hrtime.bigint()}`;
  const entityType = "readiness";
  // The non-ASCII value proves the SDK decodes event data as UTF-8.
  const data = (n: number) => ({ n, who: "José" });
  const event = (n: number) => ({ name: `readiness.step.${n}`, entityType, data: data(n) });

  it("stream-append", async () => {
    const first = await streams.append(id, event(1), { expectedVersion: 0 });
    expect(first).toMatchObject({ entityVersion: 1, eventId: expect.any(String) });
    const second = await streams.append(id, event(2), { expectedVersion: 1 });
    expect(second.entityVersion).toBe(2);
    expect(second.eventId).not.toBe(first.eventId);
    // Another writer got to version 2 first: the server answers aborted and writes nothing.
    await expect(streams.append(id, event(3), { expectedVersion: 1 })).rejects.toBeInstanceOf(ContendedError);
    // 0 means "create only".
    await expect(streams.append(id, event(3), { expectedVersion: 0 })).rejects.toBeInstanceOf(ContendedError);
    // "$" is reserved for platform events such as the delete tombstone. These stream
    // calls answer the Connect code; the server text names the rule.
    await expect(streams.append(id, { ...event(3), name: "$mine" })).rejects.toMatchObject({
      code: "invalid_argument",
      message: expect.stringMatching(/prefix is reserved/),
    });
    expect((await streams.getInfo(id))!.version).toBe(2);
  });

  it("stream-read", async () => {
    const all = await streams.read(id);
    expect(all.totalCount).toBe(2);
    expect(all.events.map((e) => [e.name, e.entityVersion, e.data])).toEqual([
      ["readiness.step.1", 1, data(1)],
      ["readiness.step.2", 2, data(2)],
    ]);
    expect(all.events[0]).toMatchObject({ id: expect.any(String), timestamp: expect.stringMatching(/^\d{4}-/) });
    const last = await streams.read(id, { direction: "backward", limit: 1 });
    expect(last.events.map((e) => e.entityVersion)).toEqual([2]);
    const from = await streams.read(id, { fromVersion: 2 });
    expect(from.events.map((e) => e.entityVersion)).toEqual([2]);
  });

  it("stream-info", async () => {
    expect(await streams.getInfo(id)).toMatchObject({
      entityId: id,
      entityType,
      version: 2,
      eventCount: 2,
      createdAt: expect.stringMatching(/^\d{4}-/),
      updatedAt: expect.stringMatching(/^\d{4}-/),
    });
    // A stream with no events reads as null, so a caller can pass expectedVersion 0.
    expect(await streams.getInfo(`${id}-unknown`)).toBeNull();
  });

  it("stream-list", async () => {
    const listed = (await streams.listStreams()).find((s) => s.entityId === id);
    expect(listed).toMatchObject({ entityType, version: 2, eventCount: 2, lastEventAt: expect.stringMatching(/^\d{4}-/) });
  });

  it("stream-history", async () => {
    const history = await streams.getEntityHistory(id);
    expect(history.map((e) => [e.eventName, e.version, e.data])).toEqual([
      ["readiness.step.1", 1, data(1)],
      ["readiness.step.2", 2, data(2)],
    ]);
    expect(history[0]!.timestamp).toMatch(/^\d{4}-/);
    expect((await streams.getEntityHistory(id, { limit: 1 })).map((e) => e.version)).toEqual([1]);
    // `from` and `to` are inclusive and a string is sent unchanged, so each event's own time selects it.
    expect((await streams.getEntityHistory(id, { to: history[0]!.timestamp })).map((e) => e.version)).toEqual([1]);
    expect((await streams.getEntityHistory(id, { from: history[1]!.timestamp })).map((e) => e.version)).toEqual([2]);
  });

  it("snapshot-create and snapshot-get", async () => {
    const state = (n: number) => ({ count: n, who: "José" });
    for (const n of [1, 2]) {
      const created = await streams.createSnapshot(id, { entityType, entityVersion: n, state: state(n) });
      expect(created.snapshotId).toEqual(expect.any(String));
    }
    expect(await streams.getSnapshot(id)).toMatchObject({
      snapshotId: expect.any(String),
      entityId: id,
      entityType,
      entityVersion: 2,
      state: state(2),
      createdAt: expect.stringMatching(/^\d{4}-/),
    });
    // The latest snapshot at or before the version asked for.
    expect(await streams.getSnapshot(id, { beforeVersion: 1 })).toMatchObject({ entityVersion: 1, state: state(1) });
    // A 400 is told apart by the server text.
    await expect(
      streams.createSnapshot(id, { entityType, entityVersion: 3, state: state(3) })
    ).rejects.toMatchObject({ code: "invalid_argument", message: expect.stringMatching(/exceeds current stream version/) });
    await expect(
      streams.createSnapshot(id, { entityType, entityVersion: 2, state: state(2) })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("stream-delete", async () => {
    expect(await streams.delete(id)).toEqual({ entityVersion: 3 });
    await expect(streams.append(id, event(3))).rejects.toThrow(/stream is deleted/i);
    await expect(
      streams.createSnapshot(id, { entityType, entityVersion: 2, state: {} })
    ).rejects.toThrow(/stream is deleted/i);
    // The delete drops snapshots.
    await expect(streams.getSnapshot(id)).rejects.toMatchObject({ code: "not_found" });
    // Reads keep answering, and the tombstone is the last event.
    const { events } = await streams.read(id);
    expect(events.map((e) => [e.name, e.entityVersion])).toEqual([
      ["readiness.step.1", 1],
      ["readiness.step.2", 2],
      ["$stream.deleted", 3],
    ]);
    expect(await streams.getInfo(id)).toMatchObject({ version: 3 });
    expect((await streams.listStreams()).map((s) => s.entityId)).not.toContain(id);
    await expect(streams.delete(id)).rejects.toThrow(/already deleted/i);
    // Purge removes the events below the tombstone; the tombstone stays.
    expect(await streams.delete(id, { purge: true })).toEqual({ entityVersion: 3 });
    expect((await streams.read(id)).events.map((e) => e.name)).toEqual(["$stream.deleted"]);
  });
});
