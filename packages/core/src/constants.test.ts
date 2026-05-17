import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_SERVER_URL,
  DEFAULT_WS_URL,
  DEFAULT_TIMEOUTS,
  DEFAULT_RETRY,
  DEFAULT_CLIENT_RETRY,
  DEFAULT_WORKER,
  DEFAULT_RECONNECT,
  ENV_VARS,
  getServerUrl,
  getWebSocketUrl,
  STEP_TYPES,
  STEP_STATUS,
  RUN_STATUS,
  WS_MESSAGE_TYPES,
  HTTP_HEADERS,
  JSON_HEADERS,
  ERROR_CODES,
  API_ENDPOINTS,
  TIMING,
  ACK_TYPES,
} from "./constants.js";

describe("Default Constants", () => {
  describe("Server Defaults", () => {
    it("should have correct default port", () => {
      expect(DEFAULT_PORT).toBe(9123);
    });

    it("should have correct default host", () => {
      expect(DEFAULT_HOST).toBe("localhost");
    });

    it("should have correct default server URL", () => {
      expect(DEFAULT_SERVER_URL).toBe("http://localhost:9123");
    });

    it("should have correct default WebSocket URL", () => {
      expect(DEFAULT_WS_URL).toBe("ws://localhost:9123/ws");
    });
  });

  describe("DEFAULT_TIMEOUTS", () => {
    it("should have CLIENT timeout of 30 seconds", () => {
      expect(DEFAULT_TIMEOUTS.CLIENT).toBe(30_000);
    });

    it("should have FUNCTION timeout of 10 minutes", () => {
      expect(DEFAULT_TIMEOUTS.FUNCTION).toBe(600_000);
    });

    it("should have TRIGGER_SYNC timeout of 30 seconds", () => {
      expect(DEFAULT_TIMEOUTS.TRIGGER_SYNC).toBe(30_000);
    });
  });

  describe("DEFAULT_RETRY", () => {
    it("should have MAX_ATTEMPTS of 3", () => {
      expect(DEFAULT_RETRY.MAX_ATTEMPTS).toBe(3);
    });

    it("should have INITIAL_DELAY_MS of 1000", () => {
      expect(DEFAULT_RETRY.INITIAL_DELAY_MS).toBe(1000);
    });

    it("should have BACKOFF_FACTOR of 2.0", () => {
      expect(DEFAULT_RETRY.BACKOFF_FACTOR).toBe(2.0);
    });

    it("should have MAX_DELAY_MS of 5 minutes", () => {
      expect(DEFAULT_RETRY.MAX_DELAY_MS).toBe(300_000);
    });
  });

  describe("DEFAULT_CLIENT_RETRY", () => {
    it("should have correct retry configuration", () => {
      expect(DEFAULT_CLIENT_RETRY.MAX_ATTEMPTS).toBe(3);
      expect(DEFAULT_CLIENT_RETRY.INITIAL_DELAY_MS).toBe(100);
      expect(DEFAULT_CLIENT_RETRY.BACKOFF_MULTIPLIER).toBe(2.0);
      expect(DEFAULT_CLIENT_RETRY.MAX_DELAY_MS).toBe(10_000);
      expect(DEFAULT_CLIENT_RETRY.CONNECTION_RETRY_DELAY_MS).toBe(2_000);
    });
  });

  describe("DEFAULT_WORKER", () => {
    it("should have MAX_CONCURRENT_JOBS of 10", () => {
      expect(DEFAULT_WORKER.MAX_CONCURRENT_JOBS).toBe(10);
    });

    it("should have HEARTBEAT_INTERVAL_MS of 30 seconds", () => {
      expect(DEFAULT_WORKER.HEARTBEAT_INTERVAL_MS).toBe(30_000);
    });

    it("should have RECONNECT_DELAY_MS of 5 seconds", () => {
      expect(DEFAULT_WORKER.RECONNECT_DELAY_MS).toBe(5_000);
    });
  });

  describe("DEFAULT_RECONNECT", () => {
    it("should be enabled by default", () => {
      expect(DEFAULT_RECONNECT.ENABLED).toBe(true);
    });

    it("should have MAX_ATTEMPTS of 10", () => {
      expect(DEFAULT_RECONNECT.MAX_ATTEMPTS).toBe(10);
    });

    it("should have correct backoff settings", () => {
      expect(DEFAULT_RECONNECT.INITIAL_DELAY_MS).toBe(1_000);
      expect(DEFAULT_RECONNECT.MAX_DELAY_MS).toBe(30_000);
      expect(DEFAULT_RECONNECT.MULTIPLIER).toBe(2);
    });
  });
});

describe("ENV_VARS", () => {
  it("should have correct environment variable names", () => {
    expect(ENV_VARS.SERVER_URL).toBe("IRONFLOW_SERVER_URL");
    expect(ENV_VARS.SIGNING_KEY).toBe("IRONFLOW_SIGNING_KEY");
    expect(ENV_VARS.API_KEY).toBe("IRONFLOW_API_KEY");
    expect(ENV_VARS.LOG_LEVEL).toBe("IRONFLOW_LOG_LEVEL");
  });
});

describe("getServerUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.IRONFLOW_SERVER_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return default URL when env var is not set", () => {
    expect(getServerUrl()).toBe(DEFAULT_SERVER_URL);
  });

  it("should return env var value when set", () => {
    process.env.IRONFLOW_SERVER_URL = "https://custom.example.com";
    expect(getServerUrl()).toBe("https://custom.example.com");
  });
});

describe("getWebSocketUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.IRONFLOW_SERVER_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should convert http to ws and add /ws suffix", () => {
    expect(getWebSocketUrl("http://localhost:9123")).toBe(
      "ws://localhost:9123/ws"
    );
  });

  it("should convert https to wss and add /ws suffix", () => {
    expect(getWebSocketUrl("https://example.com")).toBe(
      "wss://example.com/ws"
    );
  });

  it("should just add /ws suffix if no protocol prefix", () => {
    expect(getWebSocketUrl("localhost:9123")).toBe("localhost:9123/ws");
  });

  it("should use getServerUrl when no argument provided", () => {
    const result = getWebSocketUrl();
    expect(result).toBe("ws://localhost:9123/ws");
  });

  it("should handle URLs with paths", () => {
    expect(getWebSocketUrl("http://example.com/api")).toBe(
      "ws://example.com/api/ws"
    );
  });
});

describe("Status Constants", () => {
  describe("STEP_TYPES", () => {
    it("should have correct step types", () => {
      expect(STEP_TYPES.INVOKE).toBe("invoke");
      expect(STEP_TYPES.SLEEP).toBe("sleep");
      expect(STEP_TYPES.WAIT_FOR_EVENT).toBe("wait_for_event");
    });
  });

  describe("STEP_STATUS", () => {
    it("should have correct step statuses", () => {
      expect(STEP_STATUS.COMPLETED).toBe("completed");
      expect(STEP_STATUS.FAILED).toBe("failed");
      expect(STEP_STATUS.WAITING).toBe("waiting");
    });
  });

  describe("RUN_STATUS", () => {
    it("should have correct run statuses", () => {
      expect(RUN_STATUS.PENDING).toBe("pending");
      expect(RUN_STATUS.RUNNING).toBe("running");
      expect(RUN_STATUS.COMPLETED).toBe("completed");
      expect(RUN_STATUS.FAILED).toBe("failed");
      expect(RUN_STATUS.CANCELLED).toBe("cancelled");
      expect(RUN_STATUS.PAUSED).toBe("paused");
    });
  });
});

describe("WebSocket Message Types", () => {
  it("should have correct message types", () => {
    expect(WS_MESSAGE_TYPES.SUBSCRIBE).toBe("subscribe");
    expect(WS_MESSAGE_TYPES.UNSUBSCRIBE).toBe("unsubscribe");
    expect(WS_MESSAGE_TYPES.ACK).toBe("ack");
    expect(WS_MESSAGE_TYPES.EVENT).toBe("event");
    expect(WS_MESSAGE_TYPES.SUBSCRIPTION_RESULT).toBe("subscription_result");
    expect(WS_MESSAGE_TYPES.SUBSCRIPTION_ERROR).toBe("subscription_error");
    expect(WS_MESSAGE_TYPES.ERROR).toBe("error");
  });
});

describe("HTTP Constants", () => {
  describe("HTTP_HEADERS", () => {
    it("should have correct content type", () => {
      expect(HTTP_HEADERS.CONTENT_TYPE_JSON).toBe("application/json");
    });
  });

  describe("JSON_HEADERS", () => {
    it("should have Content-Type header set to JSON", () => {
      expect(JSON_HEADERS["Content-Type"]).toBe("application/json");
    });
  });
});

describe("ERROR_CODES", () => {
  it("should have all expected error codes", () => {
    expect(ERROR_CODES.FUNCTION_NOT_FOUND).toBe("FUNCTION_NOT_FOUND");
    expect(ERROR_CODES.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(ERROR_CODES.SIGNATURE_INVALID).toBe("SIGNATURE_INVALID");
    expect(ERROR_CODES.NETWORK_ERROR).toBe("NETWORK_ERROR");
    expect(ERROR_CODES.SERVER_ERROR).toBe("SERVER_ERROR");
    expect(ERROR_CODES.TIMEOUT_ERROR).toBe("TIMEOUT_ERROR");
    expect(ERROR_CODES.CONNECTION_LOST).toBe("CONNECTION_LOST");
    expect(ERROR_CODES.CONNECTION_REFUSED).toBe("CONNECTION_REFUSED");
    expect(ERROR_CODES.SUBSCRIPTION_ERROR).toBe("SUBSCRIPTION_ERROR");
    expect(ERROR_CODES.NOT_CONFIGURED).toBe("NOT_CONFIGURED");
  });
});

describe("API_ENDPOINTS", () => {
  it("should have correct IronflowService endpoints", () => {
    expect(API_ENDPOINTS.TRIGGER).toBe("/ironflow.v1.IronflowService/Trigger");
    expect(API_ENDPOINTS.TRIGGER_SYNC).toBe(
      "/ironflow.v1.IronflowService/TriggerSync"
    );
    expect(API_ENDPOINTS.GET_RUN).toBe("/ironflow.v1.IronflowService/GetRun");
    expect(API_ENDPOINTS.LIST_RUNS).toBe(
      "/ironflow.v1.IronflowService/ListRuns"
    );
    expect(API_ENDPOINTS.CANCEL_RUN).toBe(
      "/ironflow.v1.IronflowService/CancelRun"
    );
    expect(API_ENDPOINTS.RETRY_RUN).toBe(
      "/ironflow.v1.IronflowService/RetryRun"
    );
    expect(API_ENDPOINTS.REGISTER_FUNCTION).toBe(
      "/ironflow.v1.IronflowService/RegisterFunction"
    );
    expect(API_ENDPOINTS.HEALTH).toBe("/ironflow.v1.IronflowService/Health");
  });

  it("should have correct PubSubService endpoints", () => {
    expect(API_ENDPOINTS.EMIT).toBe("/ironflow.v1.PubSubService/Emit");
    expect(API_ENDPOINTS.CREATE_CONSUMER_GROUP).toBe(
      "/ironflow.v1.PubSubService/CreateConsumerGroup"
    );
    expect(API_ENDPOINTS.GET_CONSUMER_GROUP).toBe(
      "/ironflow.v1.PubSubService/GetConsumerGroup"
    );
    expect(API_ENDPOINTS.LIST_CONSUMER_GROUPS).toBe(
      "/ironflow.v1.PubSubService/ListConsumerGroups"
    );
    expect(API_ENDPOINTS.DELETE_CONSUMER_GROUP).toBe(
      "/ironflow.v1.PubSubService/DeleteConsumerGroup"
    );
  });
});

describe("TIMING Constants", () => {
  it("should have correct timing values", () => {
    expect(TIMING.POLL_INTERVAL_MS).toBe(1000);
    expect(TIMING.ERROR_RETRY_DELAY_MS).toBe(5000);
    expect(TIMING.RECONNECT_DELAY_MS).toBe(1000);
    expect(TIMING.WS_CLOSE_NORMAL).toBe(1000);
  });
});

describe("ACK_TYPES", () => {
  it("should have correct ack type values", () => {
    expect(ACK_TYPES.ACK).toBe("ack");
    expect(ACK_TYPES.NAK).toBe("nak");
    expect(ACK_TYPES.TERM).toBe("term");
  });
});
