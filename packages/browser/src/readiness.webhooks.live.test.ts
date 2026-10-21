// @vitest-environment node
/**
 * Live test: the webhooks group (#3003) through the browser client. The secret
 * operations and deliveries are in readiness.live.test.ts. Skips unless
 * IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { ironflow } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

describe.skipIf(!SEED_PATH)("readiness webhooks — live server", () => {
  const client = ironflow;
  client.configure({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    auth: { apiKey: process.env["IRONFLOW_TEST_API_KEY"] },
  });

  it("webhook-source-crud", async () => {
    const name = `browsersdk-crud-${Date.now()}`;
    const created = await client.webhooks.create({
      name,
      eventPrefix: "browsersdk.crud",
      verifyHeader: "x-sig",
      verifyAlgorithm: "hmac-sha256",
      verifySecret: "s1",
      metadata: { team: "payments", tier: "gold" },
    });
    try {
      expect(created).toMatchObject({
        name,
        eventPrefix: "browsersdk.crud",
        verifyHeader: "x-sig",
        verifyAlgorithm: "hmac-sha256",
        verifySecretSet: true,
        metadata: { team: "payments", tier: "gold" },
      });
      expect(created.id).toMatch(/^wh_/);
      expect(created.ingestToken).toBeTruthy();

      // The token comes back once, on create; every read after that has its prefix only.
      const got = await client.webhooks.getSource(created.id);
      expect(got).toMatchObject({ id: created.id, name, eventPrefix: "browsersdk.crud", verifyHeader: "x-sig", verifySecretSet: true });
      expect(got.ingestToken).toBeFalsy();
      expect(got.ingestTokenPrefix).toBeTruthy();
      expect(created.ingestToken!.startsWith(got.ingestTokenPrefix!)).toBe(true);

      const listed = (await client.webhooks.listSources()).find((s) => s.id === created.id);
      expect(listed?.name).toBe(name);

      // Name and metadata are full-replace (the "tier" key must go); the header,
      // algorithm and secret are preserve-on-omit, and the event prefix cannot change.
      const updated = await client.webhooks.updateSource({ id: created.id, name: `${name}-renamed`, metadata: { team: "billing" } });
      expect(updated).toMatchObject({
        name: `${name}-renamed`,
        eventPrefix: "browsersdk.crud",
        verifyHeader: "x-sig",
        verifyAlgorithm: "hmac-sha256",
        verifySecretSet: true,
      });
      expect(updated.metadata).toEqual({ team: "billing" });
      expect(updated.updatedAt).not.toBe(got.updatedAt);
      expect((await client.webhooks.getSource(created.id)).name).toBe(`${name}-renamed`);
    } finally {
      await client.webhooks.deleteSource(created.id);
    }
    await expect(client.webhooks.getSource(created.id)).rejects.toMatchObject({ status: 404 });
    expect((await client.webhooks.listSources()).map((s) => s.id)).not.toContain(created.id);
  });
});
