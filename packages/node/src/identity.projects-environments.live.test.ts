/**
 * Live test: project-crud and env-crud (#3003) through the Node client, on a
 * tenant of its own. The browser SDK has neither (ADR 0092). Skips unless
 * IRONFLOW_TEST_PLATFORM_TOKEN is set; `make test-identity-live` sets it.
 */
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"]!;

describe.skipIf(!process.env["IRONFLOW_TEST_PLATFORM_TOKEN"])("projects and environments — live server", () => {
  const suffix = `${Date.now()}`;
  const name = `svc-${suffix}`;
  let tenant: Awaited<ReturnType<IronflowClient["tenants"]["provision"]>>;
  let client: IronflowClient;
  let project: Awaited<ReturnType<IronflowClient["projects"]["create"]>>;

  it("project-crud: create, list, update", async () => {
    const operator = new IronflowClient({ serverUrl: SERVER, apiKey: process.env["IRONFLOW_TEST_API_KEY"] });
    tenant = await operator.tenants.provision({ orgName: `Node projects ${suffix}` });
    client = new IronflowClient({ serverUrl: SERVER, apiKey: tenant.apiKey.key });

    project = await client.projects.create({ name, description: "created" });
    expect(project).toMatchObject({ name, description: "created", org_id: tenant.org.id });
    expect(project.id).toBeTruthy();
    expect(project.created_at).toBeTruthy();
    expect((await client.projects.list()).map((p) => p.name).sort()).toEqual(["default", name].sort());
    expect((await client.projects.list()).find((p) => p.id === project.id)?.description).toBe("created");

    const renamed = `renamed-${suffix}`;
    const updated = await client.projects.update(project.id, { name: renamed, description: "updated" });
    expect(updated).toMatchObject({ id: project.id, name: renamed, description: "updated" });
    expect((await client.projects.list()).find((p) => p.id === project.id)).toMatchObject({
      name: renamed,
      description: "updated",
    });
    // Omitting the description keeps it; an empty string clears it.
    expect((await client.projects.update(project.id, { name: renamed })).description).toBe("updated");
    expect((await client.projects.update(project.id, { description: "" })).description).toBe("");
    expect((await client.projects.list()).find((p) => p.id === project.id)?.description).toBe("");
    await expect(client.projects.update("proj_does_not_exist", { name: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(client.projects.create({ name: "" })).rejects.toMatchObject({ status: 400 });
  });

  it("env-crud", async () => {
    const env = await client.environments.create({ name: "staging", project_id: project.id });
    expect(env).toMatchObject({ name: "staging", project_id: project.id });
    expect(env.id).toBeTruthy();
    await expect(client.environments.create({ name: "Not Valid!", project_id: project.id })).rejects.toMatchObject({
      status: 400,
    });
    const envs = await client.environments.list();
    expect(envs.find((e) => e.id === env.id)).toMatchObject({ project_id: project.id });
    expect(envs.map((e) => e.id)).toContain(tenant.environment.id);

    expect(await client.environments.update(env.id, { name: "qa" })).toMatchObject({
      id: env.id,
      name: "qa",
      project_id: project.id,
    });

    // The Connect service sees the same environment.
    const res = await fetch(`${SERVER}/ironflow.v1.EnvironmentService/GetEnvironment`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tenant.apiKey.key}` },
      body: JSON.stringify({ id: env.id }),
    });
    expect(await res.json()).toMatchObject({ id: env.id, name: "qa" });

    await client.environments.delete(env.id);
    expect((await client.environments.list()).map((e) => e.id)).not.toContain(env.id);
    await expect(client.environments.delete(env.id)).rejects.toMatchObject({ status: 404 });
  });

  // The default environment stays, and another org cannot see or touch an
  // environment: a miss, the same as one that does not exist. The Node SDK has
  // no Connect EnvironmentService client, so GetEnvironment is posted directly.
  it("env-crud: the default environment stays; another org gets a 404", async () => {
    await expect(client.environments.delete("env_default")).rejects.toMatchObject({ message: expect.stringContaining("cannot delete default environment") });

    const env = await client.environments.create({ name: "owned", project_id: project.id });
    const operator = new IronflowClient({ serverUrl: SERVER, apiKey: process.env["IRONFLOW_TEST_API_KEY"] });
    const other = await operator.tenants.provision({ orgName: `Node projects other ${suffix}` });
    const stranger = new IronflowClient({ serverUrl: SERVER, apiKey: other.apiKey.key });
    await expect(stranger.environments.update(env.id, { name: "stolen" })).rejects.toMatchObject({ status: 404 });
    await expect(stranger.environments.delete(env.id)).rejects.toMatchObject({ status: 404 });
    const connectGet = (key: string) =>
      fetch(`${SERVER}/ironflow.v1.EnvironmentService/GetEnvironment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ id: env.id }),
      });
    expect((await connectGet(other.apiKey.key)).status).toBe(404);
    expect((await connectGet(tenant.apiKey.key)).status).toBe(200);
    await client.environments.delete(env.id);
  });

  it("project-crud: delete removes the project and its environments", async () => {
    const child = await client.environments.create({ name: "child", project_id: project.id });
    await client.projects.delete(project.id);
    expect((await client.projects.list()).map((p) => p.id)).not.toContain(project.id);
    expect((await client.environments.list()).map((e) => e.id)).not.toContain(child.id);
    await expect(client.projects.delete(project.id)).rejects.toMatchObject({ status: 404 });
  });
});
