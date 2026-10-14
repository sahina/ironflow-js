# Go SDK Reference

## Install

```bash
go get github.com/sahina/ironflow-go/ironflow
```

## Event Name Constants

```go
package events

const (
    OrderPlaced    = "order.placed"
    OrderConfirmed = "order.confirmed"
    OrderShipped   = "order.shipped"
)
```

## Functions

```go
import (
    "github.com/sahina/ironflow-go/ironflow"
    "your-module/internal/events"
)

var ProcessOrder = ironflow.CreateFunction(ironflow.FunctionConfig{
    ID:        "process-order",
    Triggers:  []ironflow.Trigger{{Event: events.OrderPlaced}},
    Recording: true,
}, func(ctx ironflow.Context) (any, error) {
    var data OrderData
    if err := ctx.Event.Data(&data); err != nil {
        return nil, err
    }

    order, err := ironflow.Run(ctx, "validate", func() (Order, error) {
        return Order{Valid: true, OrderID: data.OrderID}, nil
    })
    if err != nil {
        return nil, err
    }

    return map[string]any{"order": order}, nil
})
```

## Emitting Events

`Emit` is how anything outside a function starts a workflow. It is fire-and-forget: it
returns as soon as the event is stored and the runs are created.

```go
import "github.com/sahina/ironflow-go/ironflow"

// Empty fields fall back to IRONFLOW_SERVER_URL / IRONFLOW_API_KEY.
client := ironflow.NewClient(ironflow.ClientConfig{})

res, err := client.Emit(ctx, events.OrderPlaced, map[string]any{
    "orderId": "ord_123",
    "total":   99.99,
},
    ironflow.WithEmitIdempotencyKey("order-ord_123"),  // dedupes repeat emits
    ironflow.WithEmitVersion(1),                       // schema version, default 1
    ironflow.WithEmitMetadata(map[string]any{"source": "checkout"}),
    ironflow.WithEmitNamespace("default"),
)
// res.EventID, res.RunIDs

// Block until EVERY run the event triggers finishes. The timeout is a POSITIONAL
// argument, not an option. Returns []EmitSyncResult (empty if nothing matched) and
// never reports a run outcome as err — read Status, Error and WaitTimedOut per element.
results, err := client.EmitSync(ctx, events.OrderPlaced, data, 30*time.Second,
    ironflow.WithSyncIdempotencyKey("order-ord_123"))

// One function by ID, one result. Same positional timeout.
out, err := client.InvokeSync(ctx, "process-order", data, 30*time.Second)
```

Inside a function handler there is no client on `ironflow.Context` — build one yourself,
and emit inside an `ironflow.Run` step so it is memoized.

## Step Methods

```go
// Memoized — generic, infers return type
result, err := ironflow.Run(ctx, "step-name", func() (MyType, error) {
    return MyType{Done: true}, nil
})

// With timeout override
result, err := ironflow.Run(ctx, "slow", func() (string, error) {
    return callAPI()
}, ironflow.WithTimeout(30*time.Second))

// Durable sleep
ironflow.Sleep(ctx, "wait", 1*time.Hour)
ironflow.SleepUntil(ctx, "wait-open", time.Date(2026, 3, 16, 9, 30, 0, 0, time.UTC))

// Wait for event. The type argument is REQUIRED — T appears in no parameter,
// so Go cannot infer it and the call does not compile without it.
// On timeout the scheduler fails the run; err is not how a timeout reaches you.
event, err := ironflow.WaitForEvent[any](ctx, "wait-approval", ironflow.EventFilter{
    Event:   events.OrderApproved,
    Match:   "data.orderId",
    Timeout: 24 * time.Hour,   // default 7 days
})

// Parallel branches. Inside a branch use the *WithBranch forms — they take the
// *BranchContext, not ctx, and generate branch-scoped step IDs. Calling
// ironflow.Run(ctx, ...) from inside a branch keys the step off the parent, so
// sibling branches collide on one memoized result.
results, err := ironflow.Parallel(ctx, "fetch-all", []func(*ironflow.BranchContext) (any, error){
    func(b *ironflow.BranchContext) (any, error) { return ironflow.RunWithBranch(b, "fetch-a", fetchA) },
    func(b *ironflow.BranchContext) (any, error) { return ironflow.RunWithBranch(b, "fetch-b", fetchB) },
})

// Branch-scoped equivalents: RunWithBranch, SleepWithBranch, SleepUntilWithBranch,
// WaitForEventWithBranch, ParallelWithBranch, MapWithBranch, InvokeWithBranch,
// InvokeAsyncWithBranch, PublishWithBranch, CompensateInBranch.

// Parallel map with concurrency
results, err := ironflow.Map(ctx, "items", items, func(item Item, b *ironflow.BranchContext, i int) (Result, error) {
    return ironflow.RunWithBranch(b, fmt.Sprintf("process-%d", i), func() (Result, error) {
        return processItem(item)
    })
}, ironflow.ParallelOptions{Concurrency: 5})

// Saga compensation
ironflow.Compensate(ctx, "charge", func() error { return refund() })

// Invoke another function
result, err := ironflow.Invoke[InvoiceResult](ctx, "generate-invoice", input)
asyncRes, err := ironflow.InvokeAsync(ctx, "send-report", input)

// NEVER recover() around a yielding step. Sleep, SleepUntil, WaitForEvent,
// Invoke and InvokeAsync suspend the run by PANICKING with an internal yield
// value (sdk/go/ironflow/step.go). A recover() in your handler swallows it and
// the run finishes without ever waiting. Only Run returns ordinary errors.

// Pub/sub publish
ironflow.Publish(ctx, "notifications", data)
```

## Projections

```go
var OrderStats = ironflow.CreateProjection(ironflow.ProjectionConfig{
    Name:   "order-stats",
    Events: []string{events.OrderPlaced},
    InitialState: func() map[string]any {
        // Use float64 literals so the .(float64) assertion below is stable
        // both on first call (in-memory) and on rebuild (unmarshaled from JSON).
        return map[string]any{"totalOrders": 0.0, "revenue": 0.0}
    },
    Handler: func(state map[string]any, event ironflow.ProjectionEvent, ctx ironflow.ProjectionContext) (map[string]any, error) {
        // Return a fresh map — never mutate `state` then return it. See anti-patterns.md #3b.
        next := make(map[string]any, len(state)+1)
        for k, v := range state {
            next[k] = v
        }
        next["totalOrders"] = state["totalOrders"].(float64) + 1
        return next, nil
    },
})
```

## Worker (Pull Mode)

```go
worker := ironflow.NewWorker(ironflow.WorkerConfig{
    ServerURL:   os.Getenv("IRONFLOW_SERVER_URL"),
    Functions:   []ironflow.Function{ProcessOrder},
    Projections: []ironflow.Projection{OrderStats},
})
worker.Run(ctx)   // automatically registers all functions
```

Python's equivalent polling entry point is `Worker(functions=[...]).run()`
from `ironflow.worker`; see `sdk-python.md` for its decorator and step API.

## Serve (Push Mode — HTTP Handler)

```go
handler := ironflow.Serve(ironflow.ServeConfig{
    Functions: []ironflow.Function{ProcessOrder},
})
http.ListenAndServe(":3001", handler)
```

## Entity Streams

Entity IDs must be URL-safe: letters, digits, `-`, `_`, `.`, `:`, `~`. `/`, `?`, `#`, `%`,
`&`, and whitespace are rejected at write time. To namespace by tenant, flatten into one
segment (`tenant1-issue-42`) or filter by `EntityType` instead.

```go
client := ironflow.NewClient(ironflow.ClientConfig{})

// *StreamInfo: EntityID, EntityType, Version, EventCount, CreatedAt, UpdatedAt.
// NOT the TS shape: `streams.getInfo` swallows "stream not found" and returns null,
// so `info ? info.version : 0` is idiomatic there. Go propagates that error instead —
// for a first append skip the probe and pass WithExpectedVersion(0).
info, err := client.GetStreamInfo(ctx, "order-123")

res, err := client.AppendStreamEvent(ctx, "order-123", ironflow.AppendEventInput{
    Name:       events.OrderPlaced,
    Data:       map[string]any{"total": 99.99},
    EntityType: "order",
}, ironflow.WithExpectedVersion(int64(info.Version)))   // pass 0 for the first append

// ReadStream returns a BARE SLICE, not a {events, totalCount} envelope like the TS SDK.
evts, err := client.ReadStream(ctx, "order-123")
```

`AppendStreamEvent` takes **exactly one** event per call, not a slice. Unlike the TS SDK,
`AppendResult` carries a `Sequence` alongside `EntityVersion` and `EventID` — the
JetStream sequence to hand to a projection wait for read-your-writes. `Sequence` is 0 when
the publish failed or the NATS bridge is disabled.

Other append options: `WithAppendIdempotencyKey`, `WithAppendMetadata`.

## KV Store

**Values are `[]byte`, not objects.** Unlike the TS SDK, the Go KV client does no
marshaling — you pass and receive raw bytes and do the JSON yourself.

```go
kv := client.KV()                    // KV() is a METHOD on *Client
_, err := kv.CreateBucket(ctx, ironflow.BucketConfig{Name: "user-settings"})
                                     // stored as APP_user-settings

b := kv.Bucket("user-settings")

value, _ := json.Marshal(map[string]any{"theme": "dark"})
rev, err := b.Put(ctx, "user-123", value)          // returns the new revision
entry, err := b.Get(ctx, "user-123")               // *KVEntry: Key, Value []byte, Revision, Operation

var settings map[string]any
_ = json.Unmarshal(entry.Value, &settings)

_, err = b.Create(ctx, "user-456", value)                  // create-if-not-exists
_, err = b.Update(ctx, "user-123", value, entry.Revision)  // CAS on revision
keys, err := b.ListKeys(ctx, "")    // filter is POSITIONAL and required; "" means all
err = b.Delete(ctx, "user-123")
err = b.Purge(ctx, "user-123")      // drops history too
```

Watching a bucket goes over a WebSocket (the same surface `@ironflow/node` and
`@ironflow/browser` expose):

```go
w, err := kv.Bucket("user-settings").Watch(ctx, ironflow.KVWatchCallbacks{
    OnUpdate: func(e ironflow.KVWatchEvent) {
        // e.Key, e.Value ([]byte, nil on delete), e.Operation ("put"/"delete"), e.Revision
    },
    OnError: func(err error) {},
    OnClose: func() {},
}, ironflow.WithWatchKey("user.*"))   // optional key pattern
defer w.Stop()                        // ALWAYS clean up
```

## Files

<!-- derived-from: docs/how-to-guides/storage/files.mdx#signed-urls -->
<!-- derived-from: docs/how-to-guides/storage/files.mdx#events -->

```go
files := client.Files()                                  // Files() is a METHOD on *Client
emit, signed := true, true
_, err := files.CreateBucket(ctx, "inbox", ironflow.FileBucketConfig{EmitEvents: &emit, AllowSignedURLs: &signed})

inbox := files.Bucket("inbox")
info, err := inbox.Put(ctx, "scans/a.pdf", r, size, ironflow.PutFileOptions{ContentType: "application/pdf"})
obj, err := inbox.Get(ctx, "scans/a.pdf", ironflow.GetFileOptions{IfMatch: info.ETag})   // *FileObject; close obj.Body
page, err := inbox.List(ctx, ironflow.ListFilesOptions{Prefix: "scans/", Delimiter: "/"})  // Files, Prefixes, NextCursor
_, err = inbox.Move(ctx, "scans/a.pdf", "archive/a.pdf", ironflow.MoveFileOptions{})
n, err := inbox.MovePrefix(ctx, "scans/", "archive/")   // both end in "/"; max 10000
u, err := inbox.SignUpload(ctx, "up/x.png", ironflow.SignUploadOptions{TTL: 10 * time.Minute, CreateOnly: true})   // u.URL; CreateOnly: a second PUT gets 412
err = inbox.Delete(ctx, "archive/a.pdf")
```

`Put` takes the size, and only an `io.ReadSeeker` body is retried. Bucket config fields are
pointers: nil means "server default" on create and "unchanged" on update. Errors (use
`errors.Is`): `ErrPreconditionFailed`, `ErrPayloadTooLarge`, `ErrUnsupportedMediaType`,
`ErrConflict`; a 404 is `*IronflowError` with `Code == "NOT_FOUND"`. Trigger on a file event with
`Trigger{Event: "ironflow.file.created", Expression: "data.bucket == 'inbox'"}`.

Rules that bite: every upload needs `Content-Length` (411) and `Content-Type`; a bucket needs
`allowSignedUrls: true` before you can sign, and `false` revokes every URL (403, code
`SIGNED_URLS_DISABLED`); multi-node needs
the same `auth.jwtSecret` on every node (503 otherwise); file events are at-least-once within
24 h, so key on `etag`; `ironflow.file.*` and `ironflow.bucket.*` are platform-only event names;
the filesystem backend counts files against the disk, not the database limit. Full guide:
https://docs.ironflow.run/how-to-guides/storage/files/

## Config Client

```go
cfg := client.Config()               // Config() is a METHOD on *Client

_, err := cfg.Set(ctx, "flags", map[string]any{"darkMode": true})
resp, err := cfg.Get(ctx, "flags")   // *ConfigResponse: Name, Data map[string]any, Revision, UpdatedAt
_, err = cfg.Patch(ctx, "flags", map[string]any{"betaFeatures": true})
_, err = cfg.Update(ctx, "flags", map[string]any{"darkMode": false}, resp.Revision) // HTTP_412 if another writer saved first
entries, err := cfg.List(ctx)
err = cfg.Delete(ctx, "flags")

w, err := cfg.Watch(ctx, "flags", ironflow.ConfigWatchCallbacks{
    OnUpdate: func(e ironflow.ConfigWatchEvent) { /* e.Data, e.Revision */ },
    OnError:  func(err error) {},
})
defer w.Stop()
```

Config is stored in `SYS_config_*` buckets and is hidden from the KV dashboard; `APP_*`
buckets from `KV()` are visible. See patterns.md.

## Webhooks

The Go webhook callbacks have different shapes from the TS ones: `Verify` returns only an
`error` (it does **not** return the parsed payload), and `Transform` receives the raw body
as `[]byte`.

```go
stripe := ironflow.CreateWebhook(ironflow.WebhookConfig{
    ID: "stripe",
    Verify: func(req *ironflow.WebhookRequest) error {
        // req.Body []byte, req.Header http.Header, req.Method, req.URL
        return ironflow.VerifySignature(
            string(req.Body),
            req.Header.Get("X-Signature"),
            os.Getenv("STRIPE_SECRET"),
            5*time.Minute,   // timestamp tolerance
        )
    },
    Transform: func(payload []byte) (*ironflow.WebhookEvent, error) {
        var p struct {
            Type string          `json:"type"`
            Data json.RawMessage `json:"data"`
        }
        if err := json.Unmarshal(payload, &p); err != nil {
            return nil, err
        }
        return &ironflow.WebhookEvent{Name: "webhook/stripe." + p.Type, Data: p.Data}, nil
    },
})

handler := ironflow.Serve(ironflow.ServeConfig{
    Functions: []ironflow.Function{ProcessOrder},
    Webhooks:  []ironflow.Webhook{stripe},
    ServerURL: os.Getenv("IRONFLOW_SERVER_URL"),   // REQUIRED. serve.go guards the
                                                   // emit on `serverURL != ""` and there
                                                   // is NO env fallback — leave it empty
                                                   // and the transformed event is
                                                   // silently dropped.
})
// Endpoint: POST /webhooks/stripe
```

`ironflow.ComputeSignature(payload, secret, timestamp)` produces the outbound form.

## Errors

```go
// Fails the step immediately — no retries.
return nil, ironflow.NewNonRetryableError("Invalid email")

// Same, wrapping an existing error.
if err := validate(input); err != nil {
    return nil, ironflow.WrapNonRetryable(err)
}

// Any ordinary error is retried per the function's retry config.
return nil, fmt.Errorf("gateway timeout: %w", err)
```

## Upcasters

`UpcasterFunc` is `func(json.RawMessage) (json.RawMessage, error)` — raw JSON in, raw
JSON out, with an error. It is not a `map[string]any` transform.

```go
registry := ironflow.NewUpcasterRegistry()

registry.Register("user.created", 1, 2, func(data json.RawMessage) (json.RawMessage, error) {
    var m map[string]any
    if err := json.Unmarshal(data, &m); err != nil {
        return nil, err
    }
    firstName, _ := m["firstName"].(string)
    lastName, _ := m["lastName"].(string)
    delete(m, "firstName")
    delete(m, "lastName")
    m["fullName"] = firstName + " " + lastName   // every other field is preserved
    return json.Marshal(m)
})
```

---

## Full Reference

- Go SDK reference: https://docs.ironflow.run/reference/api/go-sdk/
- SDK tier model: https://docs.ironflow.run/reference/sdk-comparison/
- Workflows guide: https://docs.ironflow.run/explanation/workflows/
- Event sourcing: https://docs.ironflow.run/explanation/event-sourcing/
