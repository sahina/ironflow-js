/**
 * Live test: role-crud and policy-set (#3003) through the browser client, on a
 * tenant of its own. The sets deny one action in monitor mode, so they change
 * nothing the other tests do. Skips unless IRONFLOW_TEST_PLATFORM_TOKEN is
 * set; `make test-identity-live` sets it.
 */
import { POLICY_SET_ERROR_CODES, PreconditionFailedError } from "@ironflow/core";
import { beforeAll, describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"]!;
const DENY_DELETE = 'package ironflow.authz\n\ndeny contains "no deletes" if input.request.action == "runs:delete"\n';
const DENY_CANCEL = 'package ironflow.authz\n\ndeny contains "no cancels" if input.request.action == "runs:cancel"\n';

function client(credential: string, environment?: string): IronflowClient {
  const c = new IronflowClient();
  c.configure({ serverUrl: SERVER, auth: { apiKey: credential }, environment });
  return c;
}

describe.skipIf(!process.env["IRONFLOW_TEST_PLATFORM_TOKEN"])("roles and policy set — live server", () => {
  const suffix = `${Date.now()}`;
  let tenant: Awaited<ReturnType<IronflowClient["tenants"]["provision"]>>;
  let admin: IronflowClient;

  beforeAll(async () => {
    tenant = await client(process.env["IRONFLOW_TEST_API_KEY"]!).tenants.provision({ orgName: `Browser roles ${suffix}` });
    // The browser sends its configured environment, default "default"; a tenant key works in its own.
    admin = client(tenant.apiKey.key, tenant.environment.id);
  });

  it("role-crud", async () => {
    const name = `deployer-${suffix}`;
    const created = await admin.roles.create({ name, org_id: tenant.org.id });
    expect(created).toMatchObject({ name, org_id: tenant.org.id, is_default: false });
    expect(created.id).toBeTruthy();
    expect(created.created_at).toBeTruthy();
    await expect(admin.roles.create({ name, org_id: tenant.org.id })).rejects.toMatchObject({ status: 409 });
    await expect(admin.roles.create({ name: "admin", org_id: tenant.org.id })).rejects.toMatchObject({ status: 400 });

    expect(await admin.roles.get(created.id)).toMatchObject({ id: created.id, name, org_id: tenant.org.id });
    const list = await admin.roles.list();
    expect(list.map((r) => r.name).sort()).toEqual(["admin", "developer", name, "viewer"].sort());

    const renamed = `releaser-${suffix}`;
    expect(await admin.roles.update(created.id, { name: renamed })).toMatchObject({ id: created.id, name: renamed });
    expect((await admin.roles.get(created.id)).name).toBe(renamed);
    // Built-in roles are fixed.
    const builtin = list.find((r) => r.name === "admin")!.id;
    await expect(admin.roles.update(builtin, { name: "root" })).rejects.toMatchObject({ status: 400 });
    await expect(admin.roles.delete(builtin)).rejects.toMatchObject({ status: 400 });

    await admin.roles.delete(created.id);
    await expect(admin.roles.get(created.id)).rejects.toMatchObject({ status: 404 });
    await expect(admin.roles.delete(created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("policy-set", async () => {
    const v1 = { modules: { "authz.rego": DENY_DELETE }, mode: "monitor" as const };
    const v2 = { modules: { "authz.rego": DENY_DELETE, "more.rego": DENY_CANCEL }, mode: "monitor" as const };
    const deleteInput = { request: { action: "runs:delete" }, subject: {} };
    const cancelInput = { request: { action: "runs:cancel" }, subject: {} };

    const empty = await admin.policySet.get();
    expect(empty).toMatchObject({ version: 0, modules: {} });
    expect(typeof empty.enforcement_active).toBe("boolean");

    // validate and dry-run store nothing.
    await admin.policySet.validate(v1);
    await expect(
      admin.policySet.validate({ modules: { "bad.rego": "package ironflow.authz\n\ndeny contains {\n" } }),
    ).rejects.toMatchObject({ code: POLICY_SET_ERROR_CODES.compileError, status: 400 });
    const deny = await admin.policySet.dryRun({ set: v1, input: deleteInput });
    expect(deny.decision).toBe("deny");
    expect(deny.reasons).toContain("no deletes");
    expect((await admin.policySet.dryRun({ set: v1, input: cancelInput })).decision).toBe("allow");
    expect((await admin.policySet.get()).version).toBe(0);

    expect(await admin.policySet.put(v1, 0)).toMatchObject({ version: 1, mode: "monitor", modules: v1.modules });
    await expect(admin.policySet.put(v2, 0)).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(await admin.policySet.put(v2, 1)).toMatchObject({ version: 2, modules: v2.modules });
    expect(await admin.policySet.get()).toMatchObject({ version: 2, modules: v2.modules });

    const versions = await admin.policySet.versions();
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    for (const v of versions) expect(v).toMatchObject({ mode: "monitor", created_at: expect.any(String) });
    expect(await admin.policySet.version(1)).toMatchObject({ version: 1, modules: v1.modules });
    await expect(admin.policySet.version(99)).rejects.toMatchObject({ status: 404 });

    // Rollback stores version 1's files as version 3 and keeps the mode.
    expect(await admin.policySet.rollback(1, 2)).toMatchObject({ version: 3, mode: "monitor", modules: v1.modules });
    await expect(admin.policySet.rollback(1, 2)).rejects.toBeInstanceOf(PreconditionFailedError);
    // Without a candidate set, dry-run evaluates the active one.
    expect(await admin.policySet.dryRun({ input: cancelInput })).toMatchObject({ decision: "allow", version: 3 });
  });

  // The two write answers the SDK cannot reach: a PUT without If-Match is 428,
  // and a PUT equal to the active set is 200 with the same version and no new
  // version. Each org may write 5 times in a burst (a write earns back one
  // token every 6 seconds, and the budget is checked before If-Match), and the
  // test above spends its own, so this runs on a second tenant.
  it("policy-set: no If-Match is 428, an unchanged PUT adds no version", async () => {
    const second = await client(process.env["IRONFLOW_TEST_API_KEY"]!).tenants.provision({ orgName: `Browser policy writes ${suffix}` });
    const own = client(second.apiKey.key, second.environment.id);
    const set = { modules: { "authz.rego": DENY_DELETE }, mode: "monitor" as const };

    expect((await own.policySet.put(set, 0)).version).toBe(1);
    expect((await own.policySet.put(set, 1)).version).toBe(1);
    expect(await own.policySet.versions()).toHaveLength(1);

    const res = await fetch(`${SERVER}/api/v1/policy-set`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${second.apiKey.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(set),
    });
    expect(res.status).toBe(428);
    expect(await res.json()).toMatchObject({ code: POLICY_SET_ERROR_CODES.preconditionRequired });
  });
});
