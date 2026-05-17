// sdk/js/node/src/projection.ts

import type {
  ProjectionConfig,
  IronflowProjection,
} from "@ironflow/core";
import { ValidationError } from "@ironflow/core";

/**
 * Create a projection definition.
 *
 * Projections subscribe to event streams and maintain derived state (managed mode)
 * or trigger side effects (external mode).
 *
 * Mode is auto-detected from the presence of `initialState`:
 * - If `initialState` is provided, mode defaults to "managed"
 * - If `initialState` is absent, mode defaults to "external"
 *
 * @example
 * ```typescript
 * // Managed projection (maintains state)
 * const orderTotals = createProjection({
 *   name: "order-totals",
 *   events: ["order.created", "order.updated"],
 *   initialState: () => ({ total: 0, count: 0 }),
 *   handler: (state, event) => ({
 *     total: state.total + event.data.amount,
 *     count: state.count + 1,
 *   }),
 * });
 *
 * // External projection (side effects)
 * const emailNotifier = createProjection({
 *   name: "email-notifier",
 *   events: ["order.completed"],
 *   handler: async (event, ctx) => {
 *     await sendEmail(event.data.email, "Order complete!");
 *   },
 * });
 * ```
 */
export function createProjection<TState = unknown, TEvent = unknown>(
  config: ProjectionConfig<TState, TEvent>
): IronflowProjection<TState, TEvent> {
  // Validate
  if (!config.name) {
    throw new ValidationError("Projection name is required");
  }
  if (!config.events || config.events.length === 0) {
    throw new ValidationError("Projection must subscribe to at least one event");
  }

  // Auto-detect mode
  const mode = config.mode ?? (config.initialState ? "managed" : "external");

  return {
    config: {
      ...config,
      mode,
      maxRetries: config.maxRetries ?? 3,
      batchSize: config.batchSize ?? 100,
    },
  };
}
