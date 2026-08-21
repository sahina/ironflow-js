/**
 * Identifier generation for queued writes (ADR 0053).
 *
 * Every queued write carries an idempotency key generated at ENQUEUE time, not
 * at send time. That ordering is the whole trick: a retry after a page reload
 * reuses the same key, so the engine's dedup lookup recognises it and returns
 * the original event instead of creating a second one.
 */

/**
 * A random UUID v4.
 *
 * `crypto.randomUUID()` is the obvious implementation and is used when present,
 * but it lands in Safari 15.4 while this package documents a Safari 13.1
 * baseline (README "Browser Compatibility"). `crypto.getRandomValues()` goes
 * back much further, so the fallback keeps the baseline honest rather than
 * quietly raising it.
 *
 * Both branches are cryptographically random; the fallback only differs in
 * doing the RFC 4122 bit-twiddling and hex formatting by hand.
 */
export function newUuid(): string {
  const c = globalThis.crypto;

  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }

  if (typeof c?.getRandomValues !== "function") {
    throw new Error(
      "Ironflow offline queue requires Web Crypto (crypto.randomUUID or crypto.getRandomValues)"
    );
  }

  const bytes = c.getRandomValues(new Uint8Array(16));
  // Version 4 (random) and RFC 4122 variant, per §4.4.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex: string[] = [];
  for (const b of bytes) {
    hex.push(b.toString(16).padStart(2, "0"));
  }

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
