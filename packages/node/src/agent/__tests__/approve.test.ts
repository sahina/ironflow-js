import { describe, expect, it } from "vitest";
import type { EventFilter, IronflowEvent, StepClient } from "@ironflow/core";
import { makeApprove } from "../approve.js";

describe("makeApprove()", () => {
  it("returns approved=true when an approval event arrives", async () => {
    const event: IronflowEvent = {
      id: "evt-1",
      name: "ship.approved",
      version: 1,
      data: {
        runId: "run-abc",
        approved: true,
        approver: "user@example.com",
        payload: { score: 0.9 },
      },
      timestamp: new Date(),
    };

    let captured: EventFilter | undefined;
    let capturedName: string | undefined;
    const step = {
      async waitForEvent(name: string, filter: EventFilter) {
        capturedName = name;
        captured = filter;
        return event;
      },
    } as unknown as StepClient;

    const approve = makeApprove(step, "run-abc");
    const result = await approve("ship.approved", { ttl: "1h", payload: { reason: "test" } });

    expect(result.approved).toBe(true);
    expect(result.approver).toBe("user@example.com");
    expect(result.payload).toEqual({ score: 0.9 });
    expect(capturedName).toBe("approve.ship.approved");
    expect(captured?.event).toBe("ship.approved");
    expect(captured?.match).toBe("data.runId");
    expect(captured).toHaveProperty("matchValue", "run-abc");
    expect(captured?.timeout).toBe("1h");
    expect(captured).toHaveProperty("payload", { reason: "test" });
  });

  it("normalizes numeric ttl to ms-suffixed string", async () => {
    let captured: EventFilter | undefined;
    const step = {
      async waitForEvent(_name: string, filter: EventFilter) {
        captured = filter;
        return {
          id: "x",
          name: "x.approved",
          version: 1,
          data: { runId: "r", approved: false },
          timestamp: new Date(),
        };
      },
    } as unknown as StepClient;

    const approve = makeApprove(step, "r");
    await approve("x.approved", { ttl: 30000 });

    expect(captured?.timeout).toBe("30000ms");
  });

  it("returns approved=false when the event explicitly rejects", async () => {
    const step = {
      async waitForEvent() {
        return {
          id: "evt",
          name: "reject.approved",
          version: 1,
          data: { runId: "r", approved: false, reason: "rejected by reviewer" },
          timestamp: new Date(),
        };
      },
    } as unknown as StepClient;

    const approve = makeApprove(step, "r");
    const result = await approve("reject.approved", { ttl: "1m" });

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("rejected by reviewer");
  });

  it("passes an event name with a slash or colon through unchanged", async () => {
    let captured: EventFilter | undefined;
    let capturedName: string | undefined;
    const step = {
      async waitForEvent(name: string, filter: EventFilter) {
        capturedName = name;
        captured = filter;
        return { id: "e", name: filter.event, version: 1, data: { runId: "r", approved: true }, timestamp: new Date() };
      },
    } as unknown as StepClient;

    await makeApprove(step, "r")("deploy/api:approved", { ttl: "1m" });

    expect(captured?.event).toBe("deploy/api:approved");
    expect(capturedName).toBe("approve.deploy/api:approved");
  });

  it.each(["", "   "])("rejects the empty event name %j", async (name) => {
    const step = {
      async waitForEvent() {
        throw new Error("must not wait");
      },
    } as unknown as StepClient;

    await expect(makeApprove(step, "r")(name, { ttl: "1m" })).rejects.toThrow(
      "approve(): event must be a non-empty string"
    );
  });

  it("returns the engine-set emittedBy beside the caller-supplied approver", async () => {
    const make = (emittedBy?: string) => ({
      async waitForEvent() {
        return {
          id: "evt-1",
          name: "ship.approved",
          version: 1,
          data: { runId: "r", approved: true, approver: "alice" },
          timestamp: new Date(),
          emittedBy,
        };
      },
    }) as unknown as StepClient;

    const withKey = await makeApprove(make("apikey:k1"), "r")("ship.approved", { ttl: "1h" });
    expect(withKey.emittedBy).toBe("apikey:k1");
    expect(withKey.approver).toBe("alice");

    const without = await makeApprove(make(), "r")("ship.approved", { ttl: "1h" });
    expect(without.emittedBy).toBeUndefined();
  });
});
