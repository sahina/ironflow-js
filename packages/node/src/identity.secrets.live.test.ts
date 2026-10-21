/**
 * Live test: secret-crud (#3003) through the Node client, on a tenant of its
 * own, so the key is bound to an environment other than env_default. The REST
 * docs say a secret's value is write-only, so no response carries it.
 * Skips unless IRONFLOW_TEST_PLATFORM_TOKEN is set; `make test-identity-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"]!;

describe.skipIf(!process.env["IRONFLOW_TEST_PLATFORM_TOKEN"])("secrets — live server", () => {
  const suffix = `${Date.now()}`;

  it("secret-crud", async () => {
    const operator = new IronflowClient({ serverUrl: SERVER, apiKey: process.env["IRONFLOW_TEST_API_KEY"] });
    const tenant = await operator.tenants.provision({ orgName: `Node secrets ${suffix}` });
    const client = new IronflowClient({ serverUrl: SERVER, apiKey: tenant.apiKey.key });

    // The typed Secret has no description or revision, so read them off the wire.
    const meta = async (name: string) => {
      const res = await fetch(`${SERVER}/api/v1/secrets/${name}`, {
        headers: { Authorization: `Bearer ${tenant.apiKey.key}`, "X-Ironflow-Environment": "current" },
      });
      return { status: res.status, body: (await res.json()) as { revision?: number; description?: string } };
    };

    const name = `NODE_KEY_${suffix}`;
    const created = await client.secrets.set(name, "v1-sensitive");
    expect(created).toMatchObject({ name, created_at: expect.any(String), updated_at: expect.any(String) });
    expect(created.value).toBeUndefined();
    const got = await client.secrets.get(name);
    expect(got.name).toBe(name);
    expect(got.value).toBeUndefined();
    const first = await meta(name);
    expect(first.status).toBe(200);
    expect(first.body.revision).toBeGreaterThan(0);

    const updated = await client.secrets.update(name, "v2-sensitive");
    expect(updated.name).toBe(name);
    expect(updated.value).toBeUndefined();
    expect((await meta(name)).body.revision).toBeGreaterThan(first.body.revision!);

    await client.secrets.patch(name, { description: "billing key" });
    expect((await meta(name)).body.description).toBe("billing key");
    const renamed = `NODE_RENAMED_${suffix}`;
    expect((await client.secrets.patch(name, { name: renamed })).name).toBe(renamed);
    await expect(client.secrets.get(name)).rejects.toMatchObject({ status: 404 });
    expect((await meta(renamed)).body.description).toBe("billing key");
    await expect(client.secrets.patch(renamed, {})).rejects.toThrow("Secret patch requires name or description");

    expect((await client.secrets.list()).map((s) => s.name)).toEqual([renamed]);

    await client.secrets.delete(renamed);
    await expect(client.secrets.get(renamed)).rejects.toMatchObject({ status: 404 });
    expect(await client.secrets.list()).toEqual([]);
  });
});
