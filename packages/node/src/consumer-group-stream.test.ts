import { afterEach, describe, expect, it, vi } from "vitest";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { IronflowError } from "@ironflow/core";
import {
  AckMode,
  AckResultCode,
  AckResultSchema,
  ConsumerGroupJoinedSchema,
  PubSubService,
  SubscribeBidirectionalRequestSchema,
  SubscribeBidirectionalResponseSchema,
  SubscriptionEventSchema,
  type SubscribeBidirectionalRequest,
  type SubscribeBidirectionalResponse,
  type SubscriptionAck,
} from "@ironflow/core/gen";
import {
  AckError,
  StaleAckError,
  SubscriptionClosedError,
  joinConsumerGroupStream,
  type ConsumerGroupStreamCallbacks,
  type ConsumerGroupStreamConfig,
} from "./consumer-group-stream.js";
import { deliveryMaxAge } from "./consumer-group-stream-conn.js";

// Node twins of sdk/go/ironflow/consumer_group_stream_test.go. An in-process h2c
// server plays PubSubService.SubscribeBidirectional from a per-stream script.

class Channel<T> {
  private items: T[] = [];
  private waiter?: () => void;
  push(item: T) {
    this.items.push(item);
    this.waiter?.();
  }
  async next(): Promise<T> {
    while (this.items.length === 0) await new Promise<void>((r) => (this.waiter = r));
    return this.items.shift()!;
  }
}

type Out =
  | { kind: "send"; resp: SubscribeBidirectionalResponse; written: () => void }
  | { kind: "fail"; err: ConnectError }
  | { kind: "end" };

/** The server side of one stream. */
class FakeStream {
  private out = new Channel<Out>();
  private reqs?: AsyncIterator<SubscribeBidirectionalRequest>;
  /** How the client ended the stream, once it did. */
  closedBy?: "halfclose" | "reset";
  /** Acks seen by recv(). */
  acks: SubscriptionAck[] = [];
  readonly closed: Promise<void>;
  private markClosed!: () => void;

  constructor(
    readonly n: number,
    requests: AsyncIterable<SubscribeBidirectionalRequest>,
    private readonly ctx: HandlerContext,
  ) {
    this.closed = new Promise((r) => (this.markClosed = r));
    ctx.signal.addEventListener("abort", () => {
      this.closedBy ??= "reset";
      this.markClosed();
      this.out.push({ kind: "end" });
    });
    this.reqs = requests[Symbol.asyncIterator]();
  }

  /** Next client frame; undefined once the client half-closed or reset. */
  async recv(): Promise<SubscribeBidirectionalRequest | undefined> {
    try {
      const r = await this.reqs!.next();
      if (r.done) {
        // A reset can end the request iterator before ctx.signal aborts; let the
        // abort land before calling this a clean half-close.
        await new Promise((r) => setTimeout(r, 20));
        this.closedBy ??= this.ctx.signal.aborted ? "reset" : "halfclose";
        this.markClosed();
        return undefined;
      }
      if (r.value.payload.case === "ack") this.acks.push(r.value.payload.value);
      return r.value;
    } catch {
      this.closedBy ??= "reset";
      this.markClosed();
      return undefined;
    }
  }

  /** Reads frames until a join arrives, then answers joined. */
  async join(subscriptionId: string, mode = AckMode.MANUAL) {
    const req = await this.recv();
    expect(req?.payload.case).toBe("join");
    await this.send({
      case: "joined",
      value: create(ConsumerGroupJoinedSchema, {
        subscriptionId,
        groupName: "workers",
        pattern: "topic:orders",
        ackMode: mode,
      }),
    });
  }

  /** Resolves once the frame is written, or the stream is gone. */
  send(payload: SubscribeBidirectionalResponse["payload"]): Promise<void> {
    const written = new Promise<void>((done) =>
      this.out.push({ kind: "send", resp: create(SubscribeBidirectionalResponseSchema, { payload }), written: done }),
    );
    return Promise.race([written, this.closed]);
  }

  event(subscriptionId: string, eventId: string, data: Record<string, string> = {}) {
    return this.send({
      case: "event",
      value: create(SubscriptionEventSchema, { subscriptionId, eventId, topic: "orders", data }),
    });
  }

  result(ackId: bigint, eventId: string, code = AckResultCode.OK, message = "") {
    return this.send({ case: "ackResult", value: create(AckResultSchema, { ackId, eventId, code, message }) });
  }

  /** Answers every ack OK until the client leaves. */
  async serveAcks() {
    for (let r = await this.recv(); r; r = await this.recv()) {
      if (r.payload.case === "ack") {
        await this.result(r.payload.value.ackId, r.payload.value.eventId);
      }
    }
  }

  end() {
    this.out.push({ kind: "end" });
  }
  fail(code: Code, message = "boom") {
    this.out.push({ kind: "fail", err: new ConnectError(message, code) });
  }

  /** Drains the script's output into the handler's response stream. */
  async *drain(): AsyncGenerator<SubscribeBidirectionalResponse> {
    for (;;) {
      const o = await this.out.next();
      if (o.kind === "fail") throw o.err;
      if (o.kind === "end") return;
      yield o.resp;
      o.written();
    }
  }
}

type Script = (s: FakeStream) => Promise<void> | void;

interface Fake {
  url: string;
  streams: FakeStream[];
}

const stops: (() => Promise<void>)[] = [];
const subs: { unsubscribe(): void }[] = [];

afterEach(async () => {
  for (const s of subs.splice(0)) s.unsubscribe();
  for (const stop of stops.splice(0)) await stop();
});

async function startFake(script: Script): Promise<Fake> {
  const streams: FakeStream[] = [];
  const handler = connectNodeAdapter({
    routes(router) {
      router.service(PubSubService as never, {
        async *subscribeBidirectional(
          requests: AsyncIterable<SubscribeBidirectionalRequest>,
          ctx: HandlerContext,
        ) {
          const s = new FakeStream(streams.length + 1, requests, ctx);
          streams.push(s);
          void Promise.resolve(script(s)).catch(() => {});
          yield* s.drain();
        },
      } as never);
    },
  });
  const server = http2.createServer(handler);
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (sess) => {
    sessions.add(sess);
    sess.on("close", () => sessions.delete(sess));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stops.push(
    () =>
      new Promise<void>((r) => {
        for (const s of sessions) s.destroy();
        server.close(() => r());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, streams };
}

const cfg = (fake: Fake, extra: Partial<ConsumerGroupStreamConfig> = {}): ConsumerGroupStreamConfig => ({
  serverUrl: fake.url,
  apiKey: "ifkey_test",
  reconnectDelay: 20,
  logger: false,
  ...extra,
});

async function join<T = unknown>(
  fake: Fake,
  callbacks: ConsumerGroupStreamCallbacks<T> = {},
  extra: Partial<ConsumerGroupStreamConfig> = {},
) {
  const sub = await joinConsumerGroupStream<T>(cfg(fake, extra), "workers", callbacks);
  subs.push(sub);
  return sub;
}

/** Joins and resolves with the first event's ID. */
async function joinForFirstEvent(fake: Fake, extra: Partial<ConsumerGroupStreamConfig> = {}) {
  let first!: (id: string) => void;
  const got = new Promise<string>((r) => (first = r));
  const sub = await join(fake, { onEvent: (e) => first(e.eventId!) }, extra);
  return { sub, eventId: await got };
}

/** Rejection of a promise, as a value, so a test can assert on its type. */
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );

describe("consumer-group stream", () => {
  it("ack resolves on its result", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      await s.event("member-1", "evt-1");
      await s.serveAcks();
    });
    const { sub, eventId } = await joinForFirstEvent(fake);
    await expect(sub.ack(eventId)).resolves.toBeUndefined();
    expect(fake.streams[0]!.acks).toHaveLength(1);
    expect(fake.streams[0]!.acks[0]).toMatchObject({ eventId: "evt-1", ackType: 1 });
  });

  it("non-OK result rejects with AckError carrying code", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      await s.event("member-1", "evt-1");
      const r = await s.recv();
      if (r?.payload.case === "ack") {
        await s.result(r.payload.value.ackId, "evt-1", AckResultCode.INVALID_ARGUMENT, "bad delay");
      }
      await s.recv();
    });
    const { sub, eventId } = await joinForFirstEvent(fake);
    const err = await rejection(sub.ack(eventId));
    expect(err).toBeInstanceOf(AckError);
    expect(err).toBeInstanceOf(IronflowError);
    expect(err).toMatchObject({ eventId: "evt-1", code: "invalid_argument" });
    expect((err as Error).message).toContain("bad delay");
  });

  it("NOT_FOUND result rejects with AckError code not_found", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      await s.event("member-1", "evt-1");
      const r = await s.recv();
      if (r?.payload.case === "ack") {
        await s.result(r.payload.value.ackId, "evt-1", AckResultCode.NOT_FOUND, "member gone");
      }
      await s.recv();
    });
    const { sub, eventId } = await joinForFirstEvent(fake);
    expect(await rejection(sub.ack(eventId))).toMatchObject({ code: "not_found" });
  });

  it("results correlate by ackId", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      await s.event("member-1", "evt-1");
      await s.event("member-1", "evt-2");
      // Answer the second ack first, and fail it, to prove the match is by ack_id.
      const a = await s.recv();
      const b = await s.recv();
      if (a?.payload.case === "ack" && b?.payload.case === "ack") {
        await s.result(b.payload.value.ackId, "evt-2", AckResultCode.INTERNAL, "second");
        await s.result(a.payload.value.ackId, "evt-1");
      }
      await s.recv();
    });
    const seen: string[] = [];
    const sub = await join(fake, { onEvent: (e) => void seen.push(e.eventId!) });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    const first = sub.ack("evt-1");
    const second = sub.ack("evt-2");
    expect(await rejection(second)).toMatchObject({ eventId: "evt-2", code: "internal" });
    await expect(first).resolves.toBeUndefined();
  });

  it("nak sends the delay; its redelivery takes the ack", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      await s.event("member-1", "evt-1");
      const r = await s.recv();
      if (r?.payload.case === "ack") await s.result(r.payload.value.ackId, "evt-1");
      await s.event("member-1", "evt-1"); // the redelivery
      await s.serveAcks();
    });
    let copies = 0;
    let second!: () => void;
    const redelivered = new Promise<void>((r) => (second = r));
    const sub = await join(fake, { onEvent: () => void (++copies === 2 && second()) });
    await vi.waitFor(() => expect(copies).toBe(1));
    await sub.nak("evt-1", 1500.4); // rounded for the int32 field
    await redelivered;
    await sub.ack("evt-1");
    const [nak, ack] = fake.streams[0]!.acks;
    expect(nak).toMatchObject({ ackType: 2, redeliverDelayMs: 1500 });
    expect(ack).toMatchObject({ ackType: 1 });
  });

  it("nak with a delay outside int32 rejects without sending or ending the stream", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      await s.event("member-1", "evt-1");
      await s.serveAcks();
    });
    const { sub, eventId } = await joinForFirstEvent(fake);
    for (const bad of [Number.NaN, -1, 2 ** 31, Number.POSITIVE_INFINITY]) {
      const err = await rejection(sub.nak(eventId, bad));
      expect(err).toBeInstanceOf(AckError);
      expect(err).toMatchObject({ code: "invalid_argument" });
    }
    await sub.ack(eventId);
    expect(fake.streams).toHaveLength(1);
    expect(fake.streams[0]!.acks).toHaveLength(1);
  });

  it("every copy of an event takes its own ack, and settled copies leave the set", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      for (const id of ["evt-1", "evt-2", "evt-2"]) await s.event("member-1", id);
      await s.serveAcks();
    });
    let seen = 0;
    const sub = await join(fake, { onEvent: () => void seen++ });
    await vi.waitFor(() => expect(seen).toBe(3));
    await sub.nak("evt-1"); // redelivered to another member: never comes back here
    await sub.ack("evt-2");
    await sub.ack("evt-2");
    const conn = (sub as unknown as { cur: { deliveredCount: number } }).cur;
    expect(conn.deliveredCount).toBe(0);
    const err = await rejection(sub.ack("evt-2"));
    expect(err).toBeInstanceOf(StaleAckError);
    expect((err as Error).message).toContain("settled already");
  });

  it("unsettled entries are pruned after deliveryMaxAge", async () => {
    const old = deliveryMaxAge.ms;
    deliveryMaxAge.ms = 100;
    try {
      let next!: () => void;
      const go = new Promise<void>((r) => (next = r));
      const fake = await startFake(async (s) => {
        await s.join("member-1");
        await s.event("member-1", "evt-1");
        await s.event("member-1", "evt-2");
        await go;
        await s.event("member-1", "evt-3");
        for (let r = await s.recv(); r; r = await s.recv());
      });
      let seen = 0;
      const sub = await join(fake, { onEvent: () => void seen++ });
      await vi.waitFor(() => expect(seen).toBe(2));
      await new Promise((r) => setTimeout(r, 150));
      next();
      await vi.waitFor(() => expect(seen).toBe(3));
      expect((sub as unknown as { cur: { deliveredCount: number } }).cur.deliveredCount).toBe(1);
    } finally {
      deliveryMaxAge.ms = old;
    }
  });

  it("a silent stream reconnects after idleTimeoutMs", async () => {
    const fake = await startFake(async (s) => {
      await s.join(`member-${s.n}`);
      for (let r = await s.recv(); r; r = await s.recv()); // no frame, no end
    });
    const errors: unknown[] = [];
    await join(fake, { onError: (e) => void errors.push(e) }, { idleTimeoutMs: 200 });
    await vi.waitFor(() => expect(fake.streams.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    expect(errors).toEqual([]);
  });

  it("pending acks reject with StaleAckError on stream end", async () => {
    const fake = await startFake(
      async (s) => {
        await s.join("member-1");
        await s.event("member-1", "evt-1");
        await s.recv(); // the ack, never answered
        s.end();
      },
    );
    const { sub, eventId } = await joinForFirstEvent(fake, { reconnectDelay: 5000 });
    const err = await rejection(sub.ack(eventId));
    expect(err).toBeInstanceOf(StaleAckError);
    expect((err as Error).message).toContain("the stream reconnected; the event will be redelivered");
  });

  it("stale ack after reconnect rejects with StaleAckError and is not sent", async () => {
    const fake = await startFake(async (s) => {
      if (s.n === 1) {
        await s.join("member-1");
        await s.event("member-1", "evt-1");
        s.fail(Code.Unavailable, "dropped");
        return;
      }
      await s.join("member-2");
      for (let r = await s.recv(); r; r = await s.recv());
    });
    const { sub, eventId } = await joinForFirstEvent(fake);
    await vi.waitFor(() => expect(fake.streams).toHaveLength(2));
    await vi.waitFor(() => expect(sub.id).toBe("member-2"));
    expect(await rejection(sub.ack(eventId))).toBeInstanceOf(StaleAckError);
    expect(await rejection(sub.ack("never-delivered"))).toBeInstanceOf(StaleAckError);
    expect(fake.streams[1]!.acks).toHaveLength(0);
  });

  it.each([Code.NotFound, Code.InvalidArgument, Code.Unauthenticated, Code.PermissionDenied])(
    "join failing with code %s rejects and does not retry",
    async (code) => {
      const fake = await startFake(async (s) => {
        await s.recv();
        s.fail(code, "nope");
      });
      const err = await rejection(joinConsumerGroupStream(cfg(fake), "workers", {}));
      expect(ConnectError.from(err).code).toBe(code);
      await new Promise((r) => setTimeout(r, 120)); // several base delays
      expect(fake.streams).toHaveLength(1);
    },
  );

  it("AUTO group tracks no delivered ids and sends nothing for an ack", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1", AckMode.AUTO);
      await s.event("member-1", "evt-1");
      for (let r = await s.recv(); r; r = await s.recv());
    });
    const { sub } = await joinForFirstEvent(fake);
    await expect(sub.ack("whatever")).resolves.toBeUndefined();
    await expect(sub.nak("whatever", 1000)).resolves.toBeUndefined();
    await expect(sub.term("whatever")).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.streams[0]!.acks).toHaveLength(0);
  });

  it("unsubscribe half-closes", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      await s.recv();
    });
    const sub = await join(fake);
    sub.unsubscribe();
    await Promise.race([
      fake.streams[0]!.closed,
      new Promise((_, rej) => setTimeout(() => rej(new Error("server never saw the end")), 1000)),
    ]);
    expect(fake.streams[0]!.closedBy).toBe("halfclose");
  });

  it("unsubscribe tears down an idle stream", async () => {
    // Idle: no frames flow after joined. A client that only cancelled a pending
    // read would leave this stream open (the Go client did).
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      await s.event("member-1", "evt-1");
      await s.serveAcks();
    });
    const { sub, eventId } = await joinForFirstEvent(fake);
    // A full ack round trip proves the request body is flushed and now idle.
    await sub.ack(eventId);
    sub.unsubscribe();
    await Promise.race([
      fake.streams[0]!.closed,
      new Promise((_, rej) => setTimeout(() => rej(new Error("stream still open 1s after unsubscribe")), 1000)),
    ]);
  });

  it("unsubscribe resets a stream whose server ignores the half-close", async () => {
    // The server reads only the join and never reads again: the half-close goes
    // unseen, so only a reset can end the stream.
    const fake = await startFake(async (s) => {
      await s.join("member-1");
    });
    const sub = await join(fake);
    sub.unsubscribe();
    await Promise.race([
      fake.streams[0]!.closed,
      new Promise((_, rej) => setTimeout(() => rej(new Error("stream never reset")), 4000)),
    ]);
    expect(fake.streams[0]!.closedBy).toBe("reset");
  }, 8000);

  it("NotFound on rejoin is terminal", async () => {
    const fake = await startFake(async (s) => {
      if (s.n === 1) {
        await s.join("member-1");
        await s.event("member-1", "evt-1");
        s.end(); // the group was deleted: a clean end
        return;
      }
      await s.recv();
      s.fail(Code.NotFound, "group not found");
    });
    const errors: { code: string; retrying?: boolean }[] = [];
    let first!: (id: string) => void;
    const got = new Promise<string>((r) => (first = r));
    const sub = await join(fake, { onEvent: (e) => first(e.eventId!), onError: (e) => errors.push(e) });
    const eventId = await got;
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ code: "NOT_FOUND" });
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.streams).toHaveLength(2); // no third attempt
    expect(await rejection(sub.ack(eventId))).toBeInstanceOf(SubscriptionClosedError);
  });

  it("Unimplemented on rejoin names the minimum server version", async () => {
    const fake = await startFake(async (s) => {
      if (s.n === 1) {
        await s.join("member-1");
        s.end();
        return;
      }
      await s.recv();
      s.fail(Code.Unimplemented, "no such method");
    });
    const errors: { code: string; message: string }[] = [];
    await join(fake, { onError: (e) => errors.push(e) });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.message).toContain("0.48.0");
  });

  it("ack after unsubscribe rejects with SubscriptionClosedError", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      await s.event("member-1", "evt-1");
      await s.serveAcks();
    });
    const { sub, eventId } = await joinForFirstEvent(fake);
    sub.unsubscribe();
    const err = await rejection(sub.ack(eventId));
    expect(err).toBeInstanceOf(SubscriptionClosedError);
    expect(err).toBeInstanceOf(IronflowError);
    expect(await rejection(sub.nak(eventId))).toBeInstanceOf(SubscriptionClosedError);
    expect(await rejection(sub.term(eventId))).toBeInstanceOf(SubscriptionClosedError);
  });

  it("manual ack from inside onEvent does not deadlock", async () => {
    // 300 x 8 KB is far more than one HTTP/2 window. The server holds every
    // result until all events are sent, so a reader parked in the handler would
    // stop draining the socket and stall the server before it reads an ack.
    const total = 300;
    const payload = randomBytes(6000).toString("base64");
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      for (let i = 0; i < total; i++) await s.event("member-1", `evt-${i}`, { p: payload });
      await s.serveAcks();
    });
    const acked: string[] = [];
    let ready!: (s: Awaited<ReturnType<typeof join>>) => void;
    const subReady = new Promise<Awaited<ReturnType<typeof join>>>((r) => (ready = r));
    ready(
      await join(fake, {
        onEvent: async (e) => {
          await (await subReady).ack(e.eventId!);
          acked.push(e.eventId!);
        },
      }),
    );
    await vi.waitFor(() => expect(acked).toHaveLength(total), { timeout: 8000 });
    expect(acked[0]).toBe("evt-0");
    expect(acked[total - 1]).toBe(`evt-${total - 1}`);
  }, 12000);

  it("a throwing onEvent goes to onError and the event is not acked", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      await s.event("member-1", "evt-1");
      await s.event("member-1", "evt-2");
      await s.serveAcks();
    });
    const errors: { message: string }[] = [];
    const seen: string[] = [];
    await join(fake, {
      onEvent: async (e) => {
        seen.push(e.eventId!);
        if (e.eventId === "evt-1") throw new Error("handler broke");
      },
      onError: (e) => errors.push(e),
    });
    await vi.waitFor(() => expect(seen).toEqual(["evt-1", "evt-2"])); // the pump kept going
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("handler broke");
    expect(fake.streams[0]!.acks).toHaveLength(0);
  });

  it("onEvent is awaited: events are handled one at a time, in order", async () => {
    const fake = await startFake(async (s) => {
      await s.join("member-1");
      for (let i = 0; i < 5; i++) await s.event("member-1", `evt-${i}`);
      for (let r = await s.recv(); r; r = await s.recv());
    });
    let running = 0;
    let overlap = false;
    const seen: string[] = [];
    await join(fake, {
      onEvent: async (e) => {
        if (++running > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 5));
        seen.push(e.eventId!);
        running--;
      },
    });
    await vi.waitFor(() => expect(seen).toHaveLength(5));
    expect(overlap).toBe(false);
    expect(seen).toEqual(["evt-0", "evt-1", "evt-2", "evt-3", "evt-4"]);
  });

  it("auto group backpressures and ack is a no-op", async () => {
    const total = 60;
    let sent = 0;
    const raw = randomBytes(192 << 10).toString("base64"); // incompressible, 256 KB
    const fake = await startFake(async (s) => {
      await s.join("member-1", AckMode.AUTO);
      void (async () => {
        for (let r = await s.recv(); r; r = await s.recv());
      })();
      for (let i = 0; i < total; i++) {
        await s.event("member-1", `evt-${i}`, { p: raw });
        sent++;
      }
    });
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const sub = await join(
      fake,
      {
        onEvent: async (e) => {
          await gate; // a slow handler: nothing is read until it settles
          seen.push(e.eventId!);
        },
      },
      { logger },
    );

    // The handler holds the reader, so HTTP/2 flow control must stop the server
    // well short of total.
    let last = -1;
    await vi.waitFor(
      () => {
        const stable = sent === last;
        last = sent;
        expect(stable).toBe(true);
      },
      { interval: 150, timeout: 5000 },
    );
    expect(sent).toBeLessThan(total);

    await expect(sub.ack("evt-0")).resolves.toBeUndefined();
    await expect(sub.nak("evt-0", 1000)).resolves.toBeUndefined();
    expect(fake.streams[0]!.acks).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1); // once per subscription

    release();
    await vi.waitFor(() => expect(seen).toHaveLength(total), { timeout: 10000 });
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => `evt-${i}`)); // nothing lost
  }, 20000);

  // A raw h2 server that writes joined and the first event in ONE chunk, so the
  // client holds the event the moment joined resolves. The scripted fake cannot
  // promise that: it writes each frame on its own.
  async function startRawJoinedWithEvent(mode: AckMode): Promise<Fake & { acks: SubscriptionAck[] }> {
    const acks: SubscriptionAck[] = [];
    const frame = (resp: SubscribeBidirectionalResponse) => {
      const body = toBinary(SubscribeBidirectionalResponseSchema, resp);
      const head = Buffer.alloc(5);
      head.writeUInt32BE(body.length, 1);
      return Buffer.concat([head, body]);
    };
    const server = http2.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/connect+proto" });
      let buf = Buffer.alloc(0);
      let wrote = false;
      req.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
          const len = buf.readUInt32BE(1);
          const msg = fromBinary(SubscribeBidirectionalRequestSchema, buf.subarray(5, 5 + len));
          buf = buf.subarray(5 + len);
          if (msg.payload.case === "join" && !wrote) {
            wrote = true;
            res.write(
              Buffer.concat([
                frame(
                  create(SubscribeBidirectionalResponseSchema, {
                    payload: {
                      case: "joined",
                      value: create(ConsumerGroupJoinedSchema, { subscriptionId: "member-1", pattern: "topic:orders", ackMode: mode }),
                    },
                  }),
                ),
                frame(
                  create(SubscribeBidirectionalResponseSchema, {
                    payload: { case: "event", value: create(SubscriptionEventSchema, { subscriptionId: "member-1", eventId: "evt-1", topic: "orders" }) },
                  }),
                ),
              ]),
            );
          } else if (msg.payload.case === "ack") {
            acks.push(msg.payload.value);
            res.write(
              frame(
                create(SubscribeBidirectionalResponseSchema, {
                  payload: { case: "ackResult", value: create(AckResultSchema, { ackId: msg.payload.value.ackId, eventId: msg.payload.value.eventId, code: AckResultCode.OK }) },
                }),
              ),
            );
          }
        }
      });
      req.on("end", () => res.end());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const sessions = new Set<http2.ServerHttp2Session>();
    server.on("session", (sess) => sessions.add(sess));
    stops.push(
      () =>
        new Promise<void>((r) => {
          for (const sess of sessions) sess.destroy();
          server.close(() => r());
        }),
    );
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, streams: [], acks };
  }

  for (const mode of [AckMode.MANUAL, AckMode.AUTO]) {
    it(`onEvent sees the handle when the first event arrives with joined (${AckMode[mode]})`, async () => {
      const fake = await startRawJoinedWithEvent(mode);
      let sub: Awaited<ReturnType<typeof joinConsumerGroupStream>> | undefined;
      let handleSeen: boolean | undefined;
      const errors: unknown[] = [];
      const done = new Promise<void>((resolve) => {
        (async () => {
          const joined = await joinConsumerGroupStream(
            cfg(fake),
            "workers",
            {
              onEvent: async (e) => {
                handleSeen = sub !== undefined;
                if (mode === AckMode.MANUAL) await sub!.ack(e.eventId!);
                resolve();
              },
              onError: (e) => {
                errors.push(e);
                resolve();
              },
            },
          );
          subs.push(joined);
          // A caller that does more work before it stores the handle: every hop
          // is a microtask, and the release is a macrotask, so it must still win.
          for (let i = 0; i < 200; i++) await null;
          sub = joined;
        })();
      });
      await done;
      expect(errors).toEqual([]);
      expect(handleSeen).toBe(true);
      if (mode === AckMode.MANUAL) expect(fake.acks).toHaveLength(1);
    });
  }

  it("unsubscribe before the first event is released ends cleanly without calling onEvent", async () => {
    const fake = await startRawJoinedWithEvent(AckMode.MANUAL);
    const onEvent = vi.fn();
    const states: string[] = [];
    const sub = await join(fake, { onEvent, onStateChange: (st) => states.push(st) });
    sub.unsubscribe(); // runs before the release macrotask
    await vi.waitFor(() => expect(states).toContain("disconnected"));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("unsubscribe during reconnect leaves no member", async () => {
    let joinSeen!: () => void;
    const joined = new Promise<void>((r) => (joinSeen = r));
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    let stream2End!: (how: string | undefined) => void;
    const ended = new Promise<string | undefined>((r) => (stream2End = r));
    const fake = await startFake(async (s) => {
      if (s.n === 1) {
        await s.join("member-1");
        s.fail(Code.Unavailable, "dropped");
        return;
      }
      if (s.n === 2) {
        await s.recv(); // the join
        joinSeen();
        await gate; // the client is mid-reconnect, waiting for joined
        await s.send({
          case: "joined",
          value: create(ConsumerGroupJoinedSchema, { subscriptionId: "member-2", pattern: "topic:orders", ackMode: AckMode.MANUAL }),
        });
        await s.recv(); // a live member would block here
        stream2End(s.closedBy);
      }
    });
    const sub = await join(fake);
    await joined;
    sub.unsubscribe();
    openGate();
    // A live member would sit in recv() forever; the client must end the stream.
    expect(await Promise.race([ended, new Promise((r) => setTimeout(() => r("still live"), 1500))])).not.toBe("still live");
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.streams).toHaveLength(2); // unsubscribe stopped the reconnect
  });

  it("reconnect delay grows without accepted frames", async () => {
    const starts: number[] = [];
    const fake = await startFake(async (s) => {
      starts.push(Date.now());
      await s.join("member-1");
      s.end(); // joined, then a clean hang-up: nothing past joined
    });
    await join(fake, {}, { reconnectDelay: 200 });
    await vi.waitFor(() => expect(starts.length).toBeGreaterThanOrEqual(4), { timeout: 5000 });
    // Waits are 200, 300, 450 ms; timers never fire early, so these are floors
    // with 30 ms of slack each.
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(270);
    expect(starts[3]! - starts[2]!).toBeGreaterThanOrEqual(420);
  });

  it("an accepted frame resets the reconnect delay", async () => {
    const starts: number[] = [];
    const fake = await startFake(async (s) => {
      starts.push(Date.now());
      await s.join(`member-${s.n}`);
      if (s.n >= 3) await s.event(`member-${s.n}`, `evt-${s.n}`); // accepted
      s.end();
    });
    await join(fake, {}, { reconnectDelay: 60 });
    await vi.waitFor(() => expect(starts.length).toBeGreaterThanOrEqual(5));
    // Streams 1, 2 earn nothing: waits 60, 90. Stream 3 delivers an event, so the
    // wait before stream 4 resets to 60 rather than growing to 135.
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(85);
    expect(starts[3]! - starts[2]!).toBeLessThan(130);
  });

  it("reconnect drops queued events of the ended stream", async () => {
    const total = 50;
    let drop!: () => void;
    const dropped = new Promise<void>((r) => (drop = r));
    const fake = await startFake(async (s) => {
      if (s.n === 1) {
        await s.join("member-1");
        for (let i = 0; i < total; i++) await s.event("member-1", `evt-${i}`);
        await dropped;
        s.fail(Code.Unavailable, "dropped");
        return;
      }
      await s.join("member-2");
      await s.event("member-2", "fresh");
      for (let r = await s.recv(); r; r = await s.recv());
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const sub = await join(fake, {
      onEvent: async (e) => {
        if (e.eventId === "evt-0") await gate; // the pump parks here; the rest queue
        seen.push(e.eventId!);
      },
    });
    // evt-0 is in the handler; the other 49 wait in the internal queue.
    const queue = (sub as unknown as { queue: unknown[] }).queue;
    await vi.waitFor(() => expect(queue.length).toBe(total - 1));
    drop();
    await vi.waitFor(() => expect(sub.id).toBe("member-2"));
    release();
    await vi.waitFor(() => expect(seen).toContain("fresh"));
    expect(seen).toEqual(["evt-0", "fresh"]);
  });
});
