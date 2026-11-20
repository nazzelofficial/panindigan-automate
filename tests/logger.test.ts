/**
 * Logger tests — the console logger must behave for the library's own
 * child-logger pattern (module-scoped names, level gates, nested children)
 * and must never become the default. No assertions on rendered text —
 * output format is intentionally free to change.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MessengerClient } from "../src/index.js";
import { createRootLogger, ColorizedDestination } from "../src/index.js";
import { resolveConfig } from "../src/config/index.js";

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

  it("the built-in colorizer renders a pino JSON line with colors (no pino-pretty needed)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const dest = new ColorizedDestination();
    dest.write(JSON.stringify({
      level: 30,
      time: Date.now(),
      module: "mqtt",
      msg: "connected",
      region: "hil",
    }) + "\n");
    const output = spy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("connected");
    expect(output).toContain("hil");
    expect(output).toContain("mqtt");
    expect(output).toContain("\x1b["); // ANSI color codes present
  });

  it("fans out to both pretty and custom transports (multi-destination fix)", () => {
    const lines: string[] = [];
    const transport = { write: (line: string) => { lines.push(line); } };
    const logger = createRootLogger({ ...infoOpts, prettyPrint: true, transports: [transport] });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.info("fanned out");
    expect(lines.some((line) => line.includes("fanned out"))).toBe(true);
    expect(spy.mock.calls.map((c) => String(c[0])).join("")).toContain("fanned out");
  });
});

describe("Professional logging is the default on any host", () => {
  it("defaults to colorized output, not raw JSON", () => {
    expect(resolveConfig().prettyPrint).toBe(true);
  });

  it("keeps raw JSON available as an explicit opt-out", () => {
    expect(resolveConfig({ prettyPrint: false }).prettyPrint).toBe(false);
  });

  it("renders pino's ISO-string timestamp instead of an empty []", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const dest = new ColorizedDestination();
    dest.write(JSON.stringify({ level: 30, time: "2026-11-20T02:20:03.670Z", module: "mqtt", msg: "connected" }) + "\n");
    const output = spy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("02:20:03.670");
  });

  it("renders framed lifecycle panels with colored labels and values", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const dest = new ColorizedDestination();
    dest.write(JSON.stringify({
      level: 30,
      time: "2026-11-20T02:20:03.670Z",
      module: "mqtt",
      msg: "MQTT connection established",
      panel: {
        title: "MQTT CONNECTED",
        tone: "success",
        rows: [["Region", "hil"], ["Auto-reconnect", "Enabled"]],
        footer: "panindigan-automate",
      },
    }) + "\n");
    const output = spy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("MQTT CONNECTED");
    expect(output).toContain("╔");
    expect(output).toContain("╚");
    expect(output).toContain("Region");
    expect(output).toContain("hil");
    expect(output).toContain("\x1b[");
  });

  it("renders pino Error objects as one readable err= field", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const dest = new ColorizedDestination();
    dest.write(JSON.stringify({
      level: 40,
      time: Date.now(),
      module: "mqtt",
      msg: "MQTT client error",
      err: { type: "Error", message: "Invalid header flag bits, must be 0x0 for puback packet" },
    }) + "\n");
    const output = spy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Invalid header flag bits");
    expect(output).not.toContain('"type":"Error"');
  });
});
