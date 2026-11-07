/**
 * Makes a fetch fake answer as a server that honors the projection delivery
 * position (ADR 0164): a poll response echoes a position, and a stream opens
 * with an OPEN frame. Fakes that test an old server do not use it.
 */
type FetchLike = (url: string, opts: RequestInit) => unknown;

function openFrame(): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify({ kind: "PROJECTION_EVENT_KIND_OPEN", seq: "0" }));
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

function prependOpen(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let opened = false;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (!opened) {
        opened = true;
        c.enqueue(openFrame());
        return;
      }
      const { done, value } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function echoPosition(data: unknown): unknown {
  if (data && typeof data === "object" && !("position" in data)) return { ...data, position: "0" };
  return data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withPositionEcho<F extends FetchLike>(fetchImpl: F): any {
  return async (url: string, opts: RequestInit) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = (await fetchImpl(url, opts)) as any;
    const u = String(url);
    if (!resp || !resp.ok) return resp;
    const real = resp instanceof Response;
    if (u.endsWith("/PollProjectionEvents")) {
      if (real) {
        const data = echoPosition(await resp.json());
        return new Response(JSON.stringify(data), { status: resp.status, headers: resp.headers });
      }
      const json = resp.json as () => Promise<unknown>;
      return { ...resp, json: async () => echoPosition(await json()) };
    }
    if (u.endsWith("/StreamProjectionEvents") && resp.body) {
      if (real) return new Response(prependOpen(resp.body), { status: resp.status, headers: resp.headers });
      return { ...resp, body: prependOpen(resp.body) };
    }
    return resp;
  };
}
