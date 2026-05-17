/**
 * @ironflow/langgraph — durable LangGraph checkpoint saver.
 *
 * Drop-in replacement for MemorySaver / SqliteSaver / PostgresSaver. Stores
 * each thread's checkpoint stream in Ironflow as a per-thread entity stream
 * (`irn:agent-ckpt:{thread_id}`), inheriting Ironflow's crash-resume,
 * audit, and replay semantics.
 *
 * @example
 * ```ts
 * import { IronflowClient } from "@ironflow/node";
 * import { IronflowSaver } from "@ironflow/langgraph";
 * import { StateGraph } from "@langchain/langgraph";
 *
 * const client = new IronflowClient({ serverUrl: process.env.IRONFLOW_URL! });
 * const saver = new IronflowSaver({ client });
 * const graph = new StateGraph(...).compile({ checkpointer: saver });
 * await graph.invoke(input, { configurable: { thread_id: "thread-1" } });
 * ```
 */

export { IronflowSaver } from "./saver.js";
export type { IronflowSaverConfig } from "./saver.js";
