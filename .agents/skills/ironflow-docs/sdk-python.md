# Python SDK

Install the `ironflow-py` distribution (import name `ironflow`). Python is
Tier 1 for HTTP-polling workers and durable steps. Its REST and ConnectRPC
clients are generated; the worker runtime is hand-written.

```python
from ironflow.worker import Worker, function

@function(id="order-worker", triggers=[{"event": "order.placed"}])
async def process(ctx):
    return await ctx.step.run("charge", lambda: charge(ctx.event.data))

Worker(functions=[process]).run()
```

`ctx` exposes `event`, `step`, `run`, `logger`, and read-only `secrets`.
`step` provides `run`, `sleep`, `sleep_until`, `wait_for_event`, `parallel`, `map`,
`invoke`, `invoke_async`, `publish`, and `compensate` (sync; registers an undo that runs newest-first when the run fails with no retry). Bare duration numbers are seconds. `run()` handles SIGINT and
SIGTERM with a bounded drain; `await start()` runs until drain, stop, or failure.
Make step bodies idempotent because work after the last checkpoint may repeat.
Synchronous callbacks run in a thread that timeout and drain cannot stop.
Wait timeout fails the run.

`Worker` also takes `projections=[...]` (values from
`ironflow.projection.create_projection`) and `upcasters=` (an `ironflow.UpcasterRegistry`).

For the full API and equivalent Go and TypeScript examples, see
<https://docs.ironflow.run/reference/api/python-sdk/#pull-worker>.

## Push mode

`ironflow.serve` gives Python a push handler runtime too: `serve()` returns
an ASGI app (mount under FastAPI/Starlette, or run directly with uvicorn);
`register()` registers functions as push, pointing the engine at an
`endpoint_url`.

```python
import asyncio

from ironflow.serve import register, serve
from ironflow.worker import function

@function(id="send-receipt", triggers=[{"event": "order.paid"}])
async def send_receipt(ctx):
    await ctx.step.run("email", lambda: send(ctx.event.data))

ironflow_app = serve([send_receipt])   # uvicorn module:ironflow_app

# once per deploy, e.g. from a release script — not in the module uvicorn loads
asyncio.run(register([send_receipt], endpoint_url="https://api.example.com/ironflow/"))  # trailing slash: a mount redirects "/ironflow"
```

- Short functions only: each push request gets at most the push timeout
  (10s by default), or the function's `timeout` (registered as `timeoutMs`) if that is lower. After
  that the engine retries while the handler may still be running. Use the
  pull worker for long work.
- Push or pull, not both: a pull `Worker` re-registers a function id as pull
  and silently undoes its push registration.

See <https://docs.ironflow.run/reference/api/python-sdk/#push-mode>.

## Files

<!-- derived-from: docs/how-to-guides/storage/files.mdx#signed-urls -->
<!-- derived-from: docs/how-to-guides/storage/files.mdx#events -->

```python
client.files_buckets(body={"name": "inbox", "emitEvents": True, "allowSignedUrls": True})
info = client.files_update_buckets_objects("inbox", "scans/a.pdf", pdf_bytes,
                                           content_type="application/pdf")   # the PUT; bytes or seekable file
with client.files_get_buckets_objects("inbox", "scans/a.pdf", if_match=info["etag"]) as resp:
    data = resp.read()                                   # BinaryResponse; or resp.iter_bytes()
page = client.files_list_buckets_objects("inbox", prefix="scans/", delimiter="/")
client.files_buckets_move("inbox", body={"from": "scans/a.pdf", "to": "archive/a.pdf"})
client.files_buckets_move_prefix("inbox", body={"from": "scans/", "to": "archive/"})   # {"count": n}
up = client.files_buckets_signed_urls_upload("inbox", body={"path": "up/x.png", "ttlSeconds": 600, "createOnly": True})   # createOnly: a second PUT gets 412
client.files_delete_buckets_objects("inbox", "scans/a.pdf")
```

No bucket handle: the bucket name is the first argument. Set user metadata with
`extra_headers={"X-Ironflow-Meta-key": "v"}`. A body that is not bytes and not seekable raises
`ValueError`. Errors: `PreconditionFailedError` 412, `PayloadTooLargeError` 413,
`UnsupportedMediaTypeError` 415 (all `IronflowError` subclasses), other statuses are
`IronflowError` with `status_code`.

Rules that bite: every upload needs `Content-Length` (411) and `Content-Type`; a bucket needs
`allowSignedUrls: true` before you can sign, and `false` revokes every URL (403, code
`SIGNED_URLS_DISABLED`); multi-node needs
the same `auth.jwtSecret` on every node (503 otherwise); file events are at-least-once within
24 h, so key on `etag`; `ironflow.file.*` and `ironflow.bucket.*` are platform-only event names;
the filesystem backend counts files against the disk, not the database limit. Full guide:
https://docs.ironflow.run/how-to-guides/storage/files/
