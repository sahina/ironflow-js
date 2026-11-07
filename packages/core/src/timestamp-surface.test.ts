import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ADR 0165: a timestamp a client returns is a Date. These owners are the
// exceptions it names: raw payloads nothing decodes, and exact values or inputs
// that go back to the server as strings.
const ALLOWED_OWNERS = new Set([
  "DisableWebhookSignatureVerificationInput",
  "PushRequest",
  "RotateWebhookSecretInput",
  "RunEvent",
  "SchemaWire",
  "SleepYield",
  "StepResult",
  "UpdateWebhookSourceInput",
  // Wire normalizers. Each client decodes their output again, and the dashboard renders strings.
  "projectionInspectionFromWire",
  "projectionRegistryFromWire",
  "runInspectionFromWire",
  "stepInspectionFromWire",
]);

const TIMESTAMP_FIELD = /^\s*(\w*(?:At|_at|Timestamp|timestamp|_time|Time|Until|until|Since|since|_expiry))\??: string\b/;
const OWNER = /^(?:export )?(?:declare )?(?:interface|class|function|const|type) (\w+)/;

function stringTimestamps(report: string): string[] {
  const found: string[] = [];
  let owner = "";
  for (const line of report.split("\n")) {
    owner = OWNER.exec(line)?.[1] ?? owner;
    const field = TIMESTAMP_FIELD.exec(line)?.[1];
    if (field && !ALLOWED_OWNERS.has(owner)) found.push(`${owner}.${field}`);
  }
  return found;
}

describe("published timestamp types", () => {
  it.each(["core", "node", "browser"])("%s returns no string timestamp", (pkg) => {
    const report = readFileSync(new URL(`../../../../api-surface/ts/${pkg}.api.md`, import.meta.url), "utf8");
    expect(stringTimestamps(report)).toEqual([]);
  });

  it("flags a string timestamp on any other type", () => {
    expect(stringTimestamps("export interface Foo {\n    createdAt: string;\n}\n")).toEqual(["Foo.createdAt"]);
    expect(stringTimestamps("export interface Foo {\n    createdAt: Date;\n    updatedAtExact: string;\n}\n")).toEqual([]);
  });
});
