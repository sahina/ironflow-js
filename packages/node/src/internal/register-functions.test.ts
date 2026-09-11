import { describe, expect, it, vi, afterEach } from "vitest";
import { registerFunctions } from "./register-functions.js";

describe("registerFunctions recording profiles", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a profile-only configuration without the legacy boolean", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response("{}", { status: 200 });
      }),
    );

    await registerFunctions({
      baseUrl: "http://localhost:9123",
      functions: new Map([
        [
          "fn-profile",
          {
            config: {
              id: "fn-profile",
              triggers: [],
              recordingProfile: "run_lifecycle",
            },
            handler: async () => undefined,
          } as never,
        ],
      ]),
      headers: {},
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(body?.recordingProfile).toBe("run_lifecycle");
    expect(body).not.toHaveProperty("recording");
  });
});
