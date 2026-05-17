/**
 * Function definition helper for Ironflow workflows
 */

import type {
  FunctionConfig,
  FunctionHandler,
  IronflowFunction,
} from "@ironflow/core";
import type { z } from "zod";

/**
 * Function definition helper with full type inference
 *
 * @example
 * ```typescript
 * import { ironflow } from "@ironflow/node";
 * import { z } from "zod";
 *
 * const processOrder = ironflow.createFunction(
 *   {
 *     id: "process-order",
 *     triggers: [{ event: "order.placed" }],
 *     schema: z.object({
 *       orderId: z.string(),
 *       amount: z.number(),
 *     }),
 *   },
 *   async ({ event, step }) => {
 *     // event.data is typed as { orderId: string, amount: number }
 *     const result = await step.run("process", async () => {
 *       return { processed: true };
 *     });
 *     return result;
 *   }
 * );
 * ```
 */
export function createFunction<
  TEventSchema extends z.ZodType = z.ZodType<unknown>,
  TResult = unknown,
>(
  config: FunctionConfig<TEventSchema>,
  handler: FunctionHandler<z.infer<TEventSchema>, TResult>
): IronflowFunction<z.infer<TEventSchema>, TResult> {
  if (config.cancelOn?.length) {
    const seen = new Set<string>();
    config.cancelOn.forEach((spec, i) => {
      if (!spec.event) {
        throw new Error(
          `createFunction(${config.id}): cancelOn[${i}].event must be non-empty`
        );
      }
      if (!spec.match) {
        throw new Error(
          `createFunction(${config.id}): cancelOn[${i}].match must be non-empty`
        );
      }
      const key = `${spec.event}|${spec.match}`;
      if (seen.has(key)) {
        throw new Error(
          `createFunction(${config.id}): cancelOn[${i}] duplicate spec (event="${spec.event}", match="${spec.match}")`
        );
      }
      seen.add(key);
    });
  }

  return {
    config,
    handler,
  } as IronflowFunction<z.infer<TEventSchema>, TResult>;
}

/**
 * Ironflow function factory singleton
 *
 * @example
 * ```typescript
 * import { ironflow } from "@ironflow/node";
 *
 * const myFunction = ironflow.createFunction(
 *   { id: "my-function", triggers: [{ event: "my.event" }] },
 *   async ({ event, step }) => {
 *     // ...
 *   }
 * );
 * ```
 */
export const ironflow = {
  createFunction,
};

export default ironflow;
