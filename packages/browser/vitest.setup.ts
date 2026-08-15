/**
 * Vitest setup for @ironflow/browser.
 *
 * jsdom ships no `indexedDB` and no `navigator.locks`, so the offline write
 * queue (ADR 0052) has no test environment out of the box. This file supplies
 * IndexedDB via fake-indexeddb and gives each test file a clean database.
 *
 * `navigator.locks` is deliberately NOT shimmed here. The queue reaches it
 * through `withFlushLock()`, whose no-locks branch is the real Safari < 16
 * code path — leaving the global absent means the fallback is what the default
 * test run exercises. Tests that want the Web Locks branch stub it explicitly.
 */
import { beforeEach } from "vitest";
import { IDBFactory, IDBKeyRange as FDBKeyRange } from "fake-indexeddb";

// A fresh factory per test file, plus a reset between tests, so no queue state
// leaks across cases. Assigning a new IDBFactory is fake-indexeddb's documented
// way to drop every database at once.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = FDBKeyRange as unknown as typeof IDBKeyRange;
});
