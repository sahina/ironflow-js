/**
 * exposeMcp() — register agent tools with Ironflow's AgentToolsService
 * and serve dispatched invocations over the existing serve() mount.
 *
 * Boot-time flow:
 *
 *	1. Convert each McpToolDef.input (Zod) → JSON Schema (Draft 2020-12)
 *	   via z.toJSONSchema().
 *	2. POST `/ironflow.v1.AgentToolsService/RegisterTool` with
 *	   {agentName, callbackUrl, tools[]}.
 *	3. Stash the returned HMAC secret + def closures in the local
 *	   registry so serve()'s dispatch route can validate inbound calls.
 *
 * Callback flow lives in `dispatch.ts` (HMAC verify + Zod parse + handler).
 *
 * Authoritative authorization stays server-side: scopes on McpToolDef
 * are advisory hints to MCP clients. The server enforces api_key.tool_scopes
 * superset against ToolDef.required_scopes. RegisterTool requires the
 * `agent:tools:register` action on the calling key.
 */

import { IronflowError } from "@ironflow/core";
import { z } from "zod";
import {
  registerLocal,
  unregisterLocal,
  type RegisteredTool,
} from "./internal-registry.js";
import type { AnyMcpToolDef, ExposeMcpConfig } from "./types.js";

const REGISTER_PATH = "/ironflow.v1.AgentToolsService/RegisterTool";
const UNREGISTER_PATH = "/ironflow.v1.AgentToolsService/UnregisterTool";

/**
 * Handle returned from exposeMcp(). `unregister()` removes the tools
 * from both the Ironflow server's registry and the local SDK mirror.
 */
export interface ExposeMcpHandle {
  /** Server name (== agent namespace) reported to MCP clients. */
  readonly name: string;
  /** Number of tools registered with the server. */
  readonly toolCount: number;
  /** Status indicator. "active" once RegisterTool succeeds. */
  readonly status: "active";
  /** Qualified names registered (`{agentName}.{toolName}`). */
  readonly toolNames: ReadonlyArray<string>;
  /**
   * Remove all tools registered under this agent name. Idempotent —
   * server returns 200 with removed_count=0 if the agent was already
   * gone. Local registry entries are cleared even if the server call
   * fails so handler closures don't leak.
   */
  unregister(): Promise<void>;
}

interface RegisterToolResponseJSON {
  hmacSecret?: string;
  registeredToolNames?: string[];
}

/**
 * Register the supplied MCP tool definitions with the Ironflow server.
 *
 * Returns an active handle once RegisterTool succeeds. Throws on
 * empty tool lists, missing config (server URL / API key / callback URL),
 * or transport failure.
 */
export async function exposeMcp(config: ExposeMcpConfig): Promise<ExposeMcpHandle> {
  if (!config.tools.length) {
    throw new IronflowError("exposeMcp() requires at least one tool", {
      code: "AGENT_MCP_NO_TOOLS",
      retryable: false,
    });
  }
  if (!config.callbackUrl) {
    throw new IronflowError(
      "exposeMcp() requires callbackUrl pointing at your serve() mount",
      { code: "AGENT_MCP_MISSING_CALLBACK_URL", retryable: false }
    );
  }

  const serverUrl =
    config.serverUrl ??
    process.env.IRONFLOW_URL ??
    process.env.IRONFLOW_SERVER_URL;
  if (!serverUrl) {
    throw new IronflowError(
      "exposeMcp() requires serverUrl (or IRONFLOW_URL / IRONFLOW_SERVER_URL env)",
      { code: "AGENT_MCP_MISSING_SERVER_URL", retryable: false }
    );
  }

  const apiKey = config.apiKey ?? process.env.IRONFLOW_API_KEY;
  if (!apiKey) {
    throw new IronflowError(
      "exposeMcp() requires apiKey (or IRONFLOW_API_KEY env) with the agent:tools:register action",
      { code: "AGENT_MCP_MISSING_API_KEY", retryable: false }
    );
  }

  const seen = new Set<string>();
  const toolPayload = config.tools.map((def) => {
    if (seen.has(def.name)) {
      throw new IronflowError(
        `exposeMcp() received duplicate tool name "${def.name}"`,
        { code: "AGENT_MCP_DUPLICATE_TOOL", retryable: false }
      );
    }
    seen.add(def.name);
    return toToolDefJSON(def);
  });

  const requestBody = {
    agentName: config.name,
    callbackUrl: config.callbackUrl,
    tools: toolPayload,
  };

  const resp = await postJSON(serverUrl, REGISTER_PATH, apiKey, requestBody);
  const decoded = (await readJSON(resp)) as RegisterToolResponseJSON;
  if (!decoded.hmacSecret || !decoded.registeredToolNames?.length) {
    throw new IronflowError(
      "RegisterTool response missing hmacSecret or registeredToolNames",
      { code: "AGENT_MCP_INVALID_RESPONSE", retryable: false }
    );
  }

  const qualifiedNames = decoded.registeredToolNames;
  for (const def of config.tools) {
    const qualifiedName = `${config.name}.${def.name}`;
    const entry: RegisteredTool = {
      agentName: config.name,
      qualifiedName,
      hmacSecret: decoded.hmacSecret,
      def,
    };
    registerLocal(entry);
  }

  let unregistered = false;
  return {
    name: config.name,
    toolCount: qualifiedNames.length,
    status: "active",
    toolNames: qualifiedNames,
    async unregister(): Promise<void> {
      if (unregistered) {
        return;
      }
      unregistered = true;
      // Always clear local entries so handler closures stop receiving
      // dispatches even when the server-side call fails.
      unregisterLocal(config.name);
      try {
        const r = await postJSON(serverUrl, UNREGISTER_PATH, apiKey, {
          agentName: config.name,
        });
        await readJSON(r);
      } catch (err) {
        throw new IronflowError(
          `unregister failed: ${err instanceof Error ? err.message : String(err)}`,
          { code: "AGENT_MCP_UNREGISTER_FAILED", retryable: false }
        );
      }
    },
  };
}

interface ToolDefJSON {
  name: string;
  description: string;
  inputSchemaJson: string;
  requiredScopes: string[];
  timeoutMs: number;
}

function toToolDefJSON(def: AnyMcpToolDef): ToolDefJSON {
  let schemaObj: unknown;
  try {
    schemaObj = z.toJSONSchema(def.input);
  } catch (err) {
    throw new IronflowError(
      `exposeMcp() failed to convert input schema for "${def.name}": ${err instanceof Error ? err.message : String(err)}`,
      { code: "AGENT_MCP_SCHEMA_CONVERSION_FAILED", retryable: false }
    );
  }
  return {
    name: def.name,
    description: def.description,
    inputSchemaJson: JSON.stringify(schemaObj),
    requiredScopes: def.scopes ? [...def.scopes] : [],
    timeoutMs: 0,
  };
}

async function postJSON(
  serverUrl: string,
  path: string,
  apiKey: string,
  body: unknown
): Promise<Response> {
  const url = `${serverUrl.replace(/\/+$/, "")}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new IronflowError(
      `POST ${path} failed: HTTP ${resp.status}${text ? ` — ${text}` : ""}`,
      { code: "AGENT_MCP_TRANSPORT_ERROR", retryable: false }
    );
  }
  return resp;
}

async function readJSON(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new IronflowError(`response body is not valid JSON: ${text.slice(0, 256)}`, {
      code: "AGENT_MCP_INVALID_RESPONSE",
      retryable: false,
    });
  }
}
