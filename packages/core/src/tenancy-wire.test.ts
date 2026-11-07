import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "./errors.js";
import {
  apiKeyFromWire,
  apiKeyWithSecretFromWire,
  environmentFromWire,
  organizationFromWire,
  policySetFromWire,
  policySetVersionsFromWire,
  projectFromWire,
  roleFromWire,
  secretFromWire,
  secretListEntryFromWire,
} from "./tenancy-wire.js";
import { tenantFromWire, userFromWire } from "./types.js";

const STAMP = "2026-01-02T03:04:05Z";
const DATE = new Date(STAMP);
const both = { created_at: STAMP, updated_at: STAMP };

describe("required timestamps", () => {
  const decoders: [string, (raw: Record<string, unknown>) => unknown, string, Record<string, unknown>][] = [
    ["APIKey", apiKeyFromWire, "APIKey.created_at", {}],
    ["Organization", organizationFromWire, "Organization.created_at", { updated_at: STAMP }],
    ["Organization", organizationFromWire, "Organization.updated_at", { created_at: STAMP }],
    ["Role", roleFromWire, "Role.created_at", {}],
    ["Secret", secretFromWire, "Secret.created_at", { updated_at: STAMP }],
    ["Secret", secretFromWire, "Secret.updated_at", { created_at: STAMP }],
    ["SecretListEntry", secretListEntryFromWire, "SecretListEntry.created_at", { updated_at: STAMP }],
    ["SecretListEntry", secretListEntryFromWire, "SecretListEntry.updated_at", { created_at: STAMP }],
    ["Project", projectFromWire, "Project.created_at", { updated_at: STAMP }],
    ["Project", projectFromWire, "Project.updated_at", { created_at: STAMP }],
    ["Environment", environmentFromWire, "Environment.created_at", { updated_at: STAMP }],
    ["Environment", environmentFromWire, "Environment.updated_at", { created_at: STAMP }],
    ["Tenant", tenantFromWire, "tenant.createdAt", {}],
    ["User", userFromWire, "user.createdAt", { updated_at: STAMP }],
    ["User", userFromWire, "user.updatedAt", { created_at: STAMP }],
  ];

  it.each(decoders)("%s throws naming %s when it is absent", (_type, decode, field, rest) => {
    expect(() => decode(rest)).toThrow(SchemaValidationError);
    expect(() => decode(rest)).toThrow(field);
  });
});

describe("apiKeyFromWire", () => {
  it("decodes every timestamp", () => {
    expect(apiKeyFromWire({ id: "ak_1", created_at: STAMP, expires_at: STAMP, last_used_at: STAMP })).toMatchObject({
      id: "ak_1",
      created_at: DATE,
      expires_at: DATE,
      last_used_at: DATE,
    });
  });

  it.each([[undefined], [null], [""]])("leaves expires_at and last_used_at absent for %j", (unset) => {
    const key = apiKeyFromWire({ created_at: STAMP, expires_at: unset, last_used_at: unset });
    expect(key.expires_at).toBeUndefined();
    expect(key.last_used_at).toBeUndefined();
  });

  it("throws on an unreadable optional timestamp", () => {
    expect(() => apiKeyFromWire({ created_at: STAMP, last_used_at: "soon" })).toThrow("APIKey.last_used_at");
  });
});

describe("credentials", () => {
  it("keeps the one-time key through decoding", () => {
    expect(apiKeyWithSecretFromWire({ created_at: STAMP, key: "ifkey_raw" }).key).toBe("ifkey_raw");
  });

  it("names the field and prints only the timestamp value in a decode error", () => {
    const failure = (decode: () => unknown): SchemaValidationError => {
      try {
        decode();
      } catch (err) {
        return err as SchemaValidationError;
      }
      throw new Error("expected a decode error");
    };

    const key = failure(() => apiKeyWithSecretFromWire({ key: "ifkey_raw", created_at: "garbled" }));
    const secret = failure(() => secretFromWire({ name: "n", value: "hunter2", created_at: "garbled", updated_at: STAMP }));

    expect(key.message).toBe("Invalid APIKey.created_at from server: garbled");
    expect(secret.message).toBe("Invalid Secret.created_at from server: garbled");
    expect(JSON.stringify({ ...key, message: key.message })).not.toContain("ifkey_raw");
    expect(JSON.stringify({ ...secret, message: secret.message })).not.toContain("hunter2");
  });
});

describe("decoders keep the rest of the row", () => {
  it("organization", () => {
    expect(organizationFromWire({ id: "org_1", preferences: { default_timezone: "UTC" }, ...both })).toEqual({
      id: "org_1",
      preferences: { default_timezone: "UTC" },
      created_at: DATE,
      updated_at: DATE,
    });
  });

  it("role", () => {
    expect(roleFromWire({ id: "r", api_key_count: 2, created_at: STAMP })).toEqual({ id: "r", api_key_count: 2, created_at: DATE });
  });

  it("secret", () => {
    expect(secretFromWire({ name: "n", description: "d", revision: 3, ...both })).toEqual({
      name: "n",
      description: "d",
      revision: 3,
      created_at: DATE,
      updated_at: DATE,
    });
    expect(secretListEntryFromWire({ name: "n", ...both })).toEqual({ name: "n", created_at: DATE, updated_at: DATE });
  });

  it("project and environment", () => {
    expect(projectFromWire({ id: "p", org_id: "o", ...both })).toEqual({ id: "p", org_id: "o", created_at: DATE, updated_at: DATE });
    expect(environmentFromWire({ id: "e", color: "#fff", ...both })).toEqual({ id: "e", color: "#fff", created_at: DATE, updated_at: DATE });
  });
});

describe("policy sets", () => {
  it("has no updated_at at version 0", () => {
    expect(policySetFromWire({ version: 0, modules: {}, mode: "" }).updated_at).toBeUndefined();
  });

  it("decodes updated_at on a stored set", () => {
    expect(policySetFromWire({ version: 2, modules: { "a.rego": "package a" }, mode: "monitor", updated_at: STAMP })).toEqual({
      version: 2,
      modules: { "a.rego": "package a" },
      mode: "monitor",
      updated_at: DATE,
    });
  });

  it("decodes each version", () => {
    expect(policySetVersionsFromWire({ versions: [{ version: 1, mode: "monitor", created_at: STAMP }] })).toEqual([
      { version: 1, mode: "monitor", created_at: DATE },
    ]);
  });
});

describe("tenant and user", () => {
  it("decodes user timestamps", () => {
    expect(userFromWire({ id: "u", ...both })).toMatchObject({ createdAt: DATE, updatedAt: DATE });
  });
});
