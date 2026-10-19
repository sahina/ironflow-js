import { SDK_VERSION } from "./version.js";

const SDK_HEADER_NAME = "X-Ironflow-SDK";
const SDK_HEADER_VALUE = `node/${SDK_VERSION}`;

/**
 * `fetch` that names this SDK and its version on the request (ADR 0125, version
 * skew). A header the caller already set wins. Reads `globalThis.fetch` at call
 * time so a test or a polyfill that replaces it still works.
 */
export function sdkFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const h = init.headers ?? (input instanceof Request ? input.headers : undefined);
  let headers: RequestInit["headers"];
  if (h instanceof Headers) {
    headers = new Headers(h);
    if (!headers.has(SDK_HEADER_NAME)) headers.set(SDK_HEADER_NAME, SDK_HEADER_VALUE);
  } else if (Array.isArray(h)) {
    headers = h.some((pair) => pair[0]?.toLowerCase() === SDK_HEADER_NAME.toLowerCase()) ? h : [...h, [SDK_HEADER_NAME, SDK_HEADER_VALUE]];
  } else {
    const plain = (h ?? {}) as Record<string, string>;
    headers = Object.keys(plain).some((k) => k.toLowerCase() === SDK_HEADER_NAME.toLowerCase())
      ? plain
      : { ...plain, [SDK_HEADER_NAME]: SDK_HEADER_VALUE };
  }
  return globalThis.fetch(input, { ...init, headers });
}

/**
 * The global `WebSocket` with this SDK's header on the handshake. Node's `WebSocket`
 * (undici) takes `{ protocols, headers }` as its second argument; a browser's does not,
 * which is why the browser SDK names itself on HTTP only.
 */
export function sdkWebSocket(url: string, protocols?: string[]): WebSocket {
  const init = { protocols, headers: { [SDK_HEADER_NAME]: SDK_HEADER_VALUE } };
  return new WebSocket(url, init as unknown as string[]);
}

/** The value `sdkFetch` and the Connect interceptors send. */
export const SDK_HEADER = { name: SDK_HEADER_NAME, value: SDK_HEADER_VALUE } as const;
