/**
 * Process-wide SIGINT/SIGTERM handling for the pull workers.
 *
 * One listener serves every running worker, so the process exits one time,
 * after all of them have drained. A listener per worker exits when the first
 * worker has drained, and that kills the jobs of the other workers.
 */

type Drain = () => Promise<void>;

interface Registry {
  drains: Set<Drain>;
  onSignal: (signal: NodeJS.Signals) => void;
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

// The package ships each entry point as its own bundle, so createWorker and
// createStreamingWorker each load a copy of this module. A registry per copy
// would see the listener of the other copy as the app's and exit too early,
// so all copies share one registry on globalThis.
const KEY = Symbol.for("@ironflow/node/drain-on-signal");
const globals = globalThis as { [KEY]?: Registry };
const registry = (globals[KEY] ??= createRegistry());

function createRegistry(): Registry {
  const drains = new Set<Drain>();
  return {
    drains,
    onSignal(signal) {
      // Read the count now. Node removes a once-listener before it calls it,
      // so after the drain the count cannot show an app handler that is still
      // running. Our listener runs first and is already removed: each one left
      // is the app's.
      const appOwnsShutdown = process.listenerCount(signal) > 0;
      void Promise.allSettled([...drains].map((drain) => drain())).then(() => {
        // Our listener replaced Node's default exit-on-signal. A handler
        // cancelled at the drain deadline cannot be killed and keeps the event
        // loop alive, so exit here as Go's Run does — unless the app listens
        // too and owns shutdown.
        if (!appOwnsShutdown) process.exit();
      });
    },
  };
}

/**
 * Drain the worker on SIGINT and SIGTERM. Returns the function that removes
 * the worker again.
 */
export function drainOnSignal(drain: Drain): () => void {
  const { drains, onSignal } = registry;
  if (drains.size === 0) {
    for (const signal of SIGNALS) process.prependOnceListener(signal, onSignal);
  }
  drains.add(drain);
  return () => {
    drains.delete(drain);
    if (drains.size === 0) {
      for (const signal of SIGNALS) process.removeListener(signal, onSignal);
    }
  };
}
