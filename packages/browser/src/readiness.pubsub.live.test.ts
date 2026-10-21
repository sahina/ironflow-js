// @vitest-environment node
/**
 * Live test: the pubsub group (#3003) through the browser client, which has
 * subscribe only: topic listing and stats are an operator boundary. It runs
 * both transports. Skips unless IRONFLOW_READINESS_SEED is set;
 * `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import type { SubscriptionEvent } from "@ironflow/core";
import { ironflow } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

const waitFor = async (pred: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!SEED_PATH)("readiness pubsub — live server", () => {
  for (const transport of ["connectrpc", "websocket"] as const) {
    it(`pubsub-subscribe over ${transport}`, async () => {
      ironflow.configure({
        serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
        auth: { apiKey: process.env["IRONFLOW_TEST_API_KEY"] },
        transport,
      });
      const topic = `browsersdk.sub.${transport}.${Date.now()}`;
      const published = [];
      for (const n of [0, 1]) published.push(await ironflow.publish(topic, { n }));

      const seen: SubscriptionEvent<{ n: number }>[] = [];
      // The pattern needs the topic: namespace; publish takes the bare topic.
      const sub = await ironflow.subscribe<{ n: number }>(`topic:${topic}`, {
        replay: 2,
        includeMetadata: true,
        onEvent: (event) => void seen.push(event),
      });
      try {
        await waitFor(() => seen.length === 2, 10000, "the replay");
        // One publish, no retry: the replay frames are in, so its snapshot is taken,
        // and a live consumer anchored there must deliver this event (#3065). A
        // retry loop would hide the replay-to-live gap coming back.
        published.push(await ironflow.publish(topic, { n: 2 }));
        await waitFor(() => seen.length === 3, 5000, "the live event");
      } finally {
        sub.unsubscribe();
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
    }, 30000);
  }
});
