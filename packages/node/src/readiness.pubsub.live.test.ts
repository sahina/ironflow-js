/**
 * Live test: the pubsub group (#3003) through the Node client. Skips unless
 * IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import type { SubscriptionEvent } from "@ironflow/core";
import { IronflowClient } from "./client.js";
import { createSubscriptionClient } from "./subscribe.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

const waitFor = async (pred: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!SEED_PATH)("readiness pubsub — live server", () => {
  const serverUrl = process.env["IRONFLOW_TEST_SERVER"]!;
  const apiKey = process.env["IRONFLOW_TEST_API_KEY"];
  const client = new IronflowClient({ serverUrl, apiKey });

  it("pubsub-subscribe", async () => {
    const topic = `nodesdk.sub.${process.hrtime.bigint()}`;
    const published = [];
    for (const n of [0, 1]) published.push(await client.publish(topic, { n }));

    const subClient = createSubscriptionClient({ serverUrl, apiKey });
    await subClient.connect();
    const seen: SubscriptionEvent<{ n: number }>[] = [];
    try {
      // The pattern needs the topic: namespace; publish takes the bare topic.
      const sub = await subClient.subscribe<{ n: number }>(`topic:${topic}`, {
        replay: 2,
        includeMetadata: true,
        onEvent: (event) => void seen.push(event),
      });
      await waitFor(() => seen.length === 2, 10000, "the replay");
      // One publish, no retry: the replay frames are in, so its snapshot is taken,
      // and a live consumer anchored there must deliver this event (#3065). A
      // retry loop would hide the replay-to-live gap coming back.
      published.push(await client.publish(topic, { n: 2 }));
      await waitFor(() => seen.length === 3, 5000, "the live event");
      sub.unsubscribe();
    } finally {
      subClient.close();
    }

    expect(seen.slice(0, 3).map((e) => e.data)).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
    // Replay and live: the IDs Publish returned.
    expect(seen.slice(0, 3).map((e) => e.eventId)).toEqual(published.map((p) => p.eventId));
    for (const e of seen.slice(0, 3)) {
      expect(e.topic).toBe(`topic:${topic}`);
      // The delivery time, which is not the publish time: near now.
      expect(Math.abs(Date.now() - Date.parse(e.meta!.timestamp))).toBeLessThan(60000);
    }
    expect(seen.slice(0, 3).map((e) => e.meta?.sequence)).toEqual(published.map((p) => p.sequence));
  });

  it("pubsub-topics and pubsub-topic-stats", async () => {
    const topic = `nodesdk.topics.${process.hrtime.bigint()}`;
    let last = 0;
    for (const n of [0, 1, 2]) last = (await client.publish(topic, { n })).sequence;

    // A subscription that resumes from a cursor owns a JetStream consumer on the
    // topic's subject; the three events it reads show that the consumer exists.
    const subClient = createSubscriptionClient({ serverUrl, apiKey });
    await subClient.connect();
    let read = 0;
    try {
      await subClient.subscribe(`topic:${topic}`, { startAfterSequence: 0, onEvent: () => void read++ });
      await waitFor(() => read === 3, 10000, "the consumer's events");

      // Our consumer is one; the count is a floor because other suites may leave
      // consumers on the shared stream whose filter matches this topic.
      const found = (await client.listTopics()).find((t) => t.name === topic);
      expect(found).toMatchObject({ name: topic, messageCount: 3 });
      expect(found!.consumerCount).toBeGreaterThanOrEqual(1);

      const stats = await client.getTopicStats(topic);
      expect(stats).toMatchObject({ name: topic, messageCount: 3 });
      expect(stats.consumerCount).toBeGreaterThanOrEqual(1);
      expect(stats.lag).toBeGreaterThanOrEqual(0);
      // Sequences are stream-wide, so other topics move them: the last one is a floor.
      expect(stats.lastSeq).toBeGreaterThanOrEqual(last);
      expect(stats.firstSeq).toBeGreaterThan(0);
      expect(stats.firstSeq).toBeLessThanOrEqual(stats.lastSeq);
    } finally {
      subClient.close();
    }

    expect(await client.getTopicStats(`${topic}.never`)).toMatchObject({ name: `${topic}.never`, messageCount: 0 });
  });
});
