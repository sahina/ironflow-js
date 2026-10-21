/**
 * Live test: apikey-crud and apikey-rotate (#3003) through the Node client, on
 * a tenant of its own. Skips unless IRONFLOW_TEST_PLATFORM_TOKEN is set;
 * `make test-identity-live` sets it.
 */
import { UnauthenticatedError, UnauthorizedError } from "@ironflow/core";
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"]!;

describe.skipIf(!process.env["IRONFLOW_TEST_PLATFORM_TOKEN"])("api keys — live server", () => {
  const suffix = `${Date.now()}`;
  const as = (apiKey: string) => new IronflowClient({ serverUrl: SERVER, apiKey });
  const name = `node-ci-${suffix}`;
  let tenant: Awaited<ReturnType<IronflowClient["tenants"]["provision"]>>;
  let admin: IronflowClient;
  let viewer: string;
  let created: Awaited<ReturnType<IronflowClient["apiKeys"]["create"]>>;
  let rotated: Awaited<ReturnType<IronflowClient["apiKeys"]["rotate"]>>;

  it("apikey-crud: create, get, list", async () => {
    tenant = await as(process.env["IRONFLOW_TEST_API_KEY"]!).tenants.provision({ orgName: `Node apikeys ${suffix}` });
    admin = as(tenant.apiKey.key);
    viewer = (await admin.roles.list()).find((r) => r.name === "viewer")!.id;

    created = await admin.apiKeys.create({ name, role_ids: [viewer], expires_in: "720h" });
    expect(created.key).toMatch(/^ifkey_/);
    expect(created.key.startsWith(created.key_prefix)).toBe(true);
    expect(created).toMatchObject({ name, role_ids: [viewer] });
    expect(created.id).toBeTruthy();
    const days = (Date.parse(created.expires_at!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);

    expect(await admin.apiKeys.get(created.id)).toMatchObject({ id: created.id, name, key_prefix: created.key_prefix, role_ids: [viewer] });
    expect((await admin.apiKeys.list()).map((k) => k.id)).toContain(created.id);
    // The viewer role is what the key holds: it reads, but cannot create keys.
    expect((await as(created.key).orgs.get(tenant.org.id)).id).toBe(tenant.org.id);
    await expect(as(created.key).apiKeys.create({ name: `denied-${suffix}` })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(admin.apiKeys.get("ak_does_not_exist")).rejects.toMatchObject({ status: 404 });
    await expect(admin.apiKeys.create({ name: "" })).rejects.toMatchObject({ status: 400 });
  });

  it("apikey-rotate: a new id and secret, the same name, roles and expiry", async () => {
    rotated = await admin.apiKeys.rotate(created.id);
    expect(rotated.id).not.toBe(created.id);
    expect(rotated.key).not.toBe(created.key);
    expect(rotated.key).toMatch(/^ifkey_/);
    expect(rotated.key.startsWith(rotated.key_prefix)).toBe(true);
    expect(rotated).toMatchObject({ name, role_ids: [viewer] });
    // Compare the instants, not the strings: the two backends format the stored stamp differently.
    expect(Math.abs(Date.parse(rotated.expires_at!) - Date.parse(created.expires_at!))).toBeLessThan(1000);

    await expect(admin.apiKeys.get(created.id)).rejects.toMatchObject({ status: 404 });
    await expect(as(created.key).orgs.get(tenant.org.id)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect((await as(rotated.key).orgs.get(tenant.org.id)).id).toBe(tenant.org.id);
    await expect(admin.apiKeys.rotate("ak_does_not_exist")).rejects.toMatchObject({ status: 404 });
  });

  it("apikey-crud: delete stops both the id and the secret", async () => {
    await admin.apiKeys.delete(rotated.id);
    await expect(admin.apiKeys.get(rotated.id)).rejects.toMatchObject({ status: 404 });
    await expect(as(rotated.key).orgs.get(tenant.org.id)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  // A key bound to a second environment with tool scopes: both show on read
  // and list, rotation keeps them, and the binding holds on the wire.
  it("apikey-crud and apikey-rotate keep the environment and tool scopes", async () => {
    const [project] = await admin.projects.list();
    const staging = await admin.environments.create({ name: "staging", project_id: project!.id });
    const scopes = ["billing-tools", "reporting-tools"];
    const scoped = await admin.apiKeys.create({ name: `scoped-${suffix}`, env_id: staging.id, tool_scopes: scopes });
    expect(scoped).toMatchObject({ environment_id: staging.id, tool_scopes: scopes });
    const bound = { environment_id: staging.id, tool_scopes: scopes };
    expect(await admin.apiKeys.get(scoped.id)).toMatchObject(bound);
    expect((await admin.apiKeys.list()).find((k) => k.id === scoped.id)).toMatchObject(bound);

    const inEnv = (key: string, environment: string) =>
      new IronflowClient({ serverUrl: SERVER, apiKey: key, environment }).orgs.get(tenant.org.id);
    expect((await inEnv(scoped.key, staging.id)).id).toBe(tenant.org.id);
    await expect(inEnv(scoped.key, tenant.environment.id)).rejects.toBeInstanceOf(UnauthorizedError);

    const again = await admin.apiKeys.rotate(scoped.id);
    expect(again.id).not.toBe(scoped.id);
    expect(again).toMatchObject(bound);
    expect(await admin.apiKeys.get(again.id)).toMatchObject(bound);
    expect((await inEnv(again.key, staging.id)).id).toBe(tenant.org.id);
    await expect(inEnv(again.key, tenant.environment.id)).rejects.toBeInstanceOf(UnauthorizedError);
    await admin.apiKeys.delete(again.id);
  });
});
