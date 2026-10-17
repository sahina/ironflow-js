/**
 * Live test: the identity and tenancy rows against a real engine (#2945).
 * Skips unless IRONFLOW_TEST_PLATFORM_TOKEN is set; `make test-identity-live` sets it.
 */
import { UnauthenticatedError, UnauthorizedError } from "@ironflow/core";
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"]!;
const PLATFORM_TOKEN = process.env["IRONFLOW_TEST_PLATFORM_TOKEN"];

async function login(email: string, password: string): Promise<{ status: number; token?: string }> {
  const res = await fetch(`${SERVER}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { token?: string };
  return { status: res.status, token: body.token };
}

describe.skipIf(!PLATFORM_TOKEN)("identity — live server", () => {
  const operator = new IronflowClient({ serverUrl: SERVER, apiKey: process.env["IRONFLOW_TEST_API_KEY"] });
  const suffix = `${Date.now()}`;
  const orgName = `Node Zürich ${suffix}`;
  let tenant: Awaited<ReturnType<typeof operator.tenants.provision>>;
  const self = () => new IronflowClient({ serverUrl: SERVER, apiKey: tenant.apiKey.key });

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

  it("user-crud", async () => {
    const users = self().users;
    const email = `node-user-${suffix}@example.com`;
    const u = await users.create({ email, name: "Zoë Node", password: "first-pass-123", roles: ["viewer"] });
    expect(u).toMatchObject({ orgId: tenant.org.id, email, name: "Zoë Node", roles: ["viewer"] });
    expect(u.createdAt).toBeTruthy();
    expect((await users.list()).map((x) => x.id)).toContain(u.id);
    const updated = await users.update(u.id, { name: "Zoë Renamed", roles: ["developer"] });
    expect(updated).toMatchObject({ id: u.id, name: "Zoë Renamed", roles: ["developer"] });
    expect(await users.get(u.id)).toMatchObject({ name: "Zoë Renamed", roles: ["developer"], orgId: tenant.org.id });
    await users.delete(u.id);
    await expect(users.get(u.id)).rejects.toMatchObject({ status: 404 });
  });

  // Each login hashes a password; four of them outlast the 5s default.
  it("user-password: a developer changes their own password", { timeout: 30_000 }, async () => {
    const email = `node-pw-${suffix}@example.com`;
    const u = await self().users.create({ email, password: "old-pass-123", roles: ["developer"] });
    const session = await login(email, "old-pass-123");
    expect(session.status).toBe(200);
    // A session defaults to env_default, which belongs to org_default, so name the user's environment.
    const me = new IronflowClient({ serverUrl: SERVER, apiKey: session.token!, environment: tenant.environment.id });
    await expect(me.users.changePassword(u.id, { currentPassword: "wrong", newPassword: "x-pass-789" }))
      .rejects.toBeInstanceOf(UnauthenticatedError);
    await me.users.changePassword(u.id, { currentPassword: "old-pass-123", newPassword: "new-pass-456" });
    expect((await login(email, "old-pass-123")).status).toBe(401);
    expect((await login(email, "new-pass-456")).status).toBe(200);
  });

  it("org-crud: create with a platform credential, the rest on the tenant's own org", async () => {
    const platform = new IronflowClient({ serverUrl: SERVER, apiKey: PLATFORM_TOKEN! });
    const created = await platform.orgs.create({ name: `Node Plattform Ünïcode ${suffix}` });
    expect(created.id).toMatch(/^org_/);
    expect(created.name).toBe(`Node Plattform Ünïcode ${suffix}`);
    await expect(self().orgs.create({ name: "Escalate" })).rejects.toBeInstanceOf(UnauthorizedError);

    const id = tenant.org.id;
    expect((await self().orgs.list()).map((o) => o.id)).toEqual([id]);
    const renamed = `Node Zürich renamed ${suffix}`;
    expect(await self().orgs.update(id, { name: renamed })).toMatchObject({ id, name: renamed });
    expect((await self().orgs.get(id)).name).toBe(renamed);
    await self().orgs.delete(id);
    // Deleting the org deletes its keys.
    await expect(self().orgs.get(id)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
