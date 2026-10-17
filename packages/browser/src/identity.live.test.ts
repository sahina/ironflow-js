/**
 * Live test: the identity and tenancy rows the browser SDK serves, against a
 * real engine (#2945). Users are server-only, so this covers orgs and tenants.
 * Skips unless IRONFLOW_TEST_PLATFORM_TOKEN is set; `make test-identity-live` sets it.
 */
import { UnauthenticatedError, UnauthorizedError } from "@ironflow/core";
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"]!;
const PLATFORM_TOKEN = process.env["IRONFLOW_TEST_PLATFORM_TOKEN"];

function client(credential: string, environment?: string): IronflowClient {
  const c = new IronflowClient();
  c.configure({ serverUrl: SERVER, auth: { apiKey: credential }, environment });
  return c;
}

describe.skipIf(!PLATFORM_TOKEN)("identity — live server", () => {
  const operator = client(process.env["IRONFLOW_TEST_API_KEY"]!);
  const suffix = `${Date.now()}`;
  const orgName = `Browser Zürich ${suffix}`;
  let tenant: Awaited<ReturnType<typeof operator.tenants.provision>>;
  // The browser sends its configured environment, default "default"; a tenant key works in its own.
  const self = () => client(tenant.apiKey.key, tenant.environment.id);

  it("tenant-provision: the bootstrap org's admin provisions; a tenant admin cannot", async () => {
    tenant = await operator.tenants.provision({ orgName });
    expect(tenant.org.name).toBe(orgName);
    expect(tenant.environment.name).toBe("production");
    expect(tenant.apiKey.key).toMatch(/^ifkey_/);
    expect(tenant.apiKey.roles).toEqual(["admin"]);
    expect((await self().orgs.get(tenant.org.id)).name).toBe(orgName);
    await expect(self().tenants.provision({ orgName: `Escalate ${suffix}` })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(self().tenants.list()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("tenant-list", async () => {
    const row = (await operator.tenants.list()).find((t) => t.id === tenant.org.id);
    expect(row).toMatchObject({ name: orgName, envCount: 1, keyCount: 1 });
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("org-crud: create with a platform credential, the rest on the tenant's own org", async () => {
    const created = await client(PLATFORM_TOKEN!).orgs.create({ name: `Browser Plattform Ünïcode ${suffix}` });
    expect(created.id).toMatch(/^org_/);
    expect(created.name).toBe(`Browser Plattform Ünïcode ${suffix}`);
    await expect(self().orgs.create({ name: "Escalate" })).rejects.toBeInstanceOf(UnauthorizedError);

    const id = tenant.org.id;
    expect((await self().orgs.list()).map((o) => o.id)).toEqual([id]);
    const renamed = `Browser Zürich renamed ${suffix}`;
    expect(await self().orgs.update(id, { name: renamed })).toMatchObject({ id, name: renamed });
    expect((await self().orgs.get(id)).name).toBe(renamed);
    await self().orgs.delete(id);
    // Deleting the org deletes its keys.
    await expect(self().orgs.get(id)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
