/**
 * IronflowSaver — LangGraph BaseCheckpointSaver backed by Ironflow entity streams.
 *
 * Storage model:
 *   - One entity stream per LangGraph thread, id = `irn:agent-ckpt:{thread_id}`
 *   - entity_type = `agent-ckpt`
 *   - Three event names:
 *       checkpoint.put          — full checkpoint snapshot
 *       checkpoint.putWrites    — pending writes for a task before next checkpoint
 *       checkpoint.deleteThread — tombstone; drops all events at-or-before its position
 *
 * Replay semantics:
 *   - put events use idempotency key `lg:put:{thread}:{ns}:{checkpoint_id}` so
 *     server-side dedup makes re-puts a no-op (LangGraph re-emits the same
 *     checkpoint_id on retry).
 *   - putWrites events use no idempotency key — replays append fresh events and
 *     materialize() dedupes by (taskId, idx) at read time. This matches
 *     MemorySaver's cross-call accumulation: a second putWrites for the same
 *     (checkpoint_id, task_id) with different writes adds them to the visible
 *     pendingWrites list rather than dropping the whole event.
 *
 * Read path materializes the stream in memory. v1 is happy with full scans
 * (typical thread has <100 events). Optimization via a managed projection
 * is a separate issue once profiling shows it's worth it.
 */

import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointTuple,
  WRITES_IDX_MAP,
  type ChannelVersions,
  copyCheckpoint,
  getCheckpointId,
} from "@langchain/langgraph-checkpoint";
import type {
  CheckpointMetadata,
  CheckpointPendingWrite,
  PendingWrite,
  SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { IronflowError, type StreamEvent } from "@ironflow/core";
import type { IronflowClient } from "@ironflow/node";
import { b64ToBytes, bytesToB64 } from "./encoding.js";

const ENTITY_TYPE = "agent-ckpt";
const EVT_PUT = "checkpoint.put";
const EVT_PUT_WRITES = "checkpoint.putWrites";
const EVT_DELETE = "checkpoint.deleteThread";
const READ_BATCH = 500;

interface PutEventData {
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  type: string;
  checkpoint_b64: string;
  metadata_b64: string;
  metadata_type: string;
  ts: string;
}

interface WriteEntry {
  channel: string;
  idx: number;
  type: string;
  value_b64: string;
}

interface PutWritesEventData {
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  writes: WriteEntry[];
}

export interface IronflowSaverConfig {
  /** Ironflow client used for stream reads/writes. */
  client: IronflowClient;
  /** Optional serializer override. Default: BaseCheckpointSaver's JSON serde. */
  serde?: SerializerProtocol;
}

export class IronflowSaver extends BaseCheckpointSaver {
  private readonly client: IronflowClient;

  constructor(config: IronflowSaverConfig) {
    super(config.serde);
    this.client = config.client;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = requireThreadId(config);
    const ns = config.configurable?.checkpoint_ns ?? "";
    const requestedId = getCheckpointId(config);

    const events = await this.readStream(threadId);
    const view = materialize(events, ns);
    if (!view) return undefined;

    const target = requestedId
      ? view.checkpoints.get(requestedId)
      : view.latest;
    if (!target) return undefined;

    return await this.toTuple(target, ns, threadId, view, requestedId ? config : undefined);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { before, limit, filter } = options ?? {};
    const threadId = config.configurable?.thread_id;
    const ns = config.configurable?.checkpoint_ns;
    const filterCheckpointId = config.configurable?.checkpoint_id;
    const beforeId = before?.configurable?.checkpoint_id;

    if (!threadId) {
      throw new IronflowError(
        "list() without thread_id requires server-side index — pass thread_id in config.configurable",
        { code: "LG_THREAD_ID_REQUIRED", retryable: false }
      );
    }
    let yielded = 0;

    const events = await this.readStream(threadId);
    const namespaces = ns !== undefined ? [ns] : namespacesIn(events);
    for (const useNs of namespaces) {
      const view = materialize(events, useNs);
      if (!view) continue;
      // Sort by checkpoint_id descending. LangGraph's checkpoint IDs are
      // UUID v6 (timestamp-prefixed lex-ordered) per
      // @langchain/langgraph-checkpoint base.d.ts; this matches MemorySaver
      // / SqliteSaver / PostgresSaver "ORDER BY checkpoint_id DESC" semantics.
      const ordered = [...view.checkpoints.values()].sort((a, b) =>
        b.data.checkpoint_id.localeCompare(a.data.checkpoint_id)
      );
      for (const entry of ordered) {
        const id = entry.data.checkpoint_id;
        if (filterCheckpointId && id !== filterCheckpointId) continue;
        if (beforeId && id >= beforeId) continue;

        const tuple = await this.toTuple(entry, useNs, threadId, view, undefined);
        if (filter && !matchesFilter(tuple.metadata, filter)) continue;

        if (limit !== undefined && yielded >= limit) return;
        yielded += 1;
        yield tuple;
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    const threadId = requireThreadId(config);
    const ns = config.configurable?.checkpoint_ns ?? "";
    const parentId = config.configurable?.checkpoint_id as string | undefined;

    const prepared = copyCheckpoint(checkpoint);
    const [
      [cpType, cpBytes],
      [metaType, metaBytes],
    ] = await Promise.all([
      this.serde.dumpsTyped(prepared),
      this.serde.dumpsTyped(metadata),
    ]);

    const data: PutEventData = {
      checkpoint_ns: ns,
      checkpoint_id: checkpoint.id,
      type: cpType,
      checkpoint_b64: bytesToB64(cpBytes),
      metadata_b64: bytesToB64(metaBytes),
      metadata_type: metaType,
      ts: checkpoint.ts,
      ...(parentId ? { parent_checkpoint_id: parentId } : {}),
    };

    await this.client.streams.append(
      streamId(threadId),
      { name: EVT_PUT, data: data as unknown as Record<string, unknown>, entityType: ENTITY_TYPE },
      { idempotencyKey: `lg:put:${threadId}:${ns}:${checkpoint.id}` }
    );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    const threadId = requireThreadId(config);
    const ns = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;
    if (typeof checkpointId !== "string" || !checkpointId) {
      throw new IronflowError(
        "putWrites requires checkpoint_id in RunnableConfig.configurable",
        { code: "LG_CHECKPOINT_ID_REQUIRED", retryable: false }
      );
    }

    const seen = new Set<string>();
    const entries: WriteEntry[] = [];
    for (let i = 0; i < writes.length; i += 1) {
      const [channel, value] = writes[i]!;
      const idx = WRITES_IDX_MAP[channel] ?? i;
      const dedupKey = `${taskId}:${idx}`;
      if (idx >= 0 && seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const [type, bytes] = await this.serde.dumpsTyped(value);
      entries.push({ channel, idx, type, value_b64: bytesToB64(bytes) });
    }

    if (entries.length === 0) return;

    const data: PutWritesEventData = {
      checkpoint_ns: ns,
      checkpoint_id: checkpointId,
      task_id: taskId,
      writes: entries,
    };

    await this.client.streams.append(
      streamId(threadId),
      {
        name: EVT_PUT_WRITES,
        data: data as unknown as Record<string, unknown>,
        entityType: ENTITY_TYPE,
      }
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    // No idempotency key — semantics are "append a tombstone", not dedup.
    // Multiple deletes append multiple tombstones; reads use the highest one
    // as cutoff, so duplicate tombstones are harmless.
    await this.client.streams.append(
      streamId(threadId),
      {
        name: EVT_DELETE,
        data: { deleted_at: new Date().toISOString() },
        entityType: ENTITY_TYPE,
      }
    );
  }

  private async readStream(threadId: string): Promise<StreamEvent[]> {
    const all: StreamEvent[] = [];
    let fromVersion = 0;
    while (true) {
      const { events } = await this.client.streams.read(streamId(threadId), {
        fromVersion,
        limit: READ_BATCH,
        direction: "forward",
      });
      if (events.length === 0) break;
      all.push(...events);
      const last = events[events.length - 1]!;
      if (events.length < READ_BATCH) break;
      fromVersion = last.entityVersion + 1;
    }
    return all;
  }

  private async toTuple(
    entry: PutEntry,
    ns: string,
    threadId: string,
    view: ThreadView,
    originalConfig: RunnableConfig | undefined
  ): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(
      entry.data.type,
      b64ToBytes(entry.data.checkpoint_b64)
    )) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(
      entry.data.metadata_type,
      b64ToBytes(entry.data.metadata_b64)
    )) as CheckpointMetadata;

    const writes = view.writes.get(entry.data.checkpoint_id) ?? [];
    const pendingWrites: CheckpointPendingWrite[] = [];
    const seenWrite = new Set<string>();
    for (const w of writes) {
      const key = `${w.taskId}:${w.idx}`;
      if (w.idx >= 0 && seenWrite.has(key)) continue;
      seenWrite.add(key);
      const value = await this.serde.loadsTyped(w.type, b64ToBytes(w.value_b64));
      pendingWrites.push([w.taskId, w.channel, value]);
    }

    const tuple: CheckpointTuple = {
      config: originalConfig ?? {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: entry.data.checkpoint_id,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (entry.data.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: entry.data.parent_checkpoint_id,
        },
      };
    }
    return tuple;
  }
}

function streamId(threadId: string): string {
  return `irn:agent-ckpt:${threadId}`;
}

function requireThreadId(config: RunnableConfig): string {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== "string" || !threadId) {
    throw new IronflowError(
      "RunnableConfig.configurable.thread_id is required",
      { code: "LG_THREAD_ID_REQUIRED", retryable: false }
    );
  }
  return threadId;
}

interface PutEntry {
  data: PutEventData;
  version: number;
}

interface FlatWrite {
  checkpointId: string;
  taskId: string;
  channel: string;
  idx: number;
  type: string;
  value_b64: string;
  version: number;
}

interface ThreadView {
  checkpoints: Map<string, PutEntry>;
  writes: Map<string, FlatWrite[]>;
  latest: PutEntry | undefined;
}

function materialize(events: StreamEvent[], ns: string): ThreadView | undefined {
  let cutoff = -1;
  for (const e of events) {
    if (e.name === EVT_DELETE && e.entityVersion > cutoff) {
      cutoff = e.entityVersion;
    }
  }

  const checkpoints = new Map<string, PutEntry>();
  const writes = new Map<string, FlatWrite[]>();
  let latest: PutEntry | undefined;

  for (const e of events) {
    if (e.entityVersion <= cutoff) continue;
    if (e.name === EVT_PUT) {
      const data = e.data as unknown as PutEventData;
      if (data.checkpoint_ns !== ns) continue;
      const entry: PutEntry = { data, version: e.entityVersion };
      checkpoints.set(data.checkpoint_id, entry);
      // Lex-MAX of checkpoint_id matches MemorySaver / SqliteSaver /
      // PostgresSaver "latest" semantics (ORDER BY checkpoint_id DESC LIMIT 1).
      // LangGraph IDs are UUID v6, so lex order == time order.
      if (!latest || data.checkpoint_id > latest.data.checkpoint_id) {
        latest = entry;
      }
    } else if (e.name === EVT_PUT_WRITES) {
      const data = e.data as unknown as PutWritesEventData;
      if (data.checkpoint_ns !== ns) continue;
      const list = writes.get(data.checkpoint_id) ?? [];
      for (const w of data.writes) {
        list.push({
          checkpointId: data.checkpoint_id,
          taskId: data.task_id,
          channel: w.channel,
          idx: w.idx,
          type: w.type,
          value_b64: w.value_b64,
          version: e.entityVersion,
        });
      }
      writes.set(data.checkpoint_id, list);
    }
  }

  if (checkpoints.size === 0) return undefined;
  return { checkpoints, writes, latest };
}

function namespacesIn(events: StreamEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    if (e.name === EVT_PUT || e.name === EVT_PUT_WRITES) {
      const ns = (e.data as { checkpoint_ns?: string }).checkpoint_ns ?? "";
      set.add(ns);
    }
  }
  return [...set];
}

function matchesFilter(
  metadata: CheckpointMetadata | undefined,
  filter: Record<string, unknown>
): boolean {
  if (!metadata) return false;
  const m = metadata as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(filter)) {
    if (m[k] !== v) return false;
  }
  return true;
}
