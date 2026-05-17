/**
 * Basic Usage Example - @ironflow/browser
 *
 * This example demonstrates the basic usage patterns of the Ironflow browser SDK.
 * It covers configuration, subscriptions, and workflow operations.
 */

import { ironflow } from "@ironflow/browser";

// ============================================================================
// 1. CONFIGURATION
// ============================================================================

// Configure the singleton client at app startup
ironflow.configure({
  serverUrl: "http://localhost:9123",
  transport: "connectrpc", // 'connectrpc' (default) | 'websocket'
  reconnect: {
    enabled: true,
    maxAttempts: 10,
    backoff: { initial: 1000, max: 30000, multiplier: 2 },
  },
  visibility: {
    pauseOnHidden: true, // Pause subscriptions when tab is hidden
    reconnectOnVisible: true, // Reconnect when tab becomes visible
  },
});

// ============================================================================
// 2. SUBSCRIPTIONS
// ============================================================================

// Basic subscription to run events
const runSubscription = ironflow.subscribe("system.run.*", {
  onEvent: (event) => {
    console.log("Run event received:", event);
  },
  onError: (error) => {
    console.error("Subscription error:", error);
  },
  onStateChange: (state) => {
    console.log("Connection state:", state); // 'connecting' | 'connected' | 'disconnected'
  },
});

// Type-safe event subscription
interface OrderEvent {
  orderId: string;
  amount: number;
  status: "pending" | "completed" | "cancelled";
}

const orderSubscription = ironflow.subscribe<OrderEvent>("events:order.*", {
  onEvent: (event) => {
    // event.data is typed as OrderEvent
    console.log(`Order ${event.data.orderId}: ${event.data.status}`);
    console.log(`Amount: $${event.data.amount}`);
  },
});

// Subscribe to multiple patterns
const multiSubscription = ironflow.subscribe(
  ["system.run.*", "events:order.*", "events:payment.*"],
  {
    onEvent: (event) => {
      console.log("Multi-pattern event:", event);
    },
  }
);

// Subscription with advanced options
const advancedSubscription = ironflow.subscribe("events:*", {
  onEvent: (event) => {
    console.log("Event received:", event);
  },
  replay: 10, // Replay last 10 events on connect
  trackState: true, // Enable .lastEvent access
  filter: "event.data.amount > 100", // CEL filter
  buffer: {
    size: 100,
    strategy: "drop-oldest", // 'drop-oldest' | 'drop-newest' | 'block'
  },
});

// Access last event (when trackState is enabled)
console.log("Last event:", advancedSubscription.lastEvent);

// ============================================================================
// 3. SUBSCRIPTION GROUPS
// ============================================================================

// Group multiple subscriptions for batch management
const group = ironflow.subscriptionGroup();
group.add("system.run.abc123.*", { onEvent: (e) => console.log("Run:", e) });
group.add("events:payment.*", { onEvent: (e) => console.log("Payment:", e) });

// Later: unsubscribe all at once
// group.unsubscribeAll();

// ============================================================================
// 4. WORKFLOW OPERATIONS
// ============================================================================

// Trigger a workflow
interface ProcessOrderInput {
  orderId: string;
  items: { sku: string; quantity: number }[];
}

interface ProcessOrderOutput {
  success: boolean;
  receiptId: string;
  totalAmount: number;
}

async function invokeWorkflow() {
  const run = await ironflow.invoke<ProcessOrderInput, ProcessOrderOutput>(
    "process-order",
    {
      data: {
        orderId: "ORD-12345",
        items: [
          { sku: "WIDGET-A", quantity: 2 },
          { sku: "GADGET-B", quantity: 1 },
        ],
      },
    }
  );

  console.log("Workflow triggered:", run.id);
  console.log("Status:", run.status);
}

// Get run status
async function checkRunStatus(runId: string) {
  const run = await ironflow.getRun(runId);
  console.log(`Run ${run.id}:`);
  console.log(`  Status: ${run.status}`);
  console.log(`  Function: ${run.functionId}`);
  if (run.output) {
    console.log(`  Output:`, run.output);
  }
}

// List runs with filters
async function listRecentRuns() {
  const runs = await ironflow.listRuns({
    functionId: "process-order",
    status: "running",
    limit: 50,
  });

  console.log(`Found ${runs.length} running workflows`);
  for (const run of runs) {
    console.log(`  - ${run.id}: started at ${run.startedAt}`);
  }
}

// Cancel a run
async function cancelRun(runId: string) {
  await ironflow.cancelRun(runId);
  console.log(`Run ${runId} cancelled`);
}

// ============================================================================
// 5. EVENT EMISSION
// ============================================================================

// Emit events to trigger waitForEvent in workflows
async function approveOrder(orderId: string, approvedBy: string) {
  await ironflow.emit("order.approved", {
    orderId,
    approvedBy,
    approvedAt: new Date().toISOString(),
  });
  console.log(`Order ${orderId} approved by ${approvedBy}`);
}

// ============================================================================
// 6. CONNECTION MANAGEMENT
// ============================================================================

// Global connection state listener
ironflow.onConnectionChange((state) => {
  console.log("Global connection state:", state);
  if (state === "disconnected") {
    // Show reconnecting banner in UI
  } else if (state === "connected") {
    // Hide reconnecting banner
  }
});

// Manual connection control
async function manualConnect() {
  await ironflow.connect();
}

function manualDisconnect() {
  ironflow.disconnect();
}

// ============================================================================
// 7. CLEANUP
// ============================================================================

// Unsubscribe when no longer needed
function cleanup() {
  runSubscription.unsubscribe();
  orderSubscription.unsubscribe();
  multiSubscription.unsubscribe();
  advancedSubscription.unsubscribe();
  group.unsubscribeAll();
}

// Export for demonstration
export {
  triggerWorkflow,
  checkRunStatus,
  listRecentRuns,
  cancelRun,
  approveOrder,
  manualConnect,
  manualDisconnect,
  cleanup,
};
