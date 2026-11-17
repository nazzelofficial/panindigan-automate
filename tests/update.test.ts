/**
 * Small unit tests for the update checker's semver comparison and the
 * diagnostics exports. No network, no filesystem.
 */

import { describe, expect, it } from "vitest";
import { isOlder } from "../src/update/index.js";
import { DiagnosticsCollector } from "../src/diagnostics/index.js";

describe("isOlder", () => {
  it("detects older versions", () => {
    expect(isOlder("0.1.6", "0.1.7")).toBe(true);
    expect(isOlder("0.1.5", "0.1.7")).toBe(true);
    expect(isOlder("0.9.0", "1.0.0")).toBe(true);
    expect(isOlder("0.1.0", "0.10.0")).toBe(true);
  });

  it("rejects equal or newer versions", () => {
    expect(isOlder("0.1.7", "0.1.7")).toBe(false);
    expect(isOlder("0.1.9", "0.1.7")).toBe(false);
    expect(isOlder("1.0.0", "0.9.9")).toBe(false);
    expect(isOlder("0.2.0", "0.10.0")).toBe(true);
  });

  it("tolerates a leading v prefix", () => {
    expect(isOlder("v0.1.6", "v0.1.7")).toBe(true);
    expect(isOlder("v0.1.7", "0.1.7")).toBe(false);
  });
});

describe("diagnostics exports", () => {
  it("exportJSON produces parseable JSON with the expected sections", () => {
    const collector = new DiagnosticsCollector();
    collector.recordHttpRequest({ succeeded: true, latencyMs: 42, bytesIn: 100 });

    const parsed = JSON.parse(collector.exportJSON()) as Record<string, unknown>;
    expect(parsed["http"]).toBeDefined();
    expect(parsed["mqtt"]).toBeDefined();
    expect(parsed["process"]).toBeDefined();
    expect((parsed["http"] as { requests: { total: number } }).requests.total).toBe(1);
  });

  it("exportHTML contains a self-contained report without external assets", () => {
    const collector = new DiagnosticsCollector();
    const html = collector.exportHTML();

    expect(html).toContain("panindigan-automate");
    expect(html).toContain("diagnostics report");
    expect(html).not.toMatch(/https?:\/\/[^"'\s]+\.(?:css|js|png|svg)/);
  });

  it("getSnapshot() is JSON-serializable end to end", () => {
    const collector = new DiagnosticsCollector();
    collector.recordEvent("message");
    expect(() => JSON.stringify(collector.getSnapshot())).not.toThrow();
  });
});
