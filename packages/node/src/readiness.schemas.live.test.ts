/**
 * Live test: the event-schemas group (#3003) through the Node client, on an
 * event of its own so the shared seed schema (versions 1 and 2, read by
 * schema-test-upcast) stays as the seed left it.
 * Skips unless IRONFLOW_READINESS_SEED is set; `make test-readiness-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SEED_PATH = process.env["IRONFLOW_READINESS_SEED"];

describe.skipIf(!SEED_PATH)("readiness schemas — live server", () => {
  const client = new IronflowClient({
    serverUrl: process.env["IRONFLOW_TEST_SERVER"]!,
    apiKey: process.env["IRONFLOW_TEST_API_KEY"],
  });
  const { schemas } = client;
  const name = `readiness.schemas.node.${process.hrtime.bigint()}`;
  const doc = (field: string) => ({ type: "object", properties: { [field]: { type: "string" } }, required: [field] });

  it("schema-register", async () => {
    // Everything but `status` is the client's echo of the input; `status` is the server's answer.
    const register = async (version: number, field: string) =>
      (await schemas.register({ name, version, schema: doc(field) })) as unknown as { status: string };
    expect(await register(1, "orderId")).toMatchObject({ status: "created", event_name: name, version: 1, schema: doc("orderId") });
    expect(await register(2, "orderRef")).toMatchObject({ status: "created", event_name: name, version: 2, schema: doc("orderRef") });
    // The same name and version again replaces the document.
    expect(await register(1, "orderId")).toMatchObject({ status: "updated" });
    // A document that does not compile is refused at registration.
    await expect(schemas.register({ name, version: 3, schema: { type: "no-such-type" } })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("schema-read", async () => {
    expect(await schemas.get(name)).toMatchObject({
      event_name: name,
      version: 2,
      schema: doc("orderRef"),
      created_at: expect.stringMatching(/^\d{4}-/),
    });
    expect(await schemas.getVersion(name, 1)).toMatchObject({ version: 1, schema: doc("orderId") });
    const listed = (await schemas.list()).filter((s) => s.event_name === name);
    expect(listed.map((s) => s.version).sort()).toEqual([1, 2]);
  });

  it("schema-delete", async () => {
    await schemas.delete(name, 2);
    expect((await schemas.get(name)).version).toBe(1);
    await expect(schemas.getVersion(name, 2)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(schemas.delete(name, 2)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect((await schemas.list()).filter((s) => s.event_name === name).map((s) => s.version)).toEqual([1]);
    await schemas.delete(name, 1);
    await expect(schemas.get(name)).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});
