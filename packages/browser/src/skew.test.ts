import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sdkFetch } from "./sdk-fetch.js";
import { SDK_VERSION } from "./version.js";
import { ironflow } from "./index.js";

const want = `ironflow-browser/${SDK_VERSION}`;

afterEach(() => vi.unstubAllGlobals());

describe("X-User-Agent", () => {
  it("sdkFetch adds the header and keeps the caller's", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", mock);
    await sdkFetch("http://x/a", { headers: { Authorization: "Bearer k" } });
    await sdkFetch("http://x/b", { headers: { "x-user-agent": "custom/1" } });
    const sent = mock.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(sent[0]!.get("x-user-agent")).toBe(want);
    expect(sent[0]!.get("authorization")).toBe("Bearer k");
    expect(sent[1]!.get("x-user-agent")).toBe("custom/1");
  });

  it("every Connect transport names the SDK", () => {
    const missing: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "gen") walk(p);
        } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
          const text = readFileSync(p, "utf8");
          if (/createConnectTransport\(\{/.test(text) && !text.includes("SDK_HEADER")) missing.push(p);
        }
      }
    };
    walk(__dirname);
    expect(missing).toEqual([]);
  });

  it("version.ts matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("no module calls the global fetch directly", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && name !== "sdk-fetch.ts") {
          readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (/(^|[^\w.])fetch\(/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !line.includes("sdk-fetch: exempt")) offenders.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk(__dirname);
    expect(offenders).toEqual([]);
  });
});

describe("browser client", () => {
  it("sends X-User-Agent and passes an unknown run status through", async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ id: "r1", status: "RUN_STATUS_ZZ_FUTURE", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" })),
    });
    vi.stubGlobal("fetch", mock);
    ironflow.configure({ serverUrl: "http://localhost:9123", logger: false });
    const run = await ironflow.getRun("r1");
    expect(run.status).toBe("zz_future");
    expect(new Headers(mock.mock.calls[0]![1].headers).get("x-user-agent")).toBe(want);
  });
});
