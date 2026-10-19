import { SDK_VERSION } from "./version.js";

// X-User-Agent, not a new header: it is already in every released server's CORS allow-list, and a
// new one would fail the preflight against a server older than this SDK. Browsers cannot set User-Agent.
const SDK_HEADER_NAME = "X-User-Agent";
const SDK_HEADER_VALUE = `ironflow-browser/${SDK_VERSION}`;

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

/** The value `sdkFetch` and the Connect interceptors send. */
export const SDK_HEADER = { name: SDK_HEADER_NAME, value: SDK_HEADER_VALUE } as const;
