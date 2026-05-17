/**
 * Process-local registry that links exposeMcp() to serve()'s dispatch
 * handler. Keyed by qualified name (`{agentName}.{toolName}`).
 *
 * The Ironflow server holds the canonical registry (NATS KV in cluster
 * mode, in-memory in single-node). This map is the SDK's local mirror —
 * we need the McpToolDef closure (handler + Zod schemas) and the HMAC
 * secret to validate inbound dispatches.
 *
 * Single instance per Node.js process. Re-registering the same agent
 * name overwrites the prior entries; unregister removes them. HMR may
 * leave stale entries until the next exposeMcp() call rotates them —
 * acceptable for dev, documented in the README.
 */

import type { AnyMcpToolDef } from "./types.js";

export interface RegisteredTool {
  agentName: string;
  qualifiedName: string;
  hmacSecret: string;
  def: AnyMcpToolDef;
}

const registry = new Map<string, RegisteredTool>();

export function registerLocal(entry: RegisteredTool): void {
  registry.set(entry.qualifiedName, entry);
}

export function unregisterLocal(agentName: string): string[] {
  const removed: string[] = [];
  for (const [qualifiedName, entry] of registry) {
    if (entry.agentName === agentName) {
      registry.delete(qualifiedName);
      removed.push(qualifiedName);
    }
  }
  return removed;
}

export function lookupLocal(qualifiedName: string): RegisteredTool | undefined {
  return registry.get(qualifiedName);
}

/** Test-only — drop all entries. */
export function clearLocalForTests(): void {
  registry.clear();
}
