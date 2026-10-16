# Offline write queue — manual QA

Three behaviours (§3, §4, §5) **cannot be proven in the automated suite** and
must be walked by hand before releasing a change to `src/queue/` or
`src/offline.ts`. The other two (§1, §2) are automated in Chromium only: walk
them by hand in Safari.

## Why this is manual

`vitest` runs on jsdom, which has no `indexedDB` and no `navigator.locks`. The
suite supplies `fake-indexeddb` and a lock fake, which covers logic but not the
things that only a real browser has: an actual page reload, two real tabs, real
storage quota, and real eviction.

`apps/dashboard/e2e/sdk/offline-queue.spec.ts` runs the SDK in real Chromium
against a real engine (`make test-ui-smoke`, in `make ci`). It covers writes
queued offline, writes that survive a reload with their idempotency keys, flush
on reconnect (by `flush()` and by the armed backoff alone), two tabs with one
flusher, and two tabs without Web Locks. The no-locks run removes
`navigator.locks` in Chromium, so it tests the SDK's fallback, not Safari. The
other three are tracked in `TODOS.md` under "Automate the 5 critical browser paths".
**Until they are automated, this file is the only thing standing behind them —
a green CI run does not cover them.**

## Setup

```bash
make dev                     # engine on :9123
cd sdk/js/browser && pnpm build
```

Serve any page that calls `createClient({ offlineQueue: { identity: 'qa-user' } })`.
Keep DevTools open on **Application → Storage → IndexedDB → `ironflow-queue:...`**.

Offline is simulated with **Network → throttling → Offline**. Do not use airplane
mode: it also kills the dev server, so you cannot tell a queued write from a
failed one.

---

## 1. Writes survive a reload

This is the entire feature. If only one check gets run, run this one.

Automated in Chromium by `offline-queue.spec.ts`. Walk it by hand in Safari.

1. Go offline.
2. `emit()` three events with distinguishable payloads.
3. Confirm the outbox holds 3 records, and each `body` contains an
   `idempotency_key`.
4. **Hard reload** (Cmd-Shift-R).
5. Still offline: confirm all 3 records are still there.
6. Go online.

**Pass:** all 3 arrive server-side, in the order they were made, exactly once.
**Fail modes to look for:** a duplicate event (the key was regenerated on
reload), or an empty outbox after the reload (writes were held in memory).

## 2. Two tabs do not double-send

Automated in Chromium by `offline-queue.spec.ts`, with Web Locks and without
them. Walk it by hand in Safari.

1. Open the app in two tabs.
2. Go offline **in both**.
3. Queue two writes in tab A.
4. Confirm tab B's pending badge also shows 2 (this is the `BroadcastChannel`
   sync — it is not covered by the lock).
5. Bring both tabs online at the same moment.

**Pass:** each event appears once server-side, and only one tab shows `flushing`.
**Note:** on Safari < 16 there is no `navigator.locks`, so interleaving is
expected. Dedup keeps it correct; ordering across tabs is not guaranteed.

## 3. Quota exhaustion is survivable

1. Offline.
2. Emit large payloads (~200 KB each) until `QueueFullError` is thrown.

**Pass:** the throw is `QueueFullError`, the existing queue is intact, and
**nothing was evicted** — the oldest write is still present. A dropped oldest
write is a bug, not a trade-off.

3. Repeat with the browser's storage quota lowered enough to trigger a genuine
   `QuotaExceededError`. It must surface as `QueueFullError` too, not as an
   unhandled DOMException.

## 4. Safari eviction is not silent data loss

Safari clears an origin's IndexedDB after ~7 days without interaction. Verify by
inspection rather than by waiting a week:

1. Queue writes in Safari, quit, reopen, confirm they are still there.
2. Confirm the app's own UI would tell a user that queued work exists — the
   `queue.subscribe()` badge, not just a console log.

**Pass:** the app never claims "saved" with no visible pending state. Eviction is
unavoidable; silence about it is not.

## 5. FIFO holds under write-through

1. Online, healthy server.
2. Emit A, then immediately emit B without awaiting anything in between.
3. Watch the network panel.

**Pass:** A's request completes before B's begins, and the server receives them
in order. **Fail:** two in-flight requests, or B landing first — that means a
write bypassed the outbox, which is the ordering violation the design exists to
prevent.

---

## Recording a run

Note the date, browser + version, and the commit in the PR description. "Ran the
offline checklist" with no browser version is not a record — Safari and Chrome
differ on every one of the storage behaviours above.
