import { beforeEach, describe, expect, it } from "vitest";
import type { AppendEventInput, AppendOptions, AppendResult, ReadStreamOptions, StreamEvent } from "@ironflow/core";
import type { IronflowClient } from "@ironflow/node";
import { IronflowSaver } from "../saver.js";

class FakeStream {
  public events: StreamEvent[] = [];
  public appendCalls: Array<{ entityId: string; input: AppendEventInput; options?: AppendOptions }> = [];
  private nextVersion = 0;
  private nextId = 1;

  constructor(private readonly idemKeys = new Set<string>()) {}

  append = async (entityId: string, input: AppendEventInput, options?: AppendOptions): Promise<AppendResult> => {
    this.appendCalls.push({ entityId, input, options });
    if (options?.idempotencyKey && this.idemKeys.has(options.idempotencyKey)) {
      const existing = this.events[this.events.length - 1]!;
      return { entityVersion: existing.entityVersion, eventId: existing.id, sequence: 0 };
    }
    if (options?.idempotencyKey) this.idemKeys.add(options.idempotencyKey);
    const event: StreamEvent = {
      id: `evt-${this.nextId++}`,
      name: input.name,
      data: input.data,
      entityVersion: this.nextVersion++,
      version: options?.version ?? 1,
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    return { entityVersion: event.entityVersion, eventId: event.id, sequence: 0 };
  };

  read = async (
    _entityId: string,
    options?: ReadStreamOptions
  ): Promise<{ events: StreamEvent[]; totalCount: number }> => {
    const fromVersion = options?.fromVersion ?? 0;
    const limit = options?.limit ?? 0;
    const filtered = this.events.filter((e) => e.entityVersion >= fromVersion);
    const sliced = limit > 0 ? filtered.slice(0, limit) : filtered;
    return { events: sliced, totalCount: this.events.length };
  };
}

function makeFakeClient(): { client: IronflowClient; stream: FakeStream } {
  const stream = new FakeStream();
  const client = { streams: stream } as unknown as IronflowClient;
  return { client, stream };
}

const cfg = (threadId: string, ns = "", checkpointId?: string) => ({
  configurable: { thread_id: threadId, checkpoint_ns: ns, ...(checkpointId ? { checkpoint_id: checkpointId } : {}) },
});

const fakeCheckpoint = (id: string, channelValues: Record<string, unknown> = {}) => ({
  v: 4,
  id,
  ts: new Date().toISOString(),
  channel_values: channelValues,
  channel_versions: {},
  versions_seen: {},
});

const fakeMetadata = (step: number) => ({
  source: "loop" as const,
  step,
  parents: {},
});

describe("IronflowSaver — put + getTuple", () => {
  let saver: IronflowSaver;
  let stream: FakeStream;

  beforeEach(() => {
    const { client, stream: s } = makeFakeClient();
    stream = s;
    saver = new IronflowSaver({ client });
  });

  it("put appends checkpoint event with stream id and idempotency key", async () => {
    const cp = fakeCheckpoint("cp-1", { foo: "bar" });
    await saver.put(cfg("thread-A"), cp, fakeMetadata(0), {});
    expect(stream.appendCalls).toHaveLength(1);
    expect(stream.appendCalls[0]!.entityId).toBe("irn:agent-ckpt:thread-A");
    expect(stream.appendCalls[0]!.input.name).toBe("checkpoint.put");
    expect(stream.appendCalls[0]!.input.entityType).toBe("agent-ckpt");
    expect(stream.appendCalls[0]!.options?.idempotencyKey).toBe("lg:put:thread-A::cp-1");
  });

  it("put returns canonical RunnableConfig with checkpoint_id", async () => {
    const cp = fakeCheckpoint("cp-1");
    const result = await saver.put(cfg("thread-A"), cp, fakeMetadata(0), {});
    expect(result).toEqual({
      configurable: { thread_id: "thread-A", checkpoint_ns: "", checkpoint_id: "cp-1" },
    });
  });

  it("getTuple returns latest checkpoint when no checkpoint_id given", async () => {
    await saver.put(cfg("thread-A"), fakeCheckpoint("cp-1", { x: 1 }), fakeMetadata(0), {});
    await saver.put(cfg("thread-A"), fakeCheckpoint("cp-2", { x: 2 }), fakeMetadata(1), {});

    const tuple = await saver.getTuple(cfg("thread-A"));
    expect(tuple).toBeDefined();
    expect(tuple!.checkpoint.id).toBe("cp-2");
    expect(tuple!.checkpoint.channel_values).toEqual({ x: 2 });
    expect(tuple!.metadata?.step).toBe(1);
  });

  it("getTuple returns specific checkpoint when checkpoint_id given", async () => {
    await saver.put(cfg("thread-A"), fakeCheckpoint("cp-1", { x: 1 }), fakeMetadata(0), {});
    await saver.put(cfg("thread-A"), fakeCheckpoint("cp-2", { x: 2 }), fakeMetadata(1), {});

    const tuple = await saver.getTuple(cfg("thread-A", "", "cp-1"));
    expect(tuple!.checkpoint.id).toBe("cp-1");
    expect(tuple!.checkpoint.channel_values).toEqual({ x: 1 });
  });

  it("getTuple preserves user-supplied config when looked up by checkpoint_id", async () => {
    await saver.put(cfg("thread-A"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    const userConfig = {
      configurable: {
        thread_id: "thread-A",
        checkpoint_ns: "",
        checkpoint_id: "cp-1",
        custom_field: "preserved",
      },
    };
    const tuple = await saver.getTuple(userConfig);
    expect(tuple!.config).toBe(userConfig);
  });

  it("getTuple returns canonical config when returning latest", async () => {
    await saver.put(cfg("thread-A"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    const tuple = await saver.getTuple(cfg("thread-A"));
    expect(tuple!.config).toEqual({
      configurable: { thread_id: "thread-A", checkpoint_ns: "", checkpoint_id: "cp-1" },
    });
  });

  it("getTuple returns undefined for unknown thread", async () => {
    const tuple = await saver.getTuple(cfg("nope"));
    expect(tuple).toBeUndefined();
  });

  it("getTuple includes parentConfig when checkpoint has parent", async () => {
    await saver.put(cfg("t1"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    await saver.put(cfg("t1", "", "cp-1"), fakeCheckpoint("cp-2"), fakeMetadata(1), {});

    const tuple = await saver.getTuple(cfg("t1", "", "cp-2"));
    expect(tuple!.parentConfig).toEqual({
      configurable: { thread_id: "t1", checkpoint_ns: "", checkpoint_id: "cp-1" },
    });
  });

  it("put throws when thread_id missing", async () => {
    await expect(saver.put({} as never, fakeCheckpoint("cp-1"), fakeMetadata(0), {})).rejects.toMatchObject({
      code: "LG_THREAD_ID_REQUIRED",
    });
  });
});

describe("IronflowSaver — putWrites", () => {
  let saver: IronflowSaver;
  let stream: FakeStream;

  beforeEach(() => {
    const { client, stream: s } = makeFakeClient();
    stream = s;
    saver = new IronflowSaver({ client });
  });

  it("appends putWrites event without idempotency key (read-time dedup handles replay)", async () => {
    await saver.putWrites(
      cfg("t1", "", "cp-1"),
      [["channel-a", "v1"], ["channel-b", "v2"]],
      "task-X"
    );
    expect(stream.appendCalls).toHaveLength(1);
    expect(stream.appendCalls[0]!.input.name).toBe("checkpoint.putWrites");
    expect(stream.appendCalls[0]!.options?.idempotencyKey).toBeUndefined();
  });

  it("read-time dedup collapses replayed putWrites events to single set", async () => {
    await saver.put(cfg("t1"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    // Simulate a replay: same content appended twice (no idempotency key
    // guards the event-level append, so both events land on the stream).
    await saver.putWrites(cfg("t1", "", "cp-1"), [["chan-a", "v1"], ["chan-b", "v2"]], "task-1");
    await saver.putWrites(cfg("t1", "", "cp-1"), [["chan-a", "v1"], ["chan-b", "v2"]], "task-1");
    const tuple = await saver.getTuple(cfg("t1", "", "cp-1"));
    expect(tuple!.pendingWrites?.length).toBe(2);
    expect(tuple!.pendingWrites).toEqual([
      ["task-1", "chan-a", "v1"],
      ["task-1", "chan-b", "v2"],
    ]);
  });

  it("getTuple includes pendingWrites for matching checkpoint", async () => {
    await saver.put(cfg("t1"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    await saver.putWrites(
      cfg("t1", "", "cp-1"),
      [["chan", "value-1"]],
      "task-1"
    );
    const tuple = await saver.getTuple(cfg("t1", "", "cp-1"));
    expect(tuple!.pendingWrites).toEqual([["task-1", "chan", "value-1"]]);
  });

  it("dedupes intra-batch writes by (taskId, idx)", async () => {
    await saver.put(cfg("t1"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    await saver.putWrites(
      cfg("t1", "", "cp-1"),
      [
        ["a", "v1"],
        ["a", "v2"],
      ],
      "task-1"
    );
    const tuple = await saver.getTuple(cfg("t1", "", "cp-1"));
    expect(tuple!.pendingWrites?.length).toBe(2);
    expect(tuple!.pendingWrites?.[0]?.[2]).toBe("v1");
    expect(tuple!.pendingWrites?.[1]?.[2]).toBe("v2");
  });

  it("throws when checkpoint_id missing", async () => {
    await expect(saver.putWrites(cfg("t1"), [["a", "v"]], "task-1")).rejects.toMatchObject({
      code: "LG_CHECKPOINT_ID_REQUIRED",
    });
  });

  it("does not append when writes is empty", async () => {
    await saver.putWrites(cfg("t1", "", "cp-1"), [], "task-1");
    expect(stream.appendCalls).toHaveLength(0);
  });
});

describe("IronflowSaver — list", () => {
  let saver: IronflowSaver;

  beforeEach(() => {
    const { client } = makeFakeClient();
    saver = new IronflowSaver({ client });
  });

  it("yields checkpoints newest-first by stream version", async () => {
    await saver.put(cfg("t1"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    await saver.put(cfg("t1"), fakeCheckpoint("cp-2"), fakeMetadata(1), {});
    await saver.put(cfg("t1"), fakeCheckpoint("cp-3"), fakeMetadata(2), {});

    const ids: string[] = [];
    for await (const t of saver.list(cfg("t1"))) ids.push(t.checkpoint.id);
    expect(ids).toEqual(["cp-3", "cp-2", "cp-1"]);
  });

  it("respects limit option", async () => {
    await saver.put(cfg("t1"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    await saver.put(cfg("t1"), fakeCheckpoint("cp-2"), fakeMetadata(1), {});
    await saver.put(cfg("t1"), fakeCheckpoint("cp-3"), fakeMetadata(2), {});

    const ids: string[] = [];
    for await (const t of saver.list(cfg("t1"), { limit: 2 })) ids.push(t.checkpoint.id);
    expect(ids).toEqual(["cp-3", "cp-2"]);
  });

  it("respects before option (exclusive)", async () => {
    await saver.put(cfg("t1"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    await saver.put(cfg("t1"), fakeCheckpoint("cp-2"), fakeMetadata(1), {});
    await saver.put(cfg("t1"), fakeCheckpoint("cp-3"), fakeMetadata(2), {});

    const ids: string[] = [];
    const before = { configurable: { checkpoint_id: "cp-3" } };
    for await (const t of saver.list(cfg("t1"), { before })) ids.push(t.checkpoint.id);
    expect(ids).toEqual(["cp-2", "cp-1"]);
  });

  it("filters by metadata fields", async () => {
    await saver.put(cfg("t1"), fakeCheckpoint("cp-1"), { source: "loop", step: 0, parents: {} }, {});
    await saver.put(cfg("t1"), fakeCheckpoint("cp-2"), { source: "input", step: -1, parents: {} }, {});
    await saver.put(cfg("t1"), fakeCheckpoint("cp-3"), { source: "loop", step: 1, parents: {} }, {});

    const ids: string[] = [];
    for await (const t of saver.list(cfg("t1"), { filter: { source: "loop" } })) {
      ids.push(t.checkpoint.id);
    }
    expect(ids).toEqual(["cp-3", "cp-1"]);
  });

  it("requires thread_id", async () => {
    await expect(async () => {
      for await (const _ of saver.list({ configurable: {} } as never)) void _;
    }).rejects.toMatchObject({ code: "LG_THREAD_ID_REQUIRED" });
  });
});

describe("IronflowSaver — deleteThread", () => {
  let saver: IronflowSaver;
  let stream: FakeStream;

  beforeEach(() => {
    const { client, stream: s } = makeFakeClient();
    stream = s;
    saver = new IronflowSaver({ client });
  });

  it("appends tombstone; subsequent reads ignore prior events", async () => {
    await saver.put(cfg("t1"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    await saver.deleteThread("t1");

    const tuple = await saver.getTuple(cfg("t1"));
    expect(tuple).toBeUndefined();
  });

  it("reads see only events appended after tombstone", async () => {
    await saver.put(cfg("t1"), fakeCheckpoint("cp-1"), fakeMetadata(0), {});
    await saver.deleteThread("t1");
    await saver.put(cfg("t1"), fakeCheckpoint("cp-2"), fakeMetadata(0), {});

    const tuple = await saver.getTuple(cfg("t1"));
    expect(tuple!.checkpoint.id).toBe("cp-2");
  });

  it("delete writes to correct stream id", async () => {
    await saver.deleteThread("t-7");
    expect(stream.appendCalls[0]!.entityId).toBe("irn:agent-ckpt:t-7");
    expect(stream.appendCalls[0]!.input.name).toBe("checkpoint.deleteThread");
  });
});

describe("IronflowSaver — namespaces", () => {
  let saver: IronflowSaver;

  beforeEach(() => {
    const { client } = makeFakeClient();
    saver = new IronflowSaver({ client });
  });

  it("isolates checkpoints across namespaces in same thread", async () => {
    await saver.put(cfg("t1", "ns-A"), fakeCheckpoint("cp-1", { ns: "A" }), fakeMetadata(0), {});
    await saver.put(cfg("t1", "ns-B"), fakeCheckpoint("cp-2", { ns: "B" }), fakeMetadata(0), {});

    const a = await saver.getTuple(cfg("t1", "ns-A"));
    const b = await saver.getTuple(cfg("t1", "ns-B"));
    expect(a!.checkpoint.channel_values).toEqual({ ns: "A" });
    expect(b!.checkpoint.channel_values).toEqual({ ns: "B" });
  });
});

describe("IronflowSaver — serde round-trip", () => {
  it("preserves nested objects, arrays, and primitives in channel_values", async () => {
    const { client } = makeFakeClient();
    const saver = new IronflowSaver({ client });
    const channels = {
      str: "hello",
      num: 42,
      bool: true,
      nested: { a: [1, 2, 3], b: { deep: "value" } },
      empty_obj: {},
      empty_arr: [],
    };

    await saver.put(cfg("t1"), fakeCheckpoint("cp-1", channels), fakeMetadata(0), {});
    const tuple = await saver.getTuple(cfg("t1"));
    expect(tuple!.checkpoint.channel_values).toEqual(channels);
  });
});
