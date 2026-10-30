import { describe, expect, it } from "vitest";

import { createRunVersionFilter } from "./run-events.js";
import type { SubscriptionEvent } from "./types.js";

const frame = (topic: string, data: unknown): SubscriptionEvent => ({ topic, data });
const run = (id: string, leaf: string, version?: number): SubscriptionEvent =>
  frame(`system.run.${id}.${leaf}`, { id, version });

describe("createRunVersionFilter", () => {
  it("drops a lower version that arrives after a higher one (#3283)", () => {
    const keep = createRunVersionFilter();
    const seen: string[] = [];
    for (const e of [run("r1", "completed", 5), run("r1", "updated", 3)]) {
      if (keep(e)) seen.push(e.topic);
    }
    expect(seen).toEqual(["system.run.r1.completed"]);
  });

  it("passes frames in order, and a tie (one write publishes two frames)", () => {
    const keep = createRunVersionFilter();
    expect(keep(run("r1", "created", 1))).toBe(true);
    expect(keep(run("r1", "updated", 2))).toBe(true);
    expect(keep(run("r1", "failed", 4))).toBe(true);
    expect(keep(run("r1", "updated", 4))).toBe(true);
  });

  it("ranks each run on its own", () => {
    const keep = createRunVersionFilter();
    expect(keep(run("r1", "completed", 9))).toBe(true);
    expect(keep(run("r2", "updated", 2))).toBe(true);
  });

  it("keeps a frame with no usable version and never ranks it", () => {
    const keep = createRunVersionFilter();
    expect(keep(run("r1", "completed", 5))).toBe(true);
    for (const version of [undefined, 0, -1, 1.5, "7", null]) {
      expect(keep(frame("system.run.r1.updated", { id: "r1", version }))).toBe(true);
    }
    expect(keep(frame("system.run.r1.updated", null))).toBe(true);
    // An unversioned frame did not lower the bar either.
    expect(keep(run("r1", "updated", 4))).toBe(false);
  });

  it("passes step frames and topics outside system.run", () => {
    const keep = createRunVersionFilter();
    expect(keep(run("r1", "completed", 5))).toBe(true);
    expect(keep(frame("system.run.r1.step.s1.completed", { version: 1 }))).toBe(true);
    expect(keep(frame("events:order.created", { version: 1 }))).toBe(true);
    expect(keep(frame("system.function.f1.updated", { version: 1 }))).toBe(true);
  });

  it("remembers deletion against late ranked and unknown frames", () => {
    const keep = createRunVersionFilter();
    expect(keep(run("r1", "completed", 5))).toBe(true);
    expect(keep(run("r1", "deleted"))).toBe(true);
    expect(keep(run("r1", "deleted"))).toBe(true);
    for (const version of [undefined, 0, 1, 6]) {
      expect(keep(run("r1", "updated", version))).toBe(false);
      expect(keep(frame("system.run.r1.step.s1.updated", { version }))).toBe(false);
    }
    expect(keep(run("r2", "updated", 1))).toBe(true);
  });

  it("bounds deletion memory and ranks steps independently", () => {
    const keep = createRunVersionFilter({ maxRuns: 2 });
    keep(run("r1", "deleted"));
    const step = (id: string, version?: number) => frame(`system.run.r2.step.${id}.updated`, { version });
    expect(keep(step("s1", 5))).toBe(true);
    expect(keep(step("s1", 4))).toBe(false);
    expect(keep(step("s1", 5))).toBe(true);
    expect(keep(step("s1"))).toBe(true);
    expect(keep(step("s2", 1))).toBe(true);
    expect(keep(run("r1", "updated", 1))).toBe(true);
  });

  it("forgets the least recently seen run past maxRuns", () => {
    const keep = createRunVersionFilter({ maxRuns: 2 });
    keep(run("a", "updated", 5));
    keep(run("b", "updated", 5));
    keep(run("a", "updated", 6)); // refreshes a, so b is the oldest
    keep(run("c", "updated", 5)); // evicts b
    expect(keep(run("a", "updated", 4))).toBe(false);
    expect(keep(run("b", "updated", 1))).toBe(true);
  });
});

describe("dotted step identities", () => {
  it("orders the full step identity", () => {
    const keep = createRunVersionFilter();
    expect(keep(run("r", "step.r:memory.get:0.completed", 5))).toBe(true);
    expect(keep(run("r", "step.r:memory.get:0.updated", 4))).toBe(false);
    expect(keep(run("r", "step.r:memory.put:0.updated", 1))).toBe(true);
    expect(keep(run("r", "step.r:memory.get:0.updated", 5))).toBe(true);
  });
  it("blocks dotted steps after deletion, including unknown versions", () => {
    const keep = createRunVersionFilter();
    keep(run("r", "deleted"));
    for (const version of [undefined, 0, 6]) {
      expect(keep(run("r", "step.r:memory.get:0.updated", version))).toBe(false);
    }
  });
});
