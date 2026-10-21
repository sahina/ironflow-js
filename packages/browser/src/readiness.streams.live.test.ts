// @vitest-environment node
/**
 * Live test: the entity-streams group (#3003) through the browser client. Delete
 * is outside the browser's boundary (ADR 0092), so it stops at the snapshots. The
 * group needs no seed: this SDK creates its own stream, so no other SDK's stream
 * and not the shared seed entity can be reached.
 * Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { ironflow } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

describe.skipIf(!SEED_PATH)("readiness streams — live server", () => {
  ironflow.configure({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    auth: { apiKey: process.env["IRONFLOW_TEST_API_KEY"] },
  });
  const { streams } = ironflow;
  const id = `readiness-streams-browser-${process.hrtime.bigint()}`;
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
    // The browser stream calls give no SDK error class; the Connect code is on the error.
    await expect(streams.append(id, event(3), { expectedVersion: 1 })).rejects.toMatchObject({ status: 409, code: "aborted" });
    // 0 means "create only".
    await expect(streams.append(id, event(3), { expectedVersion: 0 })).rejects.toMatchObject({ status: 409, code: "aborted" });
    // "$" is reserved for platform events such as the delete tombstone.
    await expect(streams.append(id, { ...event(3), name: "$mine" })).rejects.toMatchObject({ code: "invalid_argument" });
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
    await expect(
      streams.createSnapshot(id, { entityType, entityVersion: 3, state: state(3) })
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      streams.createSnapshot(id, { entityType, entityVersion: 2, state: state(2) })
    ).rejects.toMatchObject({ code: "already_exists" });
  });
});
