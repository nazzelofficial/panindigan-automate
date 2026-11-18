/**
 * Small unit tests for the update checker's semver comparison, the safe
 * defaults of the automatic updater, and the diagnostics exports.
 * No real network — the registry fetch is stubbed globally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UPDATE_CONFIG,
  UpdateChecker,
  isOlder,
} from "../src/update/index.js";
import { DiagnosticsCollector } from "../src/diagnostics/index.js";
import { MemoryStorage } from "../src/storage/index.js";
import { createRootLogger } from "../src/logger/index.js";

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

describe("DEFAULT_UPDATE_CONFIG", () => {
  it("runs checks and auto-installs by default (opt-out defaults)", () => {
    // Maintainer decision: automatic updates are ON by default since 0.2.0.
    // Consumers opt out with update.enabled: false (disable) or
    // update.autoInstall: false (announce-only).
    expect(DEFAULT_UPDATE_CONFIG.enabled).toBe(true);
    expect(DEFAULT_UPDATE_CONFIG.autoInstall).toBe(true);
    expect(DEFAULT_UPDATE_CONFIG.allowPrerelease).toBe(false);
    expect(DEFAULT_UPDATE_CONFIG.checkOnStartup).toBe(true);
  });
});

describe("automatic update checker (stubbed registry)", () => {
  const silent = () => createRootLogger({ level: "silent", transports: [] });

  const registryResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("announces an available update without installing anything when autoInstall is false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        registryResponse({
          name: "panindigan-automate",
          version: "9.9.9",
          dist: { tarball: "https://example.invalid/x.tgz" },
          time: { "9.9.9": "2026-11-18T00:00:00.000Z" },
        }),
      ),
    );
    const storage = new MemoryStorage();
    const checker = new UpdateChecker({
      options: { enabled: true, autoInstall: false },
      logger: silent(),
      storage,
      version: "0.0.1",
    });

    const result = await checker.checkForUpdates();

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("9.9.9");
    expect(result.updateType).toBe("major");
    expect(checker.getStatus().installationStatus).toBe("available");
    expect(checker.getStatus().restartRequired).toBe(false);
  });

  it("ignores a prerelease when allowPrerelease is false (default)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        registryResponse({
          name: "panindigan-automate",
          version: "9.9.9-rc.1",
          dist: { tarball: "https://example.invalid/x.tgz" },
          time: { "9.9.9-rc.1": "2026-11-18T00:00:00.000Z" },
        }),
      ),
    );
    const storage = new MemoryStorage();
    const checker = new UpdateChecker({
      options: { enabled: true, autoInstall: false },
      logger: silent(),
      storage,
      version: "0.0.1",
    });

    const result = await checker.checkForUpdates();

    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBeNull();
    expect(checker.getStatus().installationStatus).toBe("idle");
  });

  it("considers the prerelease when allowPrerelease is true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        registryResponse({
          name: "panindigan-automate",
          version: "9.9.9-rc.1",
          dist: { tarball: "https://example.invalid/x.tgz" },
          time: { "9.9.9-rc.1": "2026-11-18T00:00:00.000Z" },
        }),
      ),
    );
    const storage = new MemoryStorage();
    const checker = new UpdateChecker({
      options: { enabled: true, allowPrerelease: true, autoInstall: false },
      logger: silent(),
      storage,
      version: "0.0.1",
    });

    const result = await checker.checkForUpdates();

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("9.9.9-rc.1");
  });

  it("checks the registry on client construction when enabled (default)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        registryResponse({
          name: "panindigan-automate",
          version: "9.9.9",
          dist: { tarball: "https://example.invalid/x.tgz" },
          time: { "9.9.9": "2026-11-18T00:00:00.000Z" },
        }),
      ),
    );

    const { MessengerClient } = await import("../src/index.js");
    const client = new MessengerClient({ update: { autoInstall: false } });

    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (client.getUpdateStatus()?.installationStatus === "available") break;
    }

    const status = client.getUpdateStatus();
    expect(status?.installationStatus).toBe("available");
    expect(status?.latestVersion).toBe("9.9.9");
    client.update.stop();
  }, 15_000);

  it("makes no network call when the user sets update.enabled=false", async () => {
    // Test the UpdateChecker directly (not via MessengerClient) so the
    // assertion is hermetic — ES module caching means MessengerClient is
    // shared across tests in this file, and a prior test's client may
    // still have an in-flight fetch when this test's fetchMock lands.
    const fetchMock = vi.fn(async () =>
      registryResponse({ version: "9.9.9", dist: {}, time: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const storage = new MemoryStorage();
    const checker = new UpdateChecker({
      options: { enabled: false },
      logger: silent(),
      storage,
      version: "0.2.4",
    });

    // Even calling initialize() should be a no-op when disabled.
    await checker.initialize();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    checker.stop();
  });

  it("reports up-to-date when the installed version is newer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        registryResponse({
          name: "panindigan-automate",
          version: "0.0.1",
          dist: { tarball: "https://example.invalid/x.tgz" },
          time: { "0.0.1": "2026-11-18T00:00:00.000Z" },
        }),
      ),
    );
    const storage = new MemoryStorage();
    const checker = new UpdateChecker({
      options: { enabled: true, autoInstall: false },
      logger: silent(),
      storage,
      version: "9.9.9",
    });

    const result = await checker.checkForUpdates();

    expect(result.updateAvailable).toBe(false);
    expect(result.updateType).toBe("none");
    expect(checker.getStatus().installationStatus).toBe("idle");
  });

  it("returns null without touching the registry when disabled", async () => {
    const fetchMock = vi.fn(async () =>
      registryResponse({ version: "9.9.9", dist: {}, time: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const storage = new MemoryStorage();
    const checker = new UpdateChecker({
      options: { enabled: false },
      logger: silent(),
      storage,
      version: "0.0.1",
    });

    const info = await checker.check();

    expect(info).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
