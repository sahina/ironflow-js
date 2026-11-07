import { afterEach, describe, expect, it, vi } from "vitest";
import { IronflowClient } from "./client.js";
type SubscribeCallbacks = Parameters<IronflowClient["subscribe"]>[1];

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function configured() {
  const client = new IronflowClient();
  client.configure({ serverUrl: "http://localhost:9123", logger: false });
  return client;
}

describe("projection and event reads (#3390)", () => {
  it.each(["apikey:k1", undefined])("exposes stored and stream emitter %s", async (emitter) => {
    const client = configured();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("ReadStream")
      ? { events: [{ id: "e", emittedBy: emitter, timestamp: "2026-01-01T00:00:00Z" }] }
      : { id: "e", emitted_by: emitter, timestamp: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" })));
    expect(await client.getEvent("e")).toHaveProperty("emittedBy", emitter);
    expect((await client.streams.read("seat-1")).events[0]).toHaveProperty("emittedBy", emitter);
    client._resetForTesting();
  });

  it("passes partition/cursor and forwards repeated updates without fetching an initial snapshot", async () => {
    const client = configured();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let callbacks: SubscribeCallbacks | undefined;
    const subscribe = vi.spyOn(client, "subscribe").mockImplementation(async (_pattern, cbs) => {
      callbacks = cbs;
      return { unsubscribe: vi.fn() } as never;
    });
    const onUpdate = vi.fn();
    await client.subscribeToProjection("board", { onUpdate }, { replay: 1 });
    expect(subscribe).toHaveBeenCalledWith("system.projection.board.>", expect.objectContaining({ replay: 1 }));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const frame = { data: { state: { seats: 1 }, partition: "room-1", last_event_id: "e", last_event_seq: 42 } };
    callbacks?.onEvent?.(frame as never);
    callbacks?.onEvent?.(frame as never);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith({ seats: 1 }, expect.objectContaining({ id: "e", partition: "room-1", lastEventSeq: 42 }));
    client._resetForTesting();
  });

  it("returns empty state before the worker has saved a projection", async () => {
    const client = configured();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ name: "board", lastEventSeq: "0", registry: { name: "board", updatedAt: "2026-09-06T12:00:00Z" } })));
    expect(await client.getProjection("board", { partition: "room-1" })).toMatchObject({ state: {}, partition: "room-1" });
    client._resetForTesting();
  });

  it("refreshes again when an update races the documented initial snapshot recipe", async () => {
    vi.useFakeTimers();
    const client = configured();
    let onEvent: SubscribeCallbacks["onEvent"];
    vi.spyOn(client, "subscribe").mockImplementation(async (_pattern, callbacks) => {
      onEvent = callbacks.onEvent;
      return { unsubscribe: vi.fn() } as never;
    });
    let finishRead: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishRead = resolve; }))
      .mockResolvedValueOnce(Response.json({ name: "board", state: { count: 2 }, registry: { name: "board", updatedAt: "2026-09-06T12:00:00Z" } }))
      .mockImplementation(async () => Response.json({ name: "board", state: { count: 3 }, registry: { name: "board", updatedAt: "2026-09-06T12:00:00Z" } }));
    vi.stubGlobal("fetch", fetchMock);
    const rendered: unknown[] = [];
    let dirty = false;
    let refreshing = false;
    let disposed = false;
    async function refresh() {
      if (disposed) return;
      dirty = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (dirty && !disposed) {
          dirty = false;
          const snapshot = await client.getProjection("board", { partition: "room-1" });
          if (!disposed) rendered.push(snapshot.state);
        }
      } finally {
        refreshing = false;
      }
    }
    await client.subscribeToProjection("board", { onUpdate: () => { void refresh(); } }, { partition: "room-1" });
    const timer = setInterval(() => { void refresh(); }, 5000);
    const initial = refresh();
    onEvent?.({ data: { state: { count: 2 }, partition: "room-1", last_event_seq: 2 } } as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishRead?.(Response.json({ name: "board", state: { count: 1 }, registry: { name: "board", updatedAt: "2026-09-06T12:00:00Z" } }));
    await initial;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rendered).toEqual([{ count: 1 }, { count: 2 }]);
    // No frame arrives for count=3 (e.g. it was saved before live attach).
    await vi.advanceTimersByTimeAsync(5000);
    expect(rendered.at(-1)).toEqual({ count: 3 });
    disposed = true;
    clearInterval(timer);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    client._resetForTesting();
  });

});
