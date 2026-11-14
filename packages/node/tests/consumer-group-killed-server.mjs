import * as http2 from "node:http2";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  AckMode,
  ConsumerGroupJoinedSchema,
  PubSubService,
  SubscribeBidirectionalResponseSchema,
  SubscriptionEventSchema,
} from "@ironflow/core/gen";

const [port, generation] = process.argv.slice(2);
const member = `member-${generation}`;

const handler = connectNodeAdapter({
  routes(router) {
    router.service(PubSubService, {
      async *subscribeBidirectional(requests, ctx) {
        for await (const req of requests) {
          if (req.payload.case !== "join") continue;
          yield create(SubscribeBidirectionalResponseSchema, {
            payload: {
              case: "joined",
              value: create(ConsumerGroupJoinedSchema, {
                subscriptionId: member,
                groupName: req.payload.value.groupName,
                pattern: "topic:orders",
                ackMode: AckMode.MANUAL,
              }),
            },
          });
          yield create(SubscribeBidirectionalResponseSchema, {
            payload: {
              case: "event",
              value: create(SubscriptionEventSchema, {
                subscriptionId: member,
                eventId: `evt-gen-${generation}`,
                topic: "orders",
              }),
            },
          });
          break;
        }
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
      },
    });
  },
});

http2.createServer(handler).listen(Number(port), "127.0.0.1", () => console.log("ready"));
