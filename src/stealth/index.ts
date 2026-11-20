/**
 * Stealth Guard — Facebook suspension prevention with advanced anti-detection.
 *
 * The bot never behaves in a way that trips Facebook's restriction
 * systems, and stops itself safely the moment risk signals appear.
 * A safety governor with built-in anti-detection: it reduces the chance 
 * an account trips restrictions through both behavioral controls and 
 * fingerprint management.
 *
 * Components:
 * - `SuspensionDetector` — signal detection across HTTP/GraphQL/MQTT/raw text
 * - `StealthGuard` — circuit breaker, per-operation token buckets,
 *   sliding-window caps with warning pauses, warmup mode, pacing jitter,
 *   audit log of every decision
 * - `AntiDetectionManager` — session fingerprints, hardware device IDs,
 *   request obfuscation, timing jitter, user agent rotation
 */

import type { Logger } from "../logger/index.js";
import type { StorageAdapter } from "../types/index.js";
import { GuardAuditLog, type GuardAuditEntry } from "./audit-log.js";
import {
  SlidingWindowCap,
  TokenBucket,
  type OperationLimits,
  type RateLimitConfig,
  type WindowState,
} from "./rate-limiter.js";
import {
  AntiDetectionManager,
  DEFAULT_ANTI_DETECTION_CONFIG,
  type AntiDetectionConfig,
  type DeviceFingerprint,
} from "./anti-detection.js";

export type SuspensionSeverity = "warn" | "pause" | "halt" | "critical";

export interface SuspensionSignal {
  readonly type: string;
  readonly severity: SuspensionSeverity;
  readonly code?: number | string | undefined;
  readonly message: string;
  readonly timestamp: number;
  readonly context: Readonly<Record<string, unknown>>;
}

/** Sliding-window cap configuration. */
export interface StealthCaps {
  /** Max outbound messages per hour, per thread. Default 30. */
  readonly perThreadPerHour: number;
  /** Max outbound messages per hour, globally. Default 100. */
  readonly globalPerHour: number;
  /** Max outbound messages per day, globally. Default 200. */
  readonly globalPerDay: number;
}

export interface StealthConfig {
  /** Enable the guard. Default true. */
  readonly enabled: boolean;
  /** critical/halt signals within `signalWindow` that open the circuit. Default 3. */
  readonly signalThreshold: number;
  /** Signal counting window, ms. Default 10 minutes. */
  readonly signalWindow: number;
  /** Circuit open → cooldown before half-open, ms. Default 24h. */
  readonly cooldownMs: number;
  /** Fresh sessions start with reduced caps. Default true. */
  readonly warmupEnabled: boolean;
  /** Days to ramp from 30% to 100%. Default 7. */
  readonly warmupDays: number;
  /** Base pacing delay before outbound ops, ms. Default 1200. */
  readonly basePacingMs: number;
  /** Jitter as a fraction of base pacing. Default 0.5. */
  readonly jitterPercent: number;
  /** Apply randomized pacing before outbound ops. Default true. */
  readonly pacingEnabled: boolean;
  /** Sliding-window caps (A4). */
  readonly caps: StealthCaps;
  /** Pacing multiplier applied once a cap warning is active. Default 2. */
  readonly capWarningDelayMultiplier: number;
  readonly limits: OperationLimits;
  /** Advanced anti-detection protection. Default `true` (opt-in to disable). */
  readonly antiDetection: boolean | AntiDetectionConfig;
}

export type CircuitState = "closed" | "open" | "half_open";

export interface StealthState {
  readonly circuitState: CircuitState;
  readonly signals: readonly SuspensionSignal[];
  readonly haltedAt: number | null;
  /** When the current session's warmup period started, epoch ms. */
  readonly sessionStartMs: number;
  readonly warmupDay: number;
  readonly hourWindow: WindowState;
  readonly dayWindow: WindowState;
}

export interface StealthGuardCallbacks {
  /** Critical/halt signals observed (wave/alerting hook). */
  readonly onSignal?: ((signal: SuspensionSignal) => void) | undefined;
  /** Cap crossed 80% for the current window. */
  readonly onCapWarning?: ((window: "hour" | "day", count: number, limit: number) => void) | undefined;
  /** Cap reached 100% for the current window. */
  readonly onCapReached?: ((window: "hour" | "day", count: number, limit: number) => void) | undefined;
  /** Circuit breaker opened. */
  readonly onHalt?: ((state: StealthState, reason: string) => void) | undefined;
  /** Manual reset succeeded after cooldown. */
  readonly onReset?: (() => void) | undefined;
  /** A checkpoint/identity-verification signal was observed. */
  readonly onCheckpoint?: ((signal: SuspensionSignal) => void) | undefined;
  /** Outbound volume is accelerating toward restriction risk. */
  readonly onRiskRising?: ((metric: string, detail: string) => void) | undefined;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Keep at most this many signals in the persisted state. */
const MAX_PERSISTED_SIGNALS = 50;

export const DEFAULT_STEALTH_CONFIG: StealthConfig = {
  enabled: true,
  signalThreshold: 3,
  signalWindow: 10 * 60 * 1000,
  cooldownMs: DAY_MS,
  warmupEnabled: true,
  warmupDays: 7,
  basePacingMs: 1200,
  jitterPercent: 0.5,
  pacingEnabled: true,
  capWarningDelayMultiplier: 2,
  caps: {
    perThreadPerHour: 30,
    globalPerHour: 100,
    globalPerDay: 200,
  },
  limits: {
    sendMessage: { burst: 10, sustained: 30, refillRate: 30 / 3600 },
    addReaction: { burst: 20, sustained: 100, refillRate: 100 / 3600 },
    createGroup: { burst: 2, sustained: 5, refillRate: 5 / 3600 },
    global: { burst: 50, sustained: 200, refillRate: 200 / 3600 },
  },
  antiDetection: true
};

/** Guard's view of an outbound operation. */
export interface GuardDecisionResult {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
  /** Current warmup multiplier (0.3 – 1.0). */
  readonly warmup: number;
  /** Multiplier applied to pacing delays (1 normally, 2+ under cap warning). */
  readonly delayMultiplier: number;
}

/**
 * The Stealth Guard singleton for one client. Thread-unsafe by design:
 * the client is single-threaded, and caps are best-effort counters.
 */
export class StealthGuard {
  readonly #config: StealthConfig;
  readonly #logger: Logger;
  readonly #storage: StorageAdapter;
  readonly #audit = new GuardAuditLog(200);
  #hourCap: SlidingWindowCap;
  #dayCap: SlidingWindowCap;
  readonly #threadCaps = new Map<string, SlidingWindowCap>();
  /** Rolling 2h window of successful outbound sends (G2 risk forecast). */
  readonly #sendTimestamps: number[] = [];
  #riskRiseNotifiedAt = 0;

  #callbacks: StealthGuardCallbacks = {};
  #state: StealthState;
  #buckets = new Map<string, TokenBucket>();
  #inFlight = new Map<string, number>();

  constructor(deps: {
    config?: Partial<StealthConfig> | undefined;
    logger: Logger;
    storage: StorageAdapter;
  }) {
    this.#config = { ...DEFAULT_STEALTH_CONFIG, ...deps.config, caps: { ...DEFAULT_STEALTH_CONFIG.caps, ...deps.config?.caps }, limits: { ...DEFAULT_STEALTH_CONFIG.limits, ...deps.config?.limits } };
    this.#logger = deps.logger.child({ module: "stealth" });
    this.#storage = deps.storage;
    this.#hourCap = new SlidingWindowCap(HOUR_MS, this.#config.caps.globalPerHour);
    this.#dayCap = new SlidingWindowCap(DAY_MS, this.#config.caps.globalPerDay);
    this.#state = {
      circuitState: "closed",
      signals: [],
      haltedAt: null,
      sessionStartMs: Date.now(),
      warmupDay: 0,
      hourWindow: { windowStart: Date.now(), count: 0 },
      dayWindow: { windowStart: Date.now(), count: 0 },
    };
  }

  /** Attach or replace the guard's callbacks (client sets these once). */
  setCallbacks(callbacks: StealthGuardCallbacks): void {
    this.#callbacks = callbacks;
  }

  /** Load persisted state; discards windows that have rolled over. */
  async initialize(): Promise<void> {
    const stored = await this.#storage.get<StealthState>("stealth:state");
    if (stored !== null) {
      this.#state = {
        circuitState: stored.circuitState,
        signals: stored.signals.slice(-MAX_PERSISTED_SIGNALS),
        haltedAt: stored.haltedAt,
        sessionStartMs: stored.sessionStartMs,
        warmupDay: stored.warmupDay,
        hourWindow: stored.hourWindow,
        dayWindow: stored.dayWindow,
      };
      // Rebuild caps from persisted windows; stale windows roll over naturally.
      this.#hourCap = new SlidingWindowCap(HOUR_MS, this.#config.caps.globalPerHour, stored.hourWindow);
      this.#dayCap = new SlidingWindowCap(DAY_MS, this.#config.caps.globalPerDay, stored.dayWindow);
      this.#logger.info(
        { circuitState: stored.circuitState, warmupDay: stored.warmupDay, signals: this.#state.signals.length },
        "Stealth Guard state restored",
      );
    } else {
      // A fresh start (e.g. every Render deploy) previously produced NO
      // stealth log at all because this branch was missing. Always announce
      // the guard's state so it is visible it is actually active.
      this.#logger.info(
        {
          enabled: this.#config.enabled,
          circuitState: this.#state.circuitState,
          warmupDay: this.#state.warmupDay,
          panel: {
            title: "STEALTH GUARD",
            tone: "success",
            rows: [
              ["Status", this.#config.enabled ? "Enabled" : "Disabled"],
              ["Circuit", this.#state.circuitState],
              ["Warmup day", this.#state.warmupDay],
            ],
            footer: "github.com/nazzelofficial/panindigan-automate",
          },
        },
        "Stealth Guard initialized",
      );
    }
  }

  /** Whether the guard permits the operation right now. */
  checkOperation(operation: string, target?: string): GuardDecisionResult {
    if (!this.#config.enabled) {
      return { allowed: true, warmup: 1, delayMultiplier: 1 };
    }

    // A4 — hard caps. Warning level doubles pacing; reached denies.
    const hourCap = this.#hourCap;
    const dayCap = this.#dayCap;
    if (dayCap.level() === "reached" || hourCap.level() === "reached") {
      const which = dayCap.level() === "reached" ? "day" : "hour";
      this.#audit.record({
        at: Date.now(), decision: "cap_reached",
        reason: `global ${which} cap reached`,
        operation, ...(target !== undefined ? { target } : {}),
      });
      this.#callbacks.onCapReached?.(which, which === "day" ? dayCap.state().count : hourCap.state().count, which === "day" ? this.#config.caps.globalPerDay : this.#config.caps.globalPerHour);
      return { allowed: false, reason: `Daily/hourly send cap reached — resets with the window`, warmup: this.getWarmupMultiplier(), delayMultiplier: this.#config.capWarningDelayMultiplier };
    }
    if (target !== undefined) {
      const threadCap = this.#getThreadCap(target);
      if (threadCap.isFull()) {
        this.#audit.record({
          at: Date.now(), decision: "deny",
          reason: "per-thread hourly cap reached",
          operation, target,
        });
        return { allowed: false, reason: "Per-thread hourly cap reached", warmup: this.getWarmupMultiplier(), delayMultiplier: this.#config.capWarningDelayMultiplier };
      }
    }

    // A2 — circuit breaker.
    if (this.#state.circuitState === "open") {
      const remaining = this.#cooldownRemaining();
      if (remaining > 0) {
        this.#audit.record({
          at: Date.now(), decision: "deny",
          reason: `circuit open — ${Math.ceil(remaining / 60000)}m cooldown left`,
          operation, ...(target !== undefined ? { target } : {}),
        });
        return {
          allowed: false,
          reason: `Account protection active — halted for ${Math.ceil(remaining / 60000)} more minutes`,
          warmup: this.getWarmupMultiplier(),
          delayMultiplier: this.#config.capWarningDelayMultiplier,
        };
      }
      this.#state = { ...this.#state, circuitState: "half_open" };
      void this.#persist();
    }

    // In-flight concurrency bound (counted, not just completions).
    const bucketKey = target !== undefined ? `${operation}:${target}` : operation;
    const inFlight = this.#inFlight.get(bucketKey) ?? 0;
    if (inFlight >= 5) {
      this.#audit.record({ at: Date.now(), decision: "deny", reason: "too many concurrent requests", operation, ...(target !== undefined ? { target } : {}) });
      return { allowed: false, reason: "Too many concurrent requests", warmup: this.getWarmupMultiplier(), delayMultiplier: this.#capDelayMultiplier() };
    }

    // Token bucket.
    const bucket = this.#getBucket(operation);
    if (!bucket.tryConsume()) {
      this.#audit.record({ at: Date.now(), decision: "deny", reason: "rate limit exceeded", operation, ...(target !== undefined ? { target } : {}) });
      return { allowed: false, reason: "Rate limit exceeded", warmup: this.getWarmupMultiplier(), delayMultiplier: this.#capDelayMultiplier() };
    }
    this.#inFlight.set(bucketKey, inFlight + 1);

    this.#audit.record({ at: Date.now(), decision: "allow", reason: "allowed", operation, ...(target !== undefined ? { target } : {}) });
    return { allowed: true, warmup: this.getWarmupMultiplier(), delayMultiplier: this.#capDelayMultiplier() };
  }

  /** Release an in-flight slot after the operation settles. */
  markComplete(operation: string, target?: string): void {
    const bucketKey = target !== undefined ? `${operation}:${target}` : operation;
    const inFlight = this.#inFlight.get(bucketKey) ?? 0;
    this.#inFlight.set(bucketKey, Math.max(0, inFlight - 1));
  }

  /** Record a completed successful outbound action against the caps. */
  recordOutbound(operation: string, target?: string): void {
    if (!this.#config.enabled) {
      return;
    }
    this.#hourCap.record();
    this.#dayCap.record();
    if (target !== undefined) {
      this.#getThreadCap(target).record();
    }
    this.#syncWindowsToState();

    // G2 — risk forecast: message volume accelerating hour-over-hour.
    if (operation === "sendMessage") {
      const now = Date.now();
      this.#sendTimestamps.push(now);
      const twoHours = 2 * 60 * 60 * 1000;
      const oneHour = 60 * 60 * 1000;
      while (this.#sendTimestamps.length > 0 && now - (this.#sendTimestamps[0] ?? 0) > twoHours) {
        this.#sendTimestamps.shift();
      }
      const lastHour = this.#sendTimestamps.filter((ts) => now - ts < oneHour).length;
      const previousHour = this.#sendTimestamps.length - lastHour;
      const surge = lastHour >= 20 && previousHour > 0 && lastHour > previousHour * 1.5;
      if (surge && now - this.#riskRiseNotifiedAt > oneHour) {
        this.#riskRiseNotifiedAt = now;
        this.#callbacks.onRiskRising?.(
          "sends_acceleration",
          `${lastHour} sends in the last hour vs ${previousHour} the hour before — back off to avoid tripping restrictions`,
        );
      }
    }

    const hour = this.#hourCap.level();
    const day = this.#dayCap.level();
    if (hour === "reached") {
      this.#callbacks.onCapReached?.("hour", this.#hourCap.state().count, this.#config.caps.globalPerHour);
    } else if (hour === "warning") {
      this.#callbacks.onCapWarning?.("hour", this.#hourCap.state().count, this.#config.caps.globalPerHour);
    }
    if (day === "reached") {
      this.#callbacks.onCapReached?.("day", this.#dayCap.state().count, this.#config.caps.globalPerDay);
    } else if (day === "warning") {
      this.#callbacks.onCapWarning?.("day", this.#dayCap.state().count, this.#config.caps.globalPerDay);
    }
    void this.#persist();
  }

  /** Record a suspension signal; may open the circuit. */
  async recordSignal(signal: SuspensionSignal): Promise<void> {
    const now = Date.now();
    const signals = [
      ...this.#state.signals.filter((s) => now - s.timestamp < this.#config.signalWindow),
      signal,
    ].slice(-MAX_PERSISTED_SIGNALS);
    this.#state = { ...this.#state, signals };

    this.#logger.warn(
      { signal: signal.type, severity: signal.severity, code: signal.code, inWindow: signals.length },
      "Suspension signal detected",
    );
    this.#callbacks.onSignal?.(signal);
    if (signal.severity === "critical" && /checkpoint|verification|identity|approval/i.test(signal.message)) {
      this.#audit.record({ at: now, decision: "checkpoint", reason: signal.message, metadata: { type: signal.type, code: signal.code } });
      this.#callbacks.onCheckpoint?.(signal);
    }

    const halting = signals.filter((s) => s.severity === "halt" || s.severity === "critical");
    if (halting.length >= this.#config.signalThreshold) {
      await this.#halt(`${halting.length} halting signals in ${Math.round(this.#config.signalWindow / 60000)} minutes`);
      return;
    }
    await this.#persist();
  }

  /** Force the circuit open. Used by the checkpoint realtime guard (A9). */
  async forceHalt(reason: string): Promise<void> {
    await this.#halt(reason);
  }

  /** Open the circuit, freeze proactive sends, notify callbacks. */
  async #halt(reason: string): Promise<void> {
    if (this.#state.circuitState === "open") {
      return; // already halted
    }
    this.#state = { ...this.#state, circuitState: "open", haltedAt: Date.now() };
    this.#audit.record({ at: Date.now(), decision: "halt", reason });
    this.#logger.error({ reason, cooldownMs: this.#config.cooldownMs }, "Stealth Guard HALTED");
    this.#callbacks.onHalt?.(this.#state, reason);
    await this.#persist();
  }

  /** Manual reset — only after the cooldown has elapsed. */
  async reset(): Promise<boolean> {
    if (this.#cooldownRemaining() > 0) {
      this.#logger.warn({ remainingMs: this.#cooldownRemaining() }, "Reset refused — cooldown not expired");
      return false;
    }
    this.#state = {
      ...this.#state,
      circuitState: "closed",
      signals: [],
      haltedAt: null,
    };
    this.#audit.record({ at: Date.now(), decision: "reset", reason: "manual reset" });
    this.#logger.info("Stealth Guard reset manually");
    this.#callbacks.onReset?.();
    await this.#persist();
    return true;
  }

  /** Randomized inter-operation delay with jitter, scaled by cap warnings. */
  getPacingDelay(): number {
    if (!this.#config.pacingEnabled) {
      return 0;
    }
    const base = this.#config.basePacingMs * this.#capDelayMultiplier();
    const jitter = this.#config.jitterPercent * base * Math.random();
    const sign = Math.random() < 0.5 ? -1 : 1;
    return Math.max(1, Math.round(base + sign * jitter));
  }

  /** Warmup multiplier 0.3 → 1.0 across the warmup window. */
  getWarmupMultiplier(): number {
    if (!this.#config.warmupEnabled) {
      return 1;
    }
    const days = (Date.now() - this.#state.sessionStartMs) / DAY_MS;
    const day = Math.min(Math.floor(days), this.#config.warmupDays);
    if (day !== this.#state.warmupDay) {
      this.#state = { ...this.#state, warmupDay: day };
      void this.#persist();
    }
    return 0.3 + (0.7 * (day / this.#config.warmupDays));
  }

  getState(): StealthState {
    return this.#state;
  }

  /** G8 — audit log. */
  getAudit(): GuardAuditLog {
    return this.#audit;
  }

  /** Current cap levels for diagnostics (safe, no secrets). */
  capsSnapshot(): {
    hour: { count: number; limit: number; level: string };
    day: { count: number; limit: number; level: string };
  } {
    return {
      hour: { ...this.#hourCap.state(), limit: this.#config.caps.globalPerHour, level: this.#hourCap.level() },
      day: { ...this.#dayCap.state(), limit: this.#config.caps.globalPerDay, level: this.#dayCap.level() },
    };
  }

  #capDelayMultiplier(): number {
    return this.#hourCap.level() === "warning" || this.#dayCap.level() === "warning"
      ? this.#config.capWarningDelayMultiplier
      : 1;
  }

  #cooldownRemaining(): number {
    if (this.#state.haltedAt === null) {
      return 0;
    }
    return Math.max(0, this.#config.cooldownMs - (Date.now() - this.#state.haltedAt));
  }

  #getBucket(operation: string): TokenBucket {
    let bucket = this.#buckets.get(operation);
    if (bucket === undefined) {
      const limit = this.#limitFor(operation);
      const warmup = this.getWarmupMultiplier();
      bucket = new TokenBucket(Math.max(1, Math.ceil(limit.burst * warmup)), (limit.refillRate * warmup));
      this.#buckets.set(operation, bucket);
    }
    return bucket;
  }

  #getThreadCap(threadId: string): SlidingWindowCap {
    let cap = this.#threadCaps.get(threadId);
    if (cap === undefined) {
      cap = new SlidingWindowCap(HOUR_MS, this.#config.caps.perThreadPerHour);
      this.#threadCaps.set(threadId, cap);
      // Bound the map so a long-running bot does not accumulate caps forever.
      if (this.#threadCaps.size > 500) {
        const oldest = this.#threadCaps.keys().next().value;
        if (oldest !== undefined) {
          this.#threadCaps.delete(oldest);
        }
      }
    }
    return cap;
  }

  #limitFor(operation: string): RateLimitConfig {
    const limits = this.#config.limits as unknown as Record<string, RateLimitConfig>;
    return limits[operation] ?? limits["global"] ?? DEFAULT_STEALTH_CONFIG.limits.global;
  }

  #syncWindowsToState(): void {
    this.#state = {
      ...this.#state,
      hourWindow: this.#hourCap.state(),
      dayWindow: this.#dayCap.state(),
    };
  }

  async #persist(): Promise<void> {
    try {
      await this.#storage.set("stealth:state", {
        ...this.#state,
        hourWindow: this.#hourCap.state(),
        dayWindow: this.#dayCap.state(),
      });
    } catch (error) {
      // Persistence is best-effort; a failed write must not crash the bot.
      this.#logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Stealth Guard state could not be persisted",
      );
    }
  }
}

// Re-export anti-detection components
export {
  AntiDetectionManager,
  DEFAULT_ANTI_DETECTION_CONFIG,
  generateHardwareDeviceId,
  generateUserAgent,
  generateClientHints,
  applyTimingJitter,
  humanLikeDelay,
  calculateAdaptiveDelay,
  type AntiDetectionConfig,
  type DeviceFingerprint,
} from "./anti-detection.js";
