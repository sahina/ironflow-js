import type { WebhookConfig, IronflowWebhook } from "@ironflow/core";

/**
 * Create a webhook source definition.
 *
 * @example
 * ```typescript
 * const stripeWebhook = createWebhook({
 *   id: "stripe",
 *   verify: (req) => {
 *     const sig = req.headers["stripe-signature"];
 *     return stripe.webhooks.constructEvent(req.body, sig, secret);
 *   },
 *   transform: (payload) => ({
 *     name: `stripe.${payload.type}`,
 *     data: payload.data.object,
 *     idempotencyKey: payload.id,
 *   }),
 * });
 * ```
 */
export function createWebhook(config: WebhookConfig): IronflowWebhook {
  return { config };
}
