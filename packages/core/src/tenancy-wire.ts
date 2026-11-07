import type {
  APIKey,
  APIKeyWithSecret,
  Organization,
  PolicySet,
  PolicySetVersion,
  Role,
} from "./auth-types.js";
import { optionalTimestampFromWire, timestampFromWire } from "./timestamp-wire.js";
import type { Environment, Project, Secret, SecretListEntry } from "./types.js";

export function apiKeyFromWire(raw: Record<string, unknown>): APIKey {
  return {
    ...raw,
    created_at: timestampFromWire("APIKey.created_at", raw.created_at),
    expires_at: optionalTimestampFromWire("APIKey.expires_at", raw.expires_at),
    last_used_at: optionalTimestampFromWire("APIKey.last_used_at", raw.last_used_at),
  } as APIKey;
}

export function apiKeyWithSecretFromWire(raw: Record<string, unknown>): APIKeyWithSecret {
  return apiKeyFromWire(raw) as APIKeyWithSecret;
}

export function organizationFromWire(raw: Record<string, unknown>): Organization {
  return {
    ...raw,
    created_at: timestampFromWire("Organization.created_at", raw.created_at),
    updated_at: timestampFromWire("Organization.updated_at", raw.updated_at),
  } as Organization;
}

export function roleFromWire(raw: Record<string, unknown>): Role {
  return {
    ...raw,
    created_at: timestampFromWire("Role.created_at", raw.created_at),
  } as Role;
}

export function policySetFromWire(raw: Record<string, unknown>): PolicySet {
  return {
    ...raw,
    updated_at: optionalTimestampFromWire("PolicySet.updated_at", raw.updated_at),
  } as PolicySet;
}

function policySetVersionFromWire(raw: Record<string, unknown>): PolicySetVersion {
  return {
    ...raw,
    created_at: timestampFromWire("PolicySetVersion.created_at", raw.created_at),
  } as PolicySetVersion;
}

export function policySetVersionsFromWire(raw: { versions: Record<string, unknown>[] }): PolicySetVersion[] {
  return raw.versions.map(policySetVersionFromWire);
}

export function secretFromWire(raw: Record<string, unknown>): Secret {
  return {
    ...raw,
    created_at: timestampFromWire("Secret.created_at", raw.created_at),
    updated_at: timestampFromWire("Secret.updated_at", raw.updated_at),
  } as Secret;
}

export function secretListEntryFromWire(raw: Record<string, unknown>): SecretListEntry {
  return {
    ...raw,
    created_at: timestampFromWire("SecretListEntry.created_at", raw.created_at),
    updated_at: timestampFromWire("SecretListEntry.updated_at", raw.updated_at),
  } as SecretListEntry;
}

export function projectFromWire(raw: Record<string, unknown>): Project {
  return {
    ...raw,
    created_at: timestampFromWire("Project.created_at", raw.created_at),
    updated_at: timestampFromWire("Project.updated_at", raw.updated_at),
  } as Project;
}

export function environmentFromWire(raw: Record<string, unknown>): Environment {
  return {
    ...raw,
    created_at: timestampFromWire("Environment.created_at", raw.created_at),
    updated_at: timestampFromWire("Environment.updated_at", raw.updated_at),
  } as Environment;
}
