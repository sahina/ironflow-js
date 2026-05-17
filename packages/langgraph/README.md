# @ironflow/langgraph

Durable [LangGraph](https://github.com/langchain-ai/langgraphjs) checkpoint
saver backed by [Ironflow](https://ironflow.run) entity streams.
Drop-in replacement for `MemorySaver` / `SqliteSaver` / `PostgresSaver` — your
agent state survives crashes and resumes from the last checkpoint with no extra
wiring.

Requires Node.js 20+.

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [API Reference](#api-reference)
4. [Storage Model](#storage-model)
5. [Subgraphs & Namespaces](#subgraphs--namespaces)
6. [Pending Writes](#pending-writes)
7. [Error Handling](#error-handling)
8. [Limitations](#limitations)
9. [Testing](#testing)
10. [Links](#links)

---

## Installation

```bash
npm install @ironflow/langgraph @ironflow/node @langchain/langgraph @langchain/langgraph-checkpoint
```

Peer dependencies (you install these yourself):

| Package | Version |
|---|---|
| `@langchain/core` | `^1.0.0` |
| `@langchain/langgraph-checkpoint` | `^1.0.0` |

Runtime dependencies (pulled in automatically):

| Package | Version |
|---|---|
| `@ironflow/core` | `0.22.4` |
| `@ironflow/node` | `0.22.4` |

## Quick Start

```ts
import { IronflowClient } from "@ironflow/node";
import { IronflowSaver } from "@ironflow/langgraph";
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";

const client = new IronflowClient({ serverUrl: process.env.IRONFLOW_URL! });
const saver = new IronflowSaver({ client });

const State = Annotation.Root({
  counter: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
});

const graph = new StateGraph(State)
  .addNode("step", (s) => ({ counter: s.counter + 1 }))
  .addEdge(START, "step")
  .addConditionalEdges("step", (s) => (s.counter >= 5 ? END : "step"))
  .compile({ checkpointer: saver });

await graph.invoke(
  { counter: 0 },
  { configurable: { thread_id: "thread-1" } }
);
```

If the process crashes mid-cycle, restarting with the same `thread_id` resumes
from the last persisted checkpoint.

## API Reference

### `new IronflowSaver(config)`

Constructs a `BaseCheckpointSaver` backed by an Ironflow entity stream per
thread.

```ts
interface IronflowSaverConfig {
  /** Ironflow client used for stream reads/writes. */
  client: IronflowClient;
  /** Optional serializer override. Default: BaseCheckpointSaver's JSON serde. */
  serde?: SerializerProtocol;
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `client` | `IronflowClient` | Yes | Pre-configured `@ironflow/node` client. |
| `serde` | `SerializerProtocol` | No | Custom serializer. Falls back to LangGraph's `JsonPlusSerializer`. |

### `saver.getTuple(config): Promise<CheckpointTuple \| undefined>`

Returns the checkpoint for `config.configurable.checkpoint_id`, or the latest
checkpoint for the thread if no id is given.

- `config.configurable.thread_id` — **required** (throws `LG_THREAD_ID_REQUIRED`).
- `config.configurable.checkpoint_ns` — optional namespace; default `""`.
- `config.configurable.checkpoint_id` — optional. If set, returns that specific
  checkpoint; otherwise the latest by `checkpoint_id` (UUID v6, lex == time).

### `saver.list(config, options?): AsyncGenerator<CheckpointTuple>`

Yields checkpoints in `checkpoint_id` descending order (latest first), matching
`MemorySaver` / `SqliteSaver` / `PostgresSaver` semantics.

- `config.configurable.thread_id` — **required** (throws `LG_THREAD_ID_REQUIRED`).
  Cross-thread iteration is not supported in v1; see [Limitations](#limitations).
- `config.configurable.checkpoint_ns` — optional namespace filter. Omit to
  iterate every namespace present in the thread.
- `config.configurable.checkpoint_id` — optional; restricts to a single id.
- `options.before.configurable.checkpoint_id` — only yield ids strictly less
  than this id.
- `options.limit` — cap yielded results.
- `options.filter` — shallow-equality filter on `metadata` keys.

### `saver.put(config, checkpoint, metadata, newVersions): Promise<RunnableConfig>`

Appends a `checkpoint.put` event to the thread's stream.

- Uses idempotency key `lg:put:{thread}:{ns}:{checkpoint_id}` so server-side
  dedup makes re-puts a no-op. LangGraph re-emits the same `checkpoint_id` on
  retry, so crash-replay produces no duplicates.
- Returns a `RunnableConfig` whose `configurable` carries the new
  `thread_id` / `checkpoint_ns` / `checkpoint_id`, suitable for chaining into
  the next `put` as `parent_checkpoint_id`.

### `saver.putWrites(config, writes, taskId): Promise<void>`

Appends a `checkpoint.putWrites` event holding pending writes for `taskId`
against the current checkpoint.

- `config.configurable.checkpoint_id` — **required** (throws
  `LG_CHECKPOINT_ID_REQUIRED`).
- No idempotency key — replays append fresh events; reads dedupe by
  `(taskId, idx)`. This matches `MemorySaver`'s cross-call accumulation:
  successive `putWrites` for the same `(checkpoint_id, task_id)` with new
  writes extend the visible `pendingWrites`.

### `saver.deleteThread(threadId): Promise<void>`

Appends a `checkpoint.deleteThread` tombstone. Reads ignore every event at or
before the highest tombstone's stream position, so checkpoints and writes are
logically dropped without rewriting history. Duplicate tombstones are harmless.

> The stream itself is not physically purged in v1 — events stay in the entity
> stream and are filtered on read. Use Ironflow stream retention policies for
> hard deletion.

## Storage Model

- One entity stream per LangGraph thread.
  - Stream id: `irn:agent-ckpt:{thread_id}`
  - Entity type: `agent-ckpt`
- Three event names:
  - `checkpoint.put` — full checkpoint snapshot (base64-encoded serialized
    bytes plus `checkpoint_ns`, `checkpoint_id`, `parent_checkpoint_id`, `ts`).
  - `checkpoint.putWrites` — pending writes for a task before the next
    checkpoint (`{ checkpoint_ns, checkpoint_id, task_id, writes[] }`).
  - `checkpoint.deleteThread` — tombstone; carries `deleted_at`.

The serde output (LangGraph emits `Uint8Array`) is base64-encoded into the
JSON event payload via `Buffer.from(bytes).toString("base64")` and decoded
back to `Uint8Array` on read.

### Read path

`getTuple` and `list` load the whole thread stream in batches of 500 events,
take the highest `deleteThread` position as a cutoff, then reduce remaining
events into a `ThreadView` of `{ checkpoints, writes, latest }`. Typical
threads (<100 checkpoints) materialize in a single batch; see
[Limitations](#limitations) for when this hurts.

## Subgraphs & Namespaces

LangGraph subgraphs scope their state with `checkpoint_ns`. `IronflowSaver`
honors that scoping inside one entity stream per thread:

```ts
const cfg = { configurable: { thread_id: "t1", checkpoint_ns: "child" } };
await saver.put(cfg, checkpoint, metadata, {});
```

- `getTuple` / `list` accept an optional `checkpoint_ns`. If omitted, `list`
  iterates every namespace that appears in the thread's events.
- A checkpoint and its `putWrites` must agree on `checkpoint_ns` — writes for
  one namespace never bleed into another.

## Pending Writes

LangGraph's `WRITES_IDX_MAP` decides which channel writes are deduped by
positive `idx`. `putWrites` deduplicates entries with the same `(taskId, idx)`
at write time; the read path performs the same dedup defensively across
multiple events for the same `(checkpoint_id, task_id)`.

Entries with `idx < 0` (special channels like task entries) are never deduped
— they accumulate, matching `MemorySaver`.

## Error Handling

Throws `IronflowError` (from `@ironflow/core`) on invalid usage:

| Code | When |
|---|---|
| `LG_THREAD_ID_REQUIRED` | `getTuple` / `list` / `put` / `putWrites` called without `configurable.thread_id`. |
| `LG_CHECKPOINT_ID_REQUIRED` | `putWrites` called without `configurable.checkpoint_id`. |

Both errors carry `retryable: false`. Other failures (network, server) surface
as `IronflowError` instances from the underlying `IronflowClient` call.

## Limitations

- **Node-only.** The serializer uses `Buffer` for base64 encoding. Browser /
  edge runtimes need a different saver.
- **`list()` requires `thread_id`.** Calling `saver.list({})` without a
  `thread_id` in `configurable` throws `LG_THREAD_ID_REQUIRED`. Ironflow has
  no global thread index in v1, so cross-thread iteration is not supported.
  Pass `configurable: { thread_id }` explicitly. (Tracked for a future
  projection-backed index.)
- **Full-stream materialization.** Reads currently load the entire thread's
  event stream and reduce in memory. Fine for typical thread sizes
  (<100 checkpoints); a managed projection can replace this if profiling
  shows it's worth it.
- **`deleteThread` is logical, not physical.** Events remain in the stream and
  are masked by the tombstone on read. Use Ironflow retention policies for
  hard deletion.

## Testing

```bash
# Unit tests (no server required)
pnpm -C sdk/js/langgraph test

# Integration tests (against a running server)
./build/ironflow serve --dev
IRONFLOW_INTEGRATION=1 pnpm -C sdk/js/langgraph test

# Point at a non-default server
IRONFLOW_INTEGRATION=1 IRONFLOW_SERVER_URL=http://localhost:9123 \
  pnpm -C sdk/js/langgraph test
```

The integration suite (`tests/integration.test.ts`) covers the crash-resume
narrative, idempotent re-puts, and descending-order `list` semantics.

## Links

- Repo: [github.com/sahina/ironflow-js](https://github.com/sahina/ironflow-js)
- Marketing: [ironflow.run](https://ironflow.run)
- Docs: [docs.ironflow.run](https://docs.ironflow.run)
- LangGraph JS: [github.com/langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs)

## License

See [LICENSE](https://github.com/sahina/ironflow-js/blob/main/LICENSE) — Ironflow EULA.
