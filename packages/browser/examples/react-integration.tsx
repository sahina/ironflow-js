/**
 * React Integration Example - @ironflow/browser
 *
 * This example demonstrates how to integrate Ironflow with React applications.
 * Note: This is a reference implementation - @ironflow/react adapter is planned for future.
 */

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { ironflow, type IronflowEvent, type ConnectionState } from "@ironflow/browser";

// ============================================================================
// 1. CONFIGURATION AT APP ROOT
// ============================================================================

export function IronflowProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Configure once at app startup
    ironflow.configure({
      serverUrl: import.meta.env.VITE_IRONFLOW_URL || "http://localhost:9123",
      transport: "connectrpc",
      reconnect: { enabled: true },
      visibility: { pauseOnHidden: true, reconnectOnVisible: true },
    });

    // Connect when app mounts
    ironflow.connect();

    // Cleanup when app unmounts
    return () => {
      ironflow.disconnect();
    };
  }, []);

  return <>{children}</>;
}

// ============================================================================
// 2. CONNECTION STATUS HOOK
// ============================================================================

export function useConnectionStatus() {
  const [status, setStatus] = useState<ConnectionState>("disconnected");

  useEffect(() => {
    const unsubscribe = ironflow.onConnectionChange(setStatus);
    return unsubscribe;
  }, []);

  return status;
}

// Connection status indicator component
export function ConnectionIndicator() {
  const status = useConnectionStatus();

  const statusConfig = {
    connected: { color: "green", text: "Connected" },
    connecting: { color: "yellow", text: "Connecting..." },
    disconnected: { color: "red", text: "Disconnected" },
  };

  const config = statusConfig[status];

  return (
    <div className={`connection-indicator ${status}`}>
      <span className={`dot bg-${config.color}-500`} />
      <span>{config.text}</span>
    </div>
  );
}

// ============================================================================
// 3. SUBSCRIPTION HOOK
// ============================================================================

interface UseSubscriptionOptions<T> {
  pattern: string | string[];
  onEvent?: (event: IronflowEvent<T>) => void;
  replay?: number;
  filter?: string;
}

export function useSubscription<T = unknown>(options: UseSubscriptionOptions<T>) {
  const [events, setEvents] = useState<IronflowEvent<T>[]>([]);
  const [lastEvent, setLastEvent] = useState<IronflowEvent<T> | undefined>();
  const [error, setError] = useState<Error | undefined>();

  const { pattern, onEvent, replay, filter } = options;

  // Memoize pattern for stability
  const patternKey = useMemo(
    () => (Array.isArray(pattern) ? pattern.join(",") : pattern),
    [pattern]
  );

  useEffect(() => {
    const subscription = ironflow.subscribe<T>(pattern, {
      onEvent: (event) => {
        setLastEvent(event);
        setEvents((prev) => [...prev, event]);
        onEvent?.(event);
      },
      onError: setError,
      replay,
      filter,
      trackState: true,
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [patternKey, replay, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearEvents = useCallback(() => {
    setEvents([]);
    setLastEvent(undefined);
  }, []);

  return { events, lastEvent, error, clearEvents };
}

// ============================================================================
// 4. WORKFLOW TRIGGER HOOK
// ============================================================================

interface UseTriggerResult<TOutput> {
  trigger: () => Promise<void>;
  isLoading: boolean;
  error: Error | undefined;
  run: { id: string; status: string; output?: TOutput } | undefined;
}

export function useTrigger<TInput, TOutput>(
  functionId: string,
  data: TInput
): UseTriggerResult<TOutput> {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error>();
  const [run, setRun] = useState<{ id: string; status: string; output?: TOutput }>();

  const trigger = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);

    try {
      const result = await ironflow.invoke<TInput, TOutput>(functionId, { data });
      setRun({
        id: result.id,
        status: result.status,
        output: result.output as TOutput | undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [functionId, data]);

  return { trigger, isLoading, error, run };
}

// ============================================================================
// 5. RUN STATUS HOOK
// ============================================================================

export function useRunStatus(runId: string | undefined) {
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<Error>();

  // Subscribe to run events
  useEffect(() => {
    if (!runId) return;

    const subscription = ironflow.subscribe(`system.run.${runId}.*`, {
      onEvent: (event) => {
        if (event.data && typeof event.data === "object" && "status" in event.data) {
          setStatus(event.data.status as string);
        }
      },
      onError: setError,
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [runId]);

  return { status, error };
}

// ============================================================================
// 6. EXAMPLE COMPONENTS
// ============================================================================

// Order events list component
interface OrderEvent {
  orderId: string;
  status: string;
  amount: number;
}

export function OrderEventsList() {
  const { events, lastEvent, error, clearEvents } = useSubscription<OrderEvent>({
    pattern: "events:order.*",
    replay: 10,
  });

  if (error) {
    return <div className="error">Error: {error.message}</div>;
  }

  return (
    <div className="order-events">
      <div className="header">
        <h3>Order Events</h3>
        <button onClick={clearEvents}>Clear</button>
      </div>
      {lastEvent && (
        <div className="last-event">
          Latest: Order {lastEvent.data.orderId} - {lastEvent.data.status}
        </div>
      )}
      <ul>
        {events.map((event, i) => (
          <li key={`${event.id}-${i}`}>
            <span className="order-id">{event.data.orderId}</span>
            <span className="status">{event.data.status}</span>
            <span className="amount">${event.data.amount}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Workflow trigger button component
interface ProcessOrderInput {
  orderId: string;
  items: { sku: string; quantity: number }[];
}

interface ProcessOrderOutput {
  success: boolean;
  receiptId: string;
}

export function TriggerWorkflowButton() {
  const orderData: ProcessOrderInput = useMemo(
    () => ({
      orderId: `ORD-${Date.now()}`,
      items: [{ sku: "WIDGET-A", quantity: 1 }],
    }),
    []
  );

  const { trigger, isLoading, error, run } = useTrigger<
    ProcessOrderInput,
    ProcessOrderOutput
  >("process-order", orderData);

  return (
    <div className="trigger-workflow">
      <button onClick={trigger} disabled={isLoading}>
        {isLoading ? "Processing..." : "Process Order"}
      </button>
      {error && <p className="error">{error.message}</p>}
      {run && (
        <p className="success">
          Workflow started: {run.id} (Status: {run.status})
        </p>
      )}
    </div>
  );
}

// Run status tracker component
export function RunStatusTracker({ runId }: { runId: string }) {
  const { status, error } = useRunStatus(runId);

  if (error) {
    return <div className="error">Error tracking run: {error.message}</div>;
  }

  return (
    <div className="run-status">
      <strong>Run {runId}:</strong> {status || "Unknown"}
    </div>
  );
}

// ============================================================================
// 7. FULL EXAMPLE APP
// ============================================================================

export function App() {
  return (
    <IronflowProvider>
      <div className="app">
        <header>
          <h1>Ironflow React Example</h1>
          <ConnectionIndicator />
        </header>

        <main>
          <section>
            <h2>Trigger Workflow</h2>
            <TriggerWorkflowButton />
          </section>

          <section>
            <h2>Order Events</h2>
            <OrderEventsList />
          </section>
        </main>
      </div>
    </IronflowProvider>
  );
}

export default App;
