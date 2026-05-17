import { describe, expect, it } from "vitest";
import type { EventFilter, IronflowEvent, StepClient } from "@ironflow/core";
import { makeApprove } from "../approve.js";

describe("makeApprove()", () => {
  it("returns approved=true when an approval event arrives", async () => {
    const event: IronflowEvent = {
      id: "evt-1",
      name: "agent.approve.ship",
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
    const step = {
      async waitForEvent(_name: string, filter: EventFilter) {
        captured = filter;
        return event;
      },
    } as unknown as StepClient;

    const approve = makeApprove(step, "run-abc");
    const result = await approve("ship", { ttl: "1h", payload: { reason: "test" } });

    expect(result.approved).toBe(true);
    expect(result.approver).toBe("user@example.com");
    expect(result.payload).toEqual({ score: 0.9 });
    expect(captured?.event).toBe("agent.approve.ship");
    expect(captured?.match).toBe('data.runId == "run-abc"');
    expect(captured?.timeout).toBe("1h");
  });

  it("returns approved=false with reason='timeout' when waitForEvent yields null", async () => {
    const step = {
      async waitForEvent(): Promise<null> {
        return null as unknown as never;
      },
    } as unknown as StepClient;

    const approve = makeApprove(step, "run-abc");
    const result = await approve("anything", { ttl: "5m" });

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("normalizes numeric ttl to ms-suffixed string", async () => {
    let captured: EventFilter | undefined;
    const step = {
      async waitForEvent(_name: string, filter: EventFilter) {
        captured = filter;
        return {
          id: "x",
          name: "agent.approve.x",
          version: 1,
          data: { runId: "r", approved: false },
          timestamp: new Date(),
        };
      },
    } as unknown as StepClient;

    const approve = makeApprove(step, "r");
    await approve("x", { ttl: 30000 });

    expect(captured?.timeout).toBe("30000ms");
  });

  it("returns approved=false when the event explicitly rejects", async () => {
    const step = {
      async waitForEvent() {
        return {
          id: "evt",
          name: "agent.approve.reject",
          version: 1,
          data: { runId: "r", approved: false, reason: "rejected by reviewer" },
          timestamp: new Date(),
        };
      },
    } as unknown as StepClient;

    const approve = makeApprove(step, "r");
    const result = await approve("reject", { ttl: "1m" });

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("rejected by reviewer");
  });
});
