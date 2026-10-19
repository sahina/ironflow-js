import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as http from "node:http";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { createClient } from "./client.js";
import { SDK_VERSION } from "./version.js";
import { sdkFetch, sdkWebSocket } from "./sdk-fetch.js";
import { joinConsumerGroupStream, ServerTooOldError } from "./consumer-group-stream.js";

const want = `node/${SDK_VERSION}`;

afterEach(() => vi.unstubAllGlobals());

describe("X-Ironflow-SDK", () => {
  it("sdkFetch adds the header and keeps the caller's", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", mock);
    await sdkFetch("http://x/a", { headers: { Authorization: "Bearer k" } });
    await sdkFetch("http://x/b", { headers: { "X-Ironflow-SDK": "custom/1" } });
    await sdkFetch("http://x/c");
    const sent = mock.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(sent[0]!.get("x-ironflow-sdk")).toBe(want);
    expect(sent[0]!.get("authorization")).toBe("Bearer k");
    expect(sent[1]!.get("x-ironflow-sdk")).toBe("custom/1");
    expect(sent[2]!.get("x-ironflow-sdk")).toBe(want);
  });

  it("IronflowClient sends it on a REST/Connect call", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", mock);
    await createClient({ serverUrl: "http://localhost:9123" }).patchStep("step_1", {});
    expect(new Headers(mock.mock.calls[0]![1].headers).get("x-ironflow-sdk")).toBe(want);
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

  it("no module calls the global fetch directly", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "gen") walk(p);
        } else if (/\.ts$/.test(name) && !/\.(test|live\.test)\.ts$/.test(name) && !["sdk-fetch.ts"].includes(name)) {
          readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (/(^|[^\w.])fetch\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk(__dirname);
    expect(offenders).toEqual([]);
  });

  it("sdkWebSocket names the SDK on the handshake and keeps the protocols", async () => {
    const server = http.createServer();
    const seen = new Promise<http.IncomingHttpHeaders>((resolve) =>
      server.on("upgrade", (req, socket) => {
        resolve(req.headers);
        socket.destroy();
      })
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const ws = sdkWebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/`, ["ironflow.v1"]);
    ws.onerror = () => {};
    const headers = await seen;
    server.close();
    expect(headers["x-ironflow-sdk"]).toBe(want);
    expect(headers["sec-websocket-protocol"]).toBe("ironflow.v1");
  });

  it("no module constructs the global WebSocket directly", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "gen") walk(p);
        } else if (/\.ts$/.test(name) && !/\.(test|live\.test)\.ts$/.test(name) && !["sdk-fetch.ts"].includes(name)) {
          readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (/new WebSocket\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk(__dirname);
    expect(offenders).toEqual([]);
  });
});

async function startH2(handler: (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => void) {
  const server = http2.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("SubscribeBidirectional against a server that lacks it", () => {
  it.each([
    ["404 with no Connect body", 404, ""],
    ["Connect unimplemented", 404, '{"code":"unimplemented","message":"no such method"}'],
  ])("%s rejects with ServerTooOldError naming 0.48.0", async (_n, status, body) => {
    const { server, url } = await startH2((_req, res) => {
      res.writeHead(status, { "content-type": body ? "application/json" : "text/plain" });
      res.end(body);
    });
    try {
      const err = await joinConsumerGroupStream({ serverUrl: url, apiKey: "k", logger: false }, "g", {}).catch((e) => e);
      expect(err).toBeInstanceOf(ServerTooOldError);
      expect(err.code).toBe("SERVER_TOO_OLD");
      expect(err.retryable).toBe(false);
      expect(err.message).toContain("0.48.0");
    } finally {
      server.close();
    }
  });

  it("the Connect transport sends the header", async () => {
    let seen = "";
    const { server, url } = await startH2((req, res) => {
      seen = String(req.headers["x-ironflow-sdk"] ?? "");
      res.writeHead(404);
      res.end();
    });
    try {
      await joinConsumerGroupStream({ serverUrl: url, apiKey: "k", logger: false }, "g", {}).catch(() => {});
      expect(seen).toBe(want);
    } finally {
      server.close();
    }
  });
});

describe("unknown enum values", () => {
  it("getRun, listRuns and getRunSteps accept a status a newer server added", async () => {
    const respond = (path: string) =>
      path.endsWith("/GetRun")
        ? { id: "r1", status: "RUN_STATUS_ZZ_FUTURE" }
        : path.endsWith("/ListRuns")
          ? { runs: [{ id: "r1", status: "RUN_STATUS_ZZ_FUTURE" }, { id: "r2", status: "RUN_STATUS_COMPLETED" }], totalCount: 2 }
          : { steps: [{ id: "s1", stepType: "STEP_TYPE_ZZ_FUTURE", status: "STEP_STATUS_ZZ_FUTURE" }, { id: "s2" }] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(respond(url)), { headers: { "content-type": "application/json" } })));
    const client = createClient({ serverUrl: "http://localhost:9123" });

    expect((await client.getRun("r1")).status).toBe("zz_future");
    const list = await client.listRuns();
    expect(list.runs.map((r) => r.status)).toEqual(["zz_future", "completed"]);
    expect((await client.getRunSteps("r1")).steps).toHaveLength(2);
  });
});
