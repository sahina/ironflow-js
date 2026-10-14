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
// Policy Set Types (Rego)
// ============================================================================

export type PolicySetMode = "enforce" | "monitor";

export interface PolicySet {
  /** 0 when the org has no set. */
  version: number;
  modules: Record<string, string>;
  decision?: string;
  mode: PolicySetMode | "";
  updated_at?: string;
  updated_by?: string;
  /**
   * False when the server runs with policy enforcement off, so an "enforce"
   * set is stored but not applied. Absent from a server that does not say.
   */
  enforcement_active?: boolean;
}

export interface PolicySetInput {
  modules: Record<string, string>;
  /** Omitted: keep the current rule; "" clears it. */
  decision?: string;
  /** Omitted: keep the current mode; a new set starts in "monitor". */
  mode?: PolicySetMode;
}

export interface PolicySetVersion {
  version: number;
  mode: PolicySetMode;
  decision?: string;
  created_at: string;
  created_by?: string;
}

export interface PolicySetDryRunInput {
  /** Omitted: evaluate against the active set. */
  set?: PolicySetInput;
  input: { request: Record<string, unknown>; subject: Record<string, unknown>; [key: string]: unknown };
  explain?: boolean;
}

export interface PolicySetDryRunResult {
  /** The set's own verdict, whatever its mode. */
  decision: "allow" | "deny";
  mode: PolicySetMode;
  version?: number;
  reasons?: string[];
  /** Reasons dropped beyond the first 100. */
  reasons_omitted?: number;
  entrypoint?: string;
  error?: string;
  explain?: string;
}
