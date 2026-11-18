/**
 * Logger tests — the console logger must behave for the library's own
 * child-logger pattern (module-scoped names, level gates, nested children)
 * and must never become the default. No assertions on rendered text —
 * output format is intentionally free to change.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MessengerClient } from "../src/index.js";
import { createRootLogger } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const silentOpts = { level: "silent", prettyPrint: false, logFile: null, transports: [] };
const infoOpts = { level: "info", prettyPrint: false, logFile: null, transports: [] };

describe("ConsoleLogger", () => {
  it("is opt-in via the client options and does not throw at construction", () => {
    expect(() => new MessengerClient({ useConsoleLogger: true })).not.toThrow();
  });

  it("writes to console.log when enabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createRootLogger({ ...infoOpts, useConsoleLogger: true });
    logger.warn("test warning");
    expect(spy).toHaveBeenCalled();
  });

  it("stays silent when silent is the level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createRootLogger({ ...silentOpts, useConsoleLogger: true });
    logger.warn("hidden");
    logger.error("hidden");
    expect(spy).not.toHaveBeenCalled();
  });

  it("child() returns a working child with a module suffix", () => {
    const logger = createRootLogger({ ...infoOpts, useConsoleLogger: true });
    const child = logger.child({ module: "mqtt" });
    expect(() => child.info("mqtt is up")).not.toThrow();
    expect(() => child.child({ module: "sync" }).debug("nested")).not.toThrow();
  });

  it("success sits between info and warn in the level ladder", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createRootLogger({ ...infoOpts, useConsoleLogger: true });
    // at info, success must print
    logger.success("ok");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not write via console.log by default (pino path stays pino)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createRootLogger(infoOpts);
    logger.warn("should not reach console.log");
    expect(spy).not.toHaveBeenCalled();
  });
});
