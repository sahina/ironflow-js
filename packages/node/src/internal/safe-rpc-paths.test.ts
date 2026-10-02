import { expect, it } from "vitest";
import type { DescService } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import * as gen from "../../../core/src/gen/index.js";
import { SAFE_RPC_PATHS } from "./safe-rpc-paths.js";

it("lists exactly the RPCs the protos mark NO_SIDE_EFFECTS", () => {
  const fromProto = (Object.values(gen) as unknown[])
    .filter((v): v is DescService => (v as DescService | undefined)?.kind === "service")
    .flatMap((service) =>
      service.methods
        .filter((m) => m.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS)
        .map((m) => `/${service.typeName}/${m.name}`)
    );

  expect(fromProto.length).toBeGreaterThan(0);
  // On a mismatch, copy the proto-derived list into safe-rpc-paths.ts.
  expect([...SAFE_RPC_PATHS].sort()).toEqual(fromProto.sort());
});
