/**
 * Live test: file storage round trip against a real server.
 * Skips unless IRONFLOW_TEST_SERVER is set; `make test-files-live` sets it.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IronflowClient } from "./client.js";
import { createFunction } from "./function.js";
import { createWorker } from "./worker.js";

const SERVER = process.env["IRONFLOW_TEST_SERVER"];
const API_KEY = process.env["IRONFLOW_TEST_API_KEY"];

const waitFor = async <T>(poll: () => Promise<T | undefined>, ms: number, what: string): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await poll();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe.skipIf(!SERVER)("file storage — live server", () => {
  it("put, event-triggered read, signed upload, move prefix, delete", async () => {
    const client = new IronflowClient({ serverUrl: SERVER!, apiKey: API_KEY });
    const files = client.files();
    const suffix = randomBytes(5).toString("hex");
    const bucketName = `live-${suffix}`;
    const fnId = `files-live-node-${suffix}`;
    await files.createBucket(bucketName, { emitEvents: true, allowSignedUrls: true });

    // Pinned to the event's etag, so a concurrent overwrite cannot change what it hashes.
    const fn = createFunction(
      { id: fnId, triggers: [{ event: "ironflow.file.created", expression: `data.bucket == '${bucketName}'` }] },
      async ({ event }) => {
        const d = event.data as { bucket: string; path: string; etag: string };
        const obj = await files.bucket(d.bucket).get(d.path, { ifMatch: d.etag });
        return { sha256: createHash("sha256").update(Buffer.from(await obj.arrayBuffer())).digest("hex") };
      },
    );
    const worker = createWorker({ serverUrl: SERVER!, apiKey: API_KEY, functions: [fn], logger: false });
    // start() resolves only when the worker stops, so it is not awaited.
    void worker.start().catch(() => {});
    try {
      await waitFor(
        async () => ((await client.listFunctions()) as Array<{ id: string }>).some((f) => f.id === fnId) || undefined,
        15000,
        "function registered",
      );

      const b = files.bucket(bucketName);
      const content = "hello from the live round trip";
      const want = createHash("sha256").update(content).digest("hex");
      const info = await b.put("in/a.txt", content, { contentType: "text/plain" });
      expect(info.sha256).toBe(want);

      const run = await waitFor(
        async () => {
          const { runs } = await client.listRuns({ functionId: fnId });
          const r = runs[0];
          if (r?.status === "failed") throw new Error(`run failed: ${r.error?.message}`);
          return r?.status === "completed" ? r : undefined;
        },
        10000,
        "file.created run to complete",
      );
      expect((run.output as { sha256: string }).sha256).toBe(want);

      const up = await b.signUpload("in/b.txt", { maxBytes: 1024, contentType: "text/plain" });
      console.log(`signed URL: ${up.url.split("?")[0]}`);
      expect(up.url.startsWith(`${SERVER}/api/v1/files/signed?token=`)).toBe(true);
      // No Authorization header: the token alone grants the write.
      const put = await fetch(up.url, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "signed body" });
      expect(put.status).toBe(201);
      expect((await b.info("in/b.txt")).size).toBe("signed body".length);

      expect(await b.movePrefix("in/", "archive/")).toBe(2);
      await b.delete("archive/a.txt");
      await b.delete("archive/b.txt");
      await files.deleteBucket(bucketName);
    } finally {
      await worker.drain();
    }
  }, 60000);
});
