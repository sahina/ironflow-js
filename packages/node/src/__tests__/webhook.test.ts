import { describe, it, expect } from "vitest";
import { createWebhook } from "../webhook.js";

describe("createWebhook", () => {
  it("creates a webhook with config", () => {
    const wh = createWebhook({
      id: "test-provider",
      verify: (req) => {
        if (!req.headers["x-signature"]) throw new Error("missing sig");
        return true;
      },
      transform: (payload: any) => ({
        name: `test.${payload.type}`,
        data: payload.data,
        idempotencyKey: payload.id,
      }),
    });

    expect(wh.config.id).toBe("test-provider");
  });

  it("verify function validates signature", () => {
    const wh = createWebhook({
      id: "test",
      verify: (req) => {
        if (!req.headers["x-sig"]) throw new Error("missing");
        return true;
      },
      transform: (p: any) => ({ name: p.type, data: p }),
    });

    expect(() => wh.config.verify({ body: "{}", headers: {} })).toThrow("missing");

    const result = wh.config.verify({ body: "{}", headers: { "x-sig": "valid" } });
    expect(result).toBe(true);
  });

  it("transform function converts payload", async () => {
    const wh = createWebhook({
      id: "stripe",
      verify: () => true,
      transform: (payload: any) => ({
        name: `stripe.${payload.type}`,
        data: payload.data,
        idempotencyKey: payload.id,
      }),
    });

    const event = await wh.config.transform({
      type: "payment_intent.succeeded",
      id: "evt_123",
      data: { amount: 1000 },
    });

    expect(event.name).toBe("stripe.payment_intent.succeeded");
    expect(event.idempotencyKey).toBe("evt_123");
    expect(event.data).toEqual({ amount: 1000 });
  });
});
