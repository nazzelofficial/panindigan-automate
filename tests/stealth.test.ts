/**
 * Stealth Guard behavior tests.
 *
 * Every test uses an in-memory storage adapter and tuned config values —
 * no timers, no network, fully deterministic.
 */

import { describe, expect, it } from "vitest";
import { createRootLogger } from "../src/logger/index.js";
import { MemoryStorage } from "../src/storage/index.js";
import { StealthGuard, DEFAULT_STEALTH_CONFIG } from "../src/stealth/index.js";
import type { SuspensionSignal } from "../src/stealth/index.js";
import { TokenBucket } from "../src/stealth/rate-limiter.js";

const logger = createRootLogger({ level: "silent", prettyPrint: false, logFile: null, transports: [] });

function makeGuard(config: Record<string, unknown> = {}) {
  const storage = new MemoryStorage();
  const guard = new StealthGuard({
    config: {
      enabled: true,
      signalThreshold: 2,
      signalWindow: 60_000,
      cooldownMs: 60_000,
      pacingEnabled: false,
      warmupEnabled: false,
      ...config,
    } as never,
    logger,
    storage,
  });
  return { guard, storage };
}

describe("Stealth Guard lifecycle logs", () => {
  it("announces initialization even on a fresh start with no stored state", async () => {
    const lines: string[] = [];
    const captureLogger = createRootLogger({
      level: "info",
      prettyPrint: false,
      logFile: null,
      transports: [{ write: (line) => lines.push(line) }],
    });
    const storage = new MemoryStorage();
    const guard = new StealthGuard({
      config: { enabled: true } as never,
      logger: captureLogger,
      storage,
    });

    await guard.initialize();

    expect(lines.join("\n")).toContain("Stealth Guard initialized");
  });
});

function signal(severity: SuspensionSignal["severity"], message = "sig"): SuspensionSignal {
  return {
    type: "test",
    severity,
    message,
    timestamp: Date.now(),
    context: {},
  };
}

describe("StealthGuard — caps and rate limits", () => {
  it("allows operations inside the per-thread cap and rejects beyond it", () => {
    const { guard } = makeGuard({ caps: { perThreadPerHour: 2, globalPerHour: 50, globalPerDay: 100 } });

    // Burn the per-thread cap via recordOutbound.
    expect(guard.checkOperation("sendMessage", "t1").allowed).toBe(true);
    guard.recordOutbound("sendMessage", "t1");
    guard.markComplete("sendMessage", "t1");
    expect(guard.checkOperation("sendMessage", "t1").allowed).toBe(true);
    guard.recordOutbound("sendMessage", "t1");
    guard.markComplete("sendMessage", "t1");

    const denied = guard.checkOperation("sendMessage", "t1");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("Per-thread");
  });

  it("denies all sends when the global hourly cap is reached", () => {
    const { guard } = makeGuard({ caps: { perThreadPerHour: 100, globalPerHour: 1, globalPerDay: 100 } });

    guard.recordOutbound("sendMessage", "a");
    const decision = guard.checkOperation("sendMessage", "b");
    expect(decision.allowed).toBe(false);
  });

  it("disables entirely when enabled=false", () => {
    const { guard } = makeGuard({ enabled: false });
    for (let i = 0; i < 10; i += 1) {
      expect(guard.checkOperation("sendMessage", "t").allowed).toBe(true);
    }
  });
});

describe("StealthGuard — circuit breaker", () => {
  it("opens after `signalThreshold` halting signals and denies everything", async () => {
    const { guard } = makeGuard({ signalThreshold: 2 });
    await guard.recordSignal(signal("halt", "throttle 1"));
    expect(guard.getState().circuitState).toBe("closed");

    await guard.recordSignal(signal("critical", "throttle 2"));
    expect(guard.getState().circuitState).toBe("open");

    const decision = guard.checkOperation("sendMessage", "t");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("halt");
  });

  it("refuses manual reset during cooldown and allows it afterwards", async () => {
    const { guard } = makeGuard({ signalThreshold: 1, cooldownMs: 86_400_000 });
    await guard.recordSignal(signal("critical", "boom"));
    expect(guard.getState().circuitState).toBe("open");

    expect(await guard.reset()).toBe(false);
    expect(guard.getState().circuitState).toBe("open");
  });

  it("resets immediately when cooldown is zero", async () => {
    const { guard } = makeGuard({ signalThreshold: 1, cooldownMs: 0 });
    await guard.recordSignal(signal("critical", "boom"));
    expect(await guard.reset()).toBe(true);
    expect(guard.getState().circuitState).toBe("closed");
  });
});

describe("StealthGuard — audit log", () => {
  it("records allow and deny decisions with reasons", () => {
    const { guard } = makeGuard({ caps: { perThreadPerHour: 1, globalPerHour: 100, globalPerDay: 100 } });
    guard.checkOperation("sendMessage", "t1");
    guard.recordOutbound("sendMessage", "t1");
    guard.checkOperation("sendMessage", "t1"); // denied

    const snapshot = guard.getAudit().snapshot();
    expect(snapshot.total).toBeGreaterThanOrEqual(2);
    const decisions = snapshot.entries.map((e) => e.decision);
    expect(decisions).toContain("allow");
    expect(decisions).toContain("deny");
  });
});

describe("StealthGuard — concurrency bound", () => {
  it("denies after 5 in-flight operations for the same operation+target", () => {
    const { guard } = makeGuard();
    // Bucket allows a burst, but in-flight cap is 5.
    for (let i = 0; i < 5; i += 1) {
      expect(guard.checkOperation("addReaction", "t").allowed).toBe(true);
    }
    const blocked = guard.checkOperation("addReaction", "t");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("concurrent");

    guard.markComplete("addReaction", "t");
    expect(guard.checkOperation("addReaction", "t").allowed).toBe(true);
  });
});

describe("TokenBucket", () => {
  it("never grants more than capacity before refill", () => {
    const bucket = new TokenBucket(2, 0); // no refill
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });
});

describe("StealthGuard — warmup", () => {
  it("returns 1.0 when warmup is disabled and < 1.0 on day zero otherwise", () => {
    const { guard } = makeGuard({ warmupEnabled: false });
    expect(guard.getWarmupMultiplier()).toBe(1);

    const { guard: warming } = makeGuard({ warmupEnabled: true, warmupDays: 7 });
    expect(warming.getWarmupMultiplier()).toBeLessThan(1);
    expect(warming.getWarmupMultiplier()).toBeGreaterThanOrEqual(0.3);
  });
});

describe("StealthGuard — persistence", () => {
  it("restores circuit state from storage", async () => {
    const { guard, storage } = makeGuard({ signalThreshold: 1 });
    await guard.recordSignal(signal("critical", "boom"));
    expect(guard.getState().circuitState).toBe("open");

    const fresh = new StealthGuard({ config: { signalThreshold: 1 } as never, logger, storage });
    await fresh.initialize();
    expect(fresh.getState().circuitState).toBe("open");
  });
});
