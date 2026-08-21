/**
 * Read a failed response's body so the thrown error carries the server's reason
 * and not just a bare status code.
 *
 * Added with #1750: the server now rejects function and worker IDs that cannot
 * become a NATS subject, and it explains which rule failed — but every throw
 * site in worker.ts interpolated `response.status` alone, so the user saw "400"
 * and had nothing to act on.
 *
 * Bounded at 200 chars because the body is not necessarily our JSON: a proxy in
 * front of the server can return an HTML error page, and that should not be
 * spliced whole into an exception message. Same reasoning as the Go side's
 * 128-byte log truncation.
 *
 * Never throws — a body that cannot be read degrades to the bare status, which
 * is what these call sites reported before.
 *
 * Lives here rather than in worker.ts because package.json exports `./worker`
 * as a subpath, so anything exported from that module is public API. `src/internal/`
 * has no subpath entry, which is what makes this exportable for its test and
 * still not part of the package's surface.
 */
export async function errorDetail(response: Response): Promise<string> {
  let body: string;
  try {
    // try/catch, not `.catch()`: a `.catch()` handler only sees a REJECTED
    // promise, and `response.text` being absent throws SYNCHRONOUSLY before one
    // exists. Test doubles across this suite are plain `{ ok, status }` objects,
    // and a `.catch()` version turned every one of them into a TypeError inside
    // the error path — a fetch failure would have become a crash on a shape the
    // runtime does produce for non-standard Response-likes.
    body = (await response.text()).trim();
  } catch {
    return `${response.status}`;
  }
  if (!body) return `${response.status}`;
  const detail = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  return `${response.status}: ${detail}`;
}
