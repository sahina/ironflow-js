/**
 * Live test: nak redelivers over the WebSocket ack frame (#2422) and over the
 * SubscribeBidirectional stream (#2973).
 * Skips unless IRONFLOW_TEST_SERVER is set; `make test-sdk-manual-ack-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";
import { createSubscriptionClient } from "./subscribe.js";
import { joinConsumerGroupStream } from "./consumer-group-stream.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"];
const API_KEY = process.env["IRONFLOW_TEST_API_KEY"];

const waitFor = async (pred: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!SERVER)("manual ack — live server", () => {
  it("nak redelivers the same event", async () => {
    const suffix = `${Date.now()}`;
    const topic = `nodesdk.ack.${suffix}`;
    const group = `ack-group-${suffix}`;
    const client = new IronflowClient({ serverUrl: SERVER!, apiKey: API_KEY });

    // In a MANUAL group redeliverDelayMs is also the JetStream ack-wait. 60s
    // keeps an unacked event out of the window below: only the nak can redeliver.
    await client.consumerGroups.create({
      name: group,
      pattern: `topic:${topic}`,
      ackMode: "manual",
      redeliverDelayMs: 60000,
      maxRedeliveries: 5,
    });

    const subClient = createSubscriptionClient({ serverUrl: SERVER!, apiKey: API_KEY });
    await subClient.connect();
    const seen: string[] = [];
    const sub = await subClient.joinConsumerGroup(group, `topic:${topic}`, {
      onEvent: (event) => {
        seen.push(event.eventId!);
      },
    });

    // The group consumer may not exist when the first publish lands.
    const timer = setInterval(() => {
      void client.publish(topic, { n: 1 }).catch(() => {});
    }, 300);
    try {
      await waitFor(() => seen.length > 0, 15000, "the first event");
    } finally {
      clearInterval(timer);
    }

    const target = seen[0]!;
    const nakedAt = Date.now();
    await sub.nak(target, 1000);
    await waitFor(
      () => seen.filter((id) => id === target).length >= 2,
      15000,
      "the redelivery",
    );
    expect(Date.now() - nakedAt).toBeGreaterThanOrEqual(800);

    await sub.ack(target);
    sub.unsubscribe();
    subClient.close();
  }, 40000);

  it("nak redelivers over the bidirectional stream", async () => {
    const suffix = `${Date.now()}`;
    const topic = `nodesdk.bidi.${suffix}`;
    const group = `bidi-group-${suffix}`;
    const client = new IronflowClient({ serverUrl: SERVER!, apiKey: API_KEY });

    await client.consumerGroups.create({
      name: group,
      pattern: `topic:${topic}`,
      ackMode: "manual",
      redeliverDelayMs: 60000,
      maxRedeliveries: 5,
    });

    const seen: string[] = [];
    const sub = await joinConsumerGroupStream(
      { serverUrl: SERVER!, apiKey: API_KEY },
      group,
      { onEvent: (event) => void seen.push(event.eventId!) },
    );

    try {
      const timer = setInterval(() => {
        void client.publish(topic, { n: 1 }).catch(() => {});
      }, 300);
      try {
        await waitFor(() => seen.length > 0, 15000, "the first event");
      } finally {
        clearInterval(timer);
      }

      const target = seen[0]!;
      const nakedAt = Date.now();
      await sub.nak(target, 1000); // resolves from the server's AckResult
      await waitFor(
        () => seen.filter((id) => id === target).length >= 2,
        15000,
        "the redelivery",
      );
      expect(Date.now() - nakedAt).toBeGreaterThanOrEqual(800);

      await sub.ack(target);
    } finally {
      sub.unsubscribe(); // a failed assertion must not leave the member in the group
    }
  }, 40000);
});
