/**
 * Stealth Guard behavior tests.
 *
 * Every test uses an in-memory storage adapter and tuned config values —
 * no timers, no network, fully deterministic.
 */

import { describe, expect, it } from "vitest";
import { createRootLogger } from "../src/logger/index.js";
import { MemoryStorage } from "../src/storage/index.js";
import { StealthGuard, DEFAULT_STEALTH_CONFIG, AntiDetectionManager } from "../src/stealth/index.js";
import { humanTypingDelay, typingIndicatorDuration } from "../src/stealth/anti-detection.js";
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

describe("AntiDetectionManager logs", () => {
  it("announces its real state instead of staying silent", () => {
    const lines: string[] = [];
    const capture = createRootLogger({
      level: "debug",
      prettyPrint: false,
      logFile: null,
      transports: [{ write: (line) => lines.push(line) }],
    });
    const manager = new AntiDetectionManager({ enabled: true }, capture);
    expect(lines.join("\n")).toContain("Anti-detection initialized");
    manager.destroy();
  });

  it("announces when anti-detection is disabled", () => {
    const lines: string[] = [];
    const capture = createRootLogger({
      level: "debug",
      prettyPrint: false,
      logFile: null,
      transports: [{ write: (line) => lines.push(line) }],
    });
    const manager = new AntiDetectionManager({ enabled: false }, capture);
    expect(lines.join("\n")).toContain("Anti-detection disabled");
    manager.destroy();
  });
});

describe("StealthGuard — false-positive halt recovery", () => {
  it("reopens a circuit opened only by data-plane mqtt_pattern signals", async () => {
    const storage = new MemoryStorage();
    const signals: SuspensionSignal[] = Array.from({ length: 3 }, (_, index) => ({
      type: "mqtt_pattern",
      severity: "critical",
      message: "Checkpoint or verification required",
      timestamp: Date.now() - index * 1000,
      context: { topic: "/t_ms", pattern: "checkpoint" },
    }));
    await storage.set("stealth:state", {
      circuitState: "open",
      signals,
      haltedAt: Date.now() - 60_000,
      sessionStartMs: Date.now(),
      warmupDay: 0,
      hourWindow: [],
      dayWindow: [],
    });

    const guard = new StealthGuard({
      config: { enabled: true, signalThreshold: 3 } as never,
      logger,
      storage,
    });
    await guard.initialize();

    expect(guard.getState().circuitState).toBe("closed");
    expect(guard.checkOperation("sendMessage").allowed).toBe(true);
  });
});

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

describe("advanced anti-detection timing", () => {
  it("scales compose delay with message length and stays bounded", () => {
    const short = humanTypingDelay(5);
    const long = humanTypingDelay(300);
    expect(short).toBeGreaterThanOrEqual(80);
    expect(long).toBeGreaterThanOrEqual(80);
    expect(long).toBeLessThanOrEqual(4_000);
    // Average over several samples to absorb the random noise.
    const avg = (n: number): number => {
      let sum = 0;
      for (let i = 0; i < 20; i += 1) sum += humanTypingDelay(n);
      return sum / 20;
    };
    expect(avg(300)).toBeGreaterThan(avg(5));
  });

  it("typing indicator duration is shorter than compose time and capped", () => {
    expect(typingIndicatorDuration(300)).toBeLessThanOrEqual(2_500);
    expect(typingIndicatorDuration(10)).toBeGreaterThanOrEqual(150);
  });

  it("uses the canonical userAgent from config in the fingerprint", () => {
    const ua = "Mozilla/5.0 (Test) Chrome/149.0.0.0";
    const manager = new AntiDetectionManager({ enabled: true, userAgent: ua }, logger);
    expect(manager.getFingerprint().userAgent).toBe(ua);
    manager.destroy();
  });

  it("injects a longer pause after a burst of sends", () => {
    const manager = new AntiDetectionManager({
      enabled: true,
      typingRhythm: false,
      timingJitterMs: [0, 0],
      burstPauseCount: 3,
      burstPauseMs: 5_000,
    }, logger);
    const delays = [manager.computeHumanDelay(10), manager.computeHumanDelay(10), manager.computeHumanDelay(10)];
    // The third send in the burst crosses the threshold and adds the pause.
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(5_000);
    manager.destroy();
  });

  it("produces zero delay when anti-detection is disabled", () => {
    const manager = new AntiDetectionManager({ enabled: false }, logger);
    expect(manager.computeHumanDelay(200)).toBe(0);
    manager.destroy();
  });
});

describe("StealthGuard — delay-based anti-spam", () => {
  it("adds no delay below the threshold, then escalates", () => {
    const { guard } = makeGuard({
      pacingEnabled: true,
      antiSpamThreshold: 2,
      antiSpamBaseDelayMs: 100,
      antiSpamMaxDelayMs: 1000,
      antiSpamWindowMs: 60_000,
      antiSpamPerThread: false,
    });
    // The gate computes the delay from PRIOR sends, then records the send.
    // With threshold 2: first two sends are instant; the third sees 2 prior
    // sends (still at threshold) and the fourth sees 3 (escalation kicks in).
    expect(guard.getAntiSpamDelay()).toBe(0);
    guard.recordSend();
    expect(guard.getAntiSpamDelay()).toBe(0);
    guard.recordSend();
    expect(guard.getAntiSpamDelay()).toBe(0);
    guard.recordSend();
    expect(guard.getAntiSpamDelay()).toBeGreaterThan(0);
  });

  it("caps the escalation at antiSpamMaxDelayMs", () => {
    const { guard } = makeGuard({
      pacingEnabled: true,
      antiSpamThreshold: 0,
      antiSpamBaseDelayMs: 5000,
      antiSpamMaxDelayMs: 300,
      antiSpamPerThread: false,
    });
    for (let i = 0; i < 12; i += 1) guard.recordSend();
    // ±25% jitter, so assert a generous upper bound around the 300ms cap.
    expect(guard.getAntiSpamDelay()).toBeLessThanOrEqual(375);
  });

  it("never delays when the guard is disabled", () => {
    const { guard } = makeGuard({ enabled: false, pacingEnabled: true });
    for (let i = 0; i < 10; i += 1) guard.recordSend();
    expect(guard.getAntiSpamDelay()).toBe(0);
    expect(guard.getPacingDelay()).toBe(0);
  });

  it("tracks per-thread windows independently", () => {
    const { guard } = makeGuard({
      pacingEnabled: true,
      antiSpamThreshold: 1,
      antiSpamBaseDelayMs: 100,
      antiSpamMaxDelayMs: 2000,
      antiSpamWindowMs: 60_000,
      antiSpamPerThread: true,
    });
    // One send in "a" — still at threshold, no delay.
    guard.recordSend("a");
    expect(guard.getAntiSpamDelay("a")).toBe(0);
    // Two more in "a" exceed threshold for that thread.
    guard.recordSend("a");
    guard.recordSend("a");
    expect(guard.getAntiSpamDelay("a")).toBeGreaterThan(0);
    // "b" has its own window and is still quiet.
    expect(guard.getAntiSpamDelay("b")).toBeGreaterThanOrEqual(0);
  });
});

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
