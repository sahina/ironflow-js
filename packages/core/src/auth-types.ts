/**
 * Auth Management Types
 *
 * Types for API keys, organizations, roles, and policies.
 */

// ============================================================================
// API Key Types
// ============================================================================

export interface APIKey {
  id: string;
  name: string;
  key_prefix: string;
  role_ids?: string[];
  created_at: string;
  expires_at?: string;
  last_used_at?: string;
}

export interface APIKeyWithSecret extends APIKey {
  key: string;
}

export interface CreateAPIKeyInput {
  name: string;
  env_id?: string;
  role_ids?: string[];
  expires_in?: string;
}

// ============================================================================
// Organization Types
// ============================================================================

export interface Organization {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CreateOrgInput {
  name: string;
}

export interface UpdateOrgInput {
  name?: string;
}

// ============================================================================
// Role Types
// ============================================================================

export interface Role {
  id: string;
  org_id: string;
  name: string;
  is_default: boolean;
  created_at: string;
}

export interface CreateRoleInput {
  name: string;
  org_id: string;
}

export interface UpdateRoleInput {
  name?: string;
}

// ============================================================================
// Policy Types
// ============================================================================

// #943 (ADR 0016 T2): write surfaces accept effect="deny" only.
// The Policy READ type keeps "allow" in the union so legacy rows fetched
// during the upgrade window (Release N to migration-030 sweep) can be
// rendered without type assertions. CREATE + UPDATE input types are
// narrowed to "deny" so callers cannot send the deprecated value.
// Server still rejects effect=allow with HTTP 400; this narrowing catches
// the mistake at TypeScript compile time.
export interface Policy {
  id: string;
  org_id: string;
  name: string;
  effect: "allow" | "deny";
  actions: string;
  resources: string;
  condition?: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePolicyInput {
  name: string;
  effect: "deny";
  actions: string;
  resources: string;
  condition?: string;
  org_id: string;
}

export interface UpdatePolicyInput {
  name?: string;
  effect?: "deny";
  actions?: string;
  resources?: string;
  condition?: string;
}
