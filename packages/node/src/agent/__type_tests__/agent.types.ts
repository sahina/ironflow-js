/**
 * Type-only regression tests for issue #609.
 *
 * Compile-time assertions; no runtime body. Vitest does not pick this file
 * up (the filename omits .test.ts on purpose). The regression guard is
 * `tsc -p tsconfig.test.json --noEmit` wired into pnpm typecheck:test.
 *
 * If this file ever fails to typecheck, the variance fix in #609 has rotted:
 *   - AgentConfig.tools no longer accepts narrow ToolDefinitions, OR
 *   - IronflowAgent<T,R> no longer widens to AnyIronflowFunction[], OR
 *   - the schema-driven event.data narrowing has broken.
 */

import { z } from "zod";
import type { createWorker } from "../../worker.js";
import type { serve } from "../../serve.js";
import type { createTestClient } from "../../test/index.js";
import { agent } from "../agent.js";
import { defineTool } from "../tool.js";
import type { ToolDefinition } from "../types.js";

// Compile-time identity. The generic constraint enforces the type
// relationship; runtime body is intentionally empty.
function assertType<T>(_v: T): void {
  void _v;
}

const ocr = defineTool({
  name: "ocr",
  input: z.object({ imageUrl: z.string().url() }),
  handler: async ({ imageUrl }) => ({ text: imageUrl }),
});

// Narrow tool type preserved by defineTool.
assertType<ToolDefinition<{ imageUrl: string }, { text: string }>>(ocr);

const docAgent = agent(
  {
    id: "doc-processor",
    triggers: [{ event: "doc.received" }],
    schema: z.object({ docId: z.string(), imageUrl: z.string().url() }),
    tools: [ocr],
  },
  async ({ event }) => {
    // event.data narrows from the schema; this read is the regression.
    assertType<string>(event.data.docId);
    assertType<string>(event.data.imageUrl);
    return { docId: event.data.docId };
  }
);

// Narrow agent must widen into framework configs.
assertType<Parameters<typeof createWorker>[0]["functions"][number]>(docAgent);
assertType<Parameters<typeof serve>[0]["functions"][number]>(docAgent);
assertType<Parameters<typeof createTestClient>[0]["functions"][number]>(
  docAgent
);

// Heterogeneous mix of narrow agents must satisfy AnyIronflowFunction[].
const a = agent(
  {
    id: "a",
    triggers: [{ event: "a.start" }],
    schema: z.object({ a: z.string() }),
  },
  async ({ event }) => event.data.a
);

const b = agent(
  {
    id: "b",
    triggers: [{ event: "b.start" }],
    schema: z.object({ b: z.number() }),
  },
  async ({ event }) => event.data.b * 2
);

const cfg = { functions: [a, b] };
assertType<Parameters<typeof createWorker>[0]>(cfg);
