// Engine discovery file reader (ADR 0098). Fills UNSET IRONFLOW_* variables from
// the nearest `.ironflow/engine.json`; environment values always win. Called at
// first construction, never at import, so an app that loads its own `.env`
// first keeps its values.
import { closeSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwd as processCwd } from "node:process";

const MAX_BYTES = 64 * 1024;
const FILE = join(".ironflow", "engine.json");

export interface DiscoveryInput {
  env: Record<string, string | undefined>;
  cwd: string;
  /** Returns the file text, or null when absent/unreadable. Must read at most MAX_BYTES + 1 bytes. */
  readFile: (path: string) => string | null;
}

function isLoopback(hostname: string): boolean {
  // URL.hostname keeps the brackets around IPv6 literals.
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** Pure ADR 0098 reader: returns the variables to set, or undefined for "do nothing". */
export function resolveDiscovery({ env, cwd, readFile }: DiscoveryInput): Record<string, string> | undefined {
  if (env.IRONFLOW_NO_DISCOVERY === "1") return undefined;
  if (env.IRONFLOW_SERVER_URL || env.IRONFLOW_API_KEY) return undefined;

  let text: string | null = null;
  for (let dir = cwd; ; dir = dirname(dir)) {
    text = readFile(join(dir, FILE));
    if (text !== null || dirname(dir) === dir) break;
  }
  if (text === null || Buffer.byteLength(text) > MAX_BYTES) return undefined;

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) return undefined;
  const { version, url, api_key: apiKey, environment } = doc as Record<string, unknown>;
  if (version !== 1 || typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" || !isLoopback(u.hostname)) return undefined;
  } catch {
    return undefined;
  }

  const out: Record<string, string> = { IRONFLOW_SERVER_URL: url };
  if (typeof apiKey === "string" && apiKey) out.IRONFLOW_API_KEY = apiKey;
  if (typeof environment === "string" && environment && !env.IRONFLOW_ENV) out.IRONFLOW_ENV = environment;
  return out;
}

function readBounded(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_BYTES + 1);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
  } catch {
    return null; // e.g. EISDIR
  } finally {
    closeSync(fd);
  }
}

// One bundle per entry point duplicates this flag; harmless, the second run only
// fills variables the first left unset.
let done = false;

export function hydrateEnvFromDiscovery(opts: Partial<DiscoveryInput> = {}): void {
  if (done) return;
  done = true;
  const env = opts.env ?? process.env;
  const vars = resolveDiscovery({
    env,
    cwd: opts.cwd ?? processCwd(),
    readFile: opts.readFile ?? readBounded,
  });
  if (vars) Object.assign(env, vars);
}
