import { afterEach, describe, expect, it, vi } from "vitest";
import { warnAboutLongLivedBrowserKey } from "./config.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("warnAboutLongLivedBrowserKey", () => {
  it("warns about ifkey_ credentials in a development browser", () => {
    vi.stubGlobal("window", {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnAboutLongLivedBrowserKey({ apiKey: "ifkey_long_lived" });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("short-lived session token"),
    );
  });

  it("does not warn for a session token", () => {
    vi.stubGlobal("window", {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnAboutLongLivedBrowserKey({ token: "eyJ.session.jwt" });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn outside a browser", () => {
    vi.stubGlobal("window", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnAboutLongLivedBrowserKey({ apiKey: "ifkey_server_side" });

    expect(warn).not.toHaveBeenCalled();
  });
});
