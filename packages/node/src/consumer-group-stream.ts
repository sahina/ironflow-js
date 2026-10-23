/**
 * Consumer-group join over ConnectRPC `PubSubService.SubscribeBidirectional`.
 *
 * Opt-in alternative to the WebSocket join: events and acks share one HTTP/2
 * stream, and every `ack`, `nak` and `term` resolves from the server's result
 * for it. Behaves like the Go client (`sdk/go/ironflow/consumer_group_stream.go`).
 * Lives behind its own subpath so `@connectrpc/connect-node` stays out of the
 * main entry.
 */

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { create, toJson } from "@bufbuild/protobuf";
import { ValueSchema, timestampDate } from "@bufbuild/protobuf/wkt";
import type {
  AckableSubscription,
  ConnectionState,
  Logger,
  SubscriptionCallbacks,
  SubscriptionEvent,
} from "@ironflow/core";
import {
  HEADERS,
  IronflowError,
  calculateBackoff,
  createLogger,
  createNoopLogger,
} from "@ironflow/core";
import { SDK_HEADER } from "./sdk-fetch.js";
import {
  AckType,
  JoinConsumerGroupRequestSchema,
  PubSubService,
  SubscribeBidirectionalRequestSchema,
  type SubscribeBidirectionalRequest,
  type SubscribeBidirectionalResponse,
  type SubscriptionEvent as ProtoSubscriptionEvent,
} from "@ironflow/core/gen";
import { resolveEnvironment } from "./internal/register-functions.js";
import { AckError, GroupConn, StaleAckError, SubscriptionClosedError } from "./consumer-group-stream-conn.js";

export {
  AckError,
  StaleAckError,
  SubscriptionClosedError,
  type AckErrorCode,
} from "./consumer-group-stream-conn.js";

export interface ConsumerGroupStreamConfig {
  serverUrl: string;
  /** Falls back to the IRONFLOW_API_KEY env var. */
  apiKey?: string;
  environment?: string;
  /** Consumer group namespace (default: "default"). */
  namespace?: string;
  /** First reconnect delay in ms (default: 1000). */
  reconnectDelay?: number;
  /** Largest reconnect delay in ms (default: 30000). */
  maxReconnectDelay?: number;
  /** Reconnect backoff multiplier (default: 1.5). */
  reconnectBackoff?: number;
  /** How long `ack`, `nak` and `term` wait for the server's result (default: 30000). */
  ackTimeoutMs?: number;
  /**
   * Longest wait in ms for any frame before the stream counts as dead and
   * reconnects (default: 90000). The server sends a heartbeat after 30 s idle,
   * so a longer silence means a connection dropped without a reset.
   */
  idleTimeoutMs?: number;
  /** Warnings go here. `false` silences them. */
  logger?: Logger | false;
}

/**
 * Callbacks of a consumer-group stream. Unlike the shared
 * {@link SubscriptionCallbacks}, `onEvent` IS awaited: events are handled one
 * at a time, in order. A handler that throws or rejects reports to `onError`
 * and the SDK does not ack the event.
 *
 * In a MANUAL group the handler may `await sub.ack(id)`: the stream keeps
 * reading while it runs. In an AUTO group a slow handler stops the stream from
 * reading, and HTTP/2 flow control then pushes back to the server.
 */
export interface ConsumerGroupStreamCallbacks<T = unknown>
  extends Omit<SubscriptionCallbacks<T>, "onEvent"> {
  onEvent?: (event: SubscriptionEvent<T>) => void | Promise<void>;
}

const DEFAULT_RECONNECT_DELAY = 1000;
const DEFAULT_MAX_RECONNECT_DELAY = 30000;
const DEFAULT_BACKOFF = 1.5;
const DEFAULT_ACK_TIMEOUT = 30000;
const DEFAULT_IDLE_TIMEOUT = 90000;
const INT32_MAX = 2 ** 31 - 1;
// After unsubscribe half-closes, the server gets this long to end the stream
// before the client resets it.
const UNSUBSCRIBE_GRACE_MS = 2000;

const RETRYABLE = new Set<Code>([
  Code.Unknown,
  Code.DeadlineExceeded,
  Code.ResourceExhausted,
  Code.Aborted,
  Code.Internal,
  Code.Unavailable,
]);

const isRetryable = (err: unknown) => RETRYABLE.has(ConnectError.from(err).code);

interface BidiClient {
  subscribeBidirectional(
    requests: AsyncIterable<SubscribeBidirectionalRequest>,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<SubscribeBidirectionalResponse>;
}

function toEvent<T>(e: ProtoSubscriptionEvent): SubscriptionEvent<T> {
  const event: SubscriptionEvent<T> = {
    topic: e.topic,
    // data_value carries a payload that is not a JSON object; data holds the rest.
    data: (e.dataValue ? toJson(ValueSchema, e.dataValue) : (e.data ?? null)) as T,
    eventId: e.eventId,
  };
  if (e.metadata) {
    event.meta = {
      timestamp: e.metadata.timestamp ? timestampDate(e.metadata.timestamp).toISOString() : "",
      sequence: Number(e.sequence),
      sequenceExact: e.sequence.toString(),
    };
  }
  return event;
}

/** The first server that implements `SubscribeBidirectional` (ADR 0123). Go and Python carry the same value. */
const MIN_SERVER_VERSION_SUBSCRIBE_BIDIRECTIONAL = "0.48.0";

/** The server is too old for a call; `message` names the minimum version. Not retryable. */
export class ServerTooOldError extends IronflowError {
  constructor(rpc: string, minVersion: string, cause?: Error) {
    super(`${rpc} needs Ironflow server >= ${minVersion}; upgrade the server or use the WebSocket transport`, {
      code: "SERVER_TOO_OLD",
      retryable: false,
      cause,
    });
    this.name = "ServerTooOldError";
  }
}

const codeName = (c: Code) => Code[c].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

class GroupSubscription<T> implements AckableSubscription {
  pattern = "";
  connectionState: ConnectionState = "connecting";

  private readonly client: BidiClient;
  private readonly logger: Logger;
  private readonly join: SubscribeBidirectionalRequest;
  private readonly delays: { first: number; max: number; backoff: number };
  private readonly ackTimeout: number;
  private readonly idleTimeout: number;

  private cur?: GroupConn; // the last joined stream; stays after it ends
  private opening?: GroupConn; // a join in flight
  private stopped = false; // unsubscribe() ran
  private exiting = false; // run() is ending: no reconnect will follow
  private warnedAuto = false;
  private sleepWake?: () => void;
  private force?: ReturnType<typeof setTimeout>;

  // MANUAL streams only. The reader appends here and never blocks: it also
  // delivers ack results, so a handler that awaits ack() must not stall it. The
  // queue cannot outgrow the group's MaxInflight (the JetStream MaxAckPending),
  // which caps unacked events. AUTO streams skip it and await onEvent in the
  // reader, so flow control pushes back to the server.
  private queue: { ev: SubscriptionEvent<T>; conn: GroupConn }[] = [];
  private finished = false;
  private pumpWake?: () => void;
  private pumpDone!: Promise<void>;

  // Holds every onEvent call until joinConsumerGroupStream has returned the
  // handle, so a handler can use `sub.ack` for an event that arrived with joined.
  // Events queue (MANUAL) or stall the reader (AUTO) meanwhile.
  private release!: () => void;
  private readonly released = new Promise<void>((r) => (this.release = r));

  constructor(
    config: ConsumerGroupStreamConfig,
    private readonly groupName: string,
    private readonly callbacks: ConsumerGroupStreamCallbacks<T>,
  ) {
    this.logger =
      config.logger === false
        ? createNoopLogger()
        : (config.logger ?? createLogger({ prefix: "[ironflow-consumer-group]" }));
    this.delays = {
      first: config.reconnectDelay ?? DEFAULT_RECONNECT_DELAY,
      max: config.maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY,
      backoff: config.reconnectBackoff ?? DEFAULT_BACKOFF,
    };
    this.ackTimeout = config.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT;
    this.idleTimeout = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT;
    this.join = create(SubscribeBidirectionalRequestSchema, {
      payload: {
        case: "join",
        value: create(JoinConsumerGroupRequestSchema, {
          namespace: config.namespace ?? "",
          groupName,
        }),
      },
    });

    const apiKey = config.apiKey || process.env.IRONFLOW_API_KEY;
    const environment = resolveEnvironment(config.environment);
    const transport = createConnectTransport({
      baseUrl: config.serverUrl,
      httpVersion: "2",
      interceptors: [
        (next) => async (req) => {
          if (apiKey) req.header.set("Authorization", `Bearer ${apiKey}`);
          if (environment) req.header.set(HEADERS.ENVIRONMENT_ID, environment);
          req.header.set(SDK_HEADER.name, SDK_HEADER.value);
          return next(req);
        },
      ],
    });
    // Type assertion for the connect-es v1/v2 mismatch, as in worker-streaming.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client = createClient(PubSubService as any, transport) as unknown as BidiClient;
  }

  get id(): string {
    return this.cur?.subId ?? "";
  }

  async start(): Promise<void> {
    const conn = await this.open().catch((err) => {
      if (ConnectError.from(err).code === Code.Unimplemented) {
        throw new ServerTooOldError("SubscribeBidirectional", MIN_SERVER_VERSION_SUBSCRIBE_BIDIRECTIONAL, err);
      }
      throw err;
    });
    this.pattern = conn.pattern;
    this.setState("connected");
    this.pumpDone = this.pump();
    this.run(conn).catch((err) => this.report(err));
  }

  /** Lets queued events reach onEvent. Called once the caller has the handle. */
  releaseEvents(): void {
    this.release();
  }

  unsubscribe(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.release();
    this.opening?.teardown(); // a join in flight must not outlive this call
    this.cur?.halfClose(); // the server leaves the group
    this.sleepWake?.();
    this.force = setTimeout(() => this.cur?.teardown(), UNSUBSCRIBE_GRACE_MS);
    this.force.unref();
  }

  ack(eventId: string): Promise<void> {
    return this.settle(eventId, AckType.ACK, 0);
  }
  nak(eventId: string, delay = 0): Promise<void> {
    return this.settle(eventId, AckType.NAK, delay);
  }
  term(eventId: string): Promise<void> {
    return this.settle(eventId, AckType.TERM, 0);
  }

  private settle(eventId: string, ackType: AckType, delayMs: number): Promise<void> {
    if (this.stopped || this.exiting) return Promise.reject(new SubscriptionClosedError());
    const conn = this.cur;
    if (!conn) return Promise.reject(new StaleAckError());
    if (!conn.manual) {
      // The server settles an AUTO event on handoff and would answer OK to
      // anything.
      if (!this.warnedAuto) {
        this.warnedAuto = true;
        this.logger.warn(
          "ack, nak and term do nothing on an AUTO consumer group; events are settled when delivered",
          { group: this.groupName },
        );
      }
      return Promise.resolve();
    }
    // The wire field is an int32: the encoder throws on anything else, which
    // would end the stream and every pending ack with it.
    const ms = Math.round(delayMs);
    if (!(ms >= 0 && ms <= INT32_MAX)) {
      return Promise.reject(
        new AckError(eventId, "invalid_argument", `redeliver delay ${delayMs} is outside 0 to ${INT32_MAX} ms`),
      );
    }
    return conn.settle(eventId, ackType, ms, this.ackTimeout);
  }

  /** Starts a stream, sends the join and waits for joined. */
  private async open(): Promise<GroupConn> {
    if (this.stopped) throw new ConnectError("unsubscribed while reconnecting", Code.Canceled);
    const conn = new GroupConn(this.join);
    this.opening = conn;
    try {
      // sdkcoverage: POST /ironflow.v1.PubSubService/SubscribeBidirectional
      const responses = this.client.subscribeBidirectional(conn.requests(), { signal: conn.abort.signal });
      conn.responses = responses[Symbol.asyncIterator]();
      const first = await conn.responses.next();
      if (first.done) throw new ConnectError("stream ended before joined", Code.Unavailable);
      const payload = first.value.payload;
      if (payload.case !== "joined") throw new ConnectError("first frame was not joined", Code.Internal);
      conn.init(payload.value);
      // unsubscribe() tears down `opening`, but a joined already in flight lands
      // here: refuse it so no member outlives unsubscribe.
      if (this.stopped) throw new ConnectError("unsubscribed while reconnecting", Code.Canceled);
      this.cur = conn;
      return conn;
    } catch (err) {
      conn.teardown();
      throw err;
    } finally {
      this.opening = undefined;
    }
  }

  /** Reads streams until unsubscribe or a terminal error. */
  private async run(conn: GroupConn): Promise<void> {
    let attempt = 1;
    try {
      for (;;) {
        const { accepted, err } = await this.read(conn);
        if (this.stopped) return;
        // A clean server end (for instance a deleted group) reconnects; a rejoin
        // that finds the group gone is NotFound, which is terminal.
        if (err !== undefined && !isRetryable(err)) {
          this.report(err);
          return;
        }
        // Only a stream that got past joined earns a fresh backoff: a server that
        // joins and hangs up must not be retried at the base rate forever.
        if (accepted) attempt = 1;
        this.setState("reconnecting");
        for (;;) {
          const wait = calculateBackoff(attempt++, this.delays.first, this.delays.max, this.delays.backoff);
          if (!(await this.sleep(wait))) return;
          try {
            conn = await this.open();
            break;
          } catch (openErr) {
            if (this.stopped) return;
            if (!isRetryable(openErr)) {
              this.report(openErr);
              return;
            }
          }
        }
        this.setState("connected");
      }
    } finally {
      this.exiting = true;
      this.finished = true;
      this.release(); // pumpDone below must not wait on the caller
      this.wakePump();
      clearTimeout(this.force);
      this.cur?.teardown();
      await this.pumpDone;
      this.setState("disconnected");
    }
  }

  /** Consumes one stream to its end. err is undefined for a clean end. */
  private async read(conn: GroupConn): Promise<{ accepted: boolean; err?: unknown }> {
    let accepted = false;
    try {
      for (;;) {
        const r = await this.nextFrame(conn);
        if (r.done) return { accepted };
        const p = r.value.payload;
        if (p.case === "event") {
          accepted = true;
          let ev: SubscriptionEvent<T>;
          try {
            ev = toEvent<T>(p.value);
          } catch {
            continue; // skip malformed events, as the WebSocket path does
          }
          if (!conn.manual) {
            await this.deliver(ev);
            if (this.stopped) return { accepted };
            continue;
          }
          conn.markDelivered(p.value.eventId);
          this.queue.push({ ev, conn });
          this.wakePump();
        } else if (p.case === "ackResult") {
          accepted = true;
          conn.resolveAck(p.value);
        } else if (p.case === "heartbeat") {
          accepted = true;
        }
      }
    } catch (err) {
      return { accepted, err };
    } finally {
      conn.finish();
      // The server redelivers these on the new stream, and an ack of one here
      // could only fail with StaleAckError.
      this.queue = this.queue.filter((q) => q.conn !== conn);
      conn.teardown();
    }
  }

  /**
   * The next frame, or an Unavailable error (retryable, so run reconnects) when
   * none arrives within idleTimeout. Only the wait here counts: an AUTO reader
   * awaiting onEvent is not an idle connection.
   */
  private nextFrame(conn: GroupConn): Promise<IteratorResult<SubscribeBidirectionalResponse>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ConnectError(`no frame from the server within ${this.idleTimeout}ms`, Code.Unavailable)),
        this.idleTimeout,
      );
    });
    return Promise.race([conn.responses.next(), idle]).finally(() => clearTimeout(timer));
  }

  /** Moves queued MANUAL events to onEvent, one at a time. */
  private async pump(): Promise<void> {
    for (;;) {
      const qe = this.queue.shift();
      if (!qe) {
        if (this.finished) return;
        await new Promise<void>((r) => (this.pumpWake = r));
        continue;
      }
      if (qe.conn.ended || this.stopped) continue;
      await this.deliver(qe.ev);
    }
  }

  private wakePump() {
    this.pumpWake?.();
    this.pumpWake = undefined;
  }

  private async deliver(ev: SubscriptionEvent<T>): Promise<void> {
    await this.released;
    if (this.stopped) return;
    try {
      await this.callbacks.onEvent?.(ev);
    } catch (err) {
      this.emitError({ code: "HANDLER_ERROR", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private report(err: unknown) {
    const ce = ConnectError.from(err);
    // A rejoin that lands on an older node (a rolling upgrade) names the version too.
    const message =
      ce.code === Code.Unimplemented
        ? new ServerTooOldError("SubscribeBidirectional", MIN_SERVER_VERSION_SUBSCRIBE_BIDIRECTIONAL, ce).message
        : ce.message;
    this.emitError({ code: codeName(ce.code), message });
  }

  private emitError(e: { code: string; message: string }) {
    try {
      this.callbacks.onError?.({ subscriptionId: this.id, retrying: false, ...e });
    } catch {
      // a throwing onError must not end the stream
    }
  }

  private setState(state: ConnectionState) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    try {
      this.callbacks.onStateChange?.(state);
    } catch {
      // as emitError
    }
  }

  /** Resolves true after ms, false if unsubscribe cut it short. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(true), ms);
      this.sleepWake = () => {
        clearTimeout(t);
        resolve(false);
      };
    });
  }
}

/**
 * Joins a consumer group over `SubscribeBidirectional`. Resolves after the
 * server's `joined`; rejects with the stream's error (a `ConnectError`, for
 * instance `NotFound` for a missing group) when the join fails. `onEvent`
 * does not run before this call has returned, so a handler may use the returned
 * handle. After that the stream reconnects with exponential backoff until
 * `unsubscribe()` or a terminal error, which `callbacks.onError` receives.
 *
 * `ack`, `nak` and `term` resolve when the server applies them. They reject
 * with {@link AckError} (the server refused), {@link StaleAckError} (the event
 * belongs to a stream that ended), or {@link SubscriptionClosedError}. In an
 * AUTO group they are no-ops: the server settles events on delivery.
 */
export async function joinConsumerGroupStream<T = unknown>(
  config: ConsumerGroupStreamConfig,
  groupName: string,
  callbacks: ConsumerGroupStreamCallbacks<T> = {},
): Promise<AckableSubscription> {
  const sub = new GroupSubscription<T>(config, groupName, callbacks);
  await sub.start();
  // A macrotask: the caller's continuation after this await runs first.
  setImmediate(() => sub.releaseEvents());
  return sub;
}
