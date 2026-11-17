/**
 * Session Health Score (G1)
 * 
 * Single 0-100 score combining:
 * - Cookie freshness
 * - Signal history
 * - Error rate
 * - Uptime
 * - Connection stability
 * 
 * Decays over time. Bots can subscribe: below 50 → warn, below 25 → tighten limits.
 */

import type { Logger } from "../logger/index.js";
import type { SuspensionSignal } from "./index.js";

/** Health score factors */
export interface HealthFactors {
  cookieFreshness: number;      // 0-100: age of cookies vs expiry
  signalHistory: number;         // 0-100: recent suspension signals
  errorRate: number;             // 0-100: API/network error frequency
  uptime: number;                // 0-100: session stability
  connectionQuality: number;     // 0-100: MQTT reconnect frequency
}

/** Health score configuration */
export interface HealthScoreConfig {
  /** Enable health tracking (default: true) */
  readonly enabled: boolean;
  /** Update interval in ms (default: 60 seconds) */
  readonly updateIntervalMs: number;
  /** Decay rate per hour (default: 2 points/hour) */
  readonly decayPerHour: number;
  /** Warning threshold (default: 50) */
  readonly warnThreshold: number;
  /** Critical threshold (default: 25) */
  readonly criticalThreshold: number;
}

/** Default health score configuration */
export const DEFAULT_HEALTH_SCORE_CONFIG: HealthScoreConfig = {
  enabled: true,
  updateIntervalMs: 60_000, // 1 minute
  decayPerHour: 2,
  warnThreshold: 50,
  criticalThreshold: 25,
};

/** Health score callbacks */
export interface HealthScoreCallbacks {
  onScoreUpdate: (score: number, factors: HealthFactors) => void;
  onWarning: (score: number) => void;
  onCritical: (score: number) => void;
}

/**
 * Session Health Score Calculator
 */
export class HealthScoreCalculator {
  readonly #config: HealthScoreConfig;
  readonly #logger: Logger;
  readonly #callbacks: HealthScoreCallbacks;

  #score: number = 100;
  #lastUpdate: number = Date.now();
  #sessionStart: number = Date.now();
  #timer: NodeJS.Timeout | null = null;
  
  // Tracking metrics
  #signalCount: number = 0;
  #errorCount: number = 0;
  #requestCount: number = 0;
  #reconnectCount: number = 0;
  #lastSignalMs: number = 0;
  #cookieAgeMs: number = 0;
  #cookieMaxAgeMs: number = 30 * 24 * 60 * 60 * 1000; // 30 days default

  constructor(deps: {
    config?: Partial<HealthScoreConfig> | undefined;
    logger: Logger;
    callbacks: HealthScoreCallbacks;
  }) {
    this.#config = { ...DEFAULT_HEALTH_SCORE_CONFIG, ...deps.config };
    this.#logger = deps.logger.child({ module: "health-score" });
    this.#callbacks = deps.callbacks;
  }

  /** Start health score tracking */
  start(): void {
    if (!this.#config.enabled) {
      this.#logger.debug("Health score tracking disabled");
      return;
    }

    this.#scheduleUpdate();
    this.#logger.info("Health score tracking started");
  }

  /** Stop health score tracking */
  stop(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#logger.info("Health score tracking stopped");
    }
  }

  /** Get current health score */
  getScore(): number {
    return Math.round(this.#score);
  }

  /** Get detailed health factors */
  getFactors(): HealthFactors {
    return {
      cookieFreshness: this.#calculateCookieFreshness(),
      signalHistory: this.#calculateSignalHistory(),
      errorRate: this.#calculateErrorRate(),
      uptime: this.#calculateUptime(),
      connectionQuality: this.#calculateConnectionQuality(),
    };
  }

  /** Record suspension signal */
  recordSignal(signal: SuspensionSignal): void {
    this.#signalCount++;
    this.#lastSignalMs = Date.now();
    
    // Immediate score impact based on severity
    const impact = {
      warn: -5,
      pause: -10,
      halt: -20,
      critical: -30,
    }[signal.severity];
    
    this.#score = Math.max(0, this.#score + impact);
    this.#checkThresholds();
  }

  /** Record API/network error */
  recordError(): void {
    this.#errorCount++;
    this.#score = Math.max(0, this.#score - 1);
  }

  /** Record successful request */
  recordRequest(): void {
    this.#requestCount++;
  }

  /** Record MQTT reconnect */
  recordReconnect(): void {
    this.#reconnectCount++;
    this.#score = Math.max(0, this.#score - 3);
  }

  /** Set cookie age information */
  setCookieAge(ageMs: number, maxAgeMs: number): void {
    this.#cookieAgeMs = ageMs;
    this.#cookieMaxAgeMs = maxAgeMs;
  }

  /** Schedule next update */
  #scheduleUpdate(): void {
    this.#timer = setTimeout(() => {
      this.#update();
      this.#scheduleUpdate();
    }, this.#config.updateIntervalMs);
  }

  /** Perform health score update */
  #update(): void {
    const now = Date.now();
    const elapsed = now - this.#lastUpdate;
    this.#lastUpdate = now;

    // Apply natural decay
    const hoursElapsed = elapsed / (60 * 60 * 1000);
    const decay = this.#config.decayPerHour * hoursElapsed;
    this.#score = Math.max(0, this.#score - decay);

    // Calculate factors
    const factors = this.getFactors();
    
    // Weighted average of factors (with current score influence)
    const targetScore = (
      factors.cookieFreshness * 0.25 +
      factors.signalHistory * 0.30 +
      factors.errorRate * 0.20 +
      factors.uptime * 0.15 +
      factors.connectionQuality * 0.10
    );

    // Gradual convergence toward target
    this.#score = this.#score * 0.7 + targetScore * 0.3;
    this.#score = Math.max(0, Math.min(100, this.#score));

    // Emit update
    this.#callbacks.onScoreUpdate(this.#score, factors);
    
    this.#logger.debug(
      { score: Math.round(this.#score), ...factors },
      "Health score updated"
    );

    this.#checkThresholds();
  }

  /** Check and emit threshold warnings */
  #checkThresholds(): void {
    const score = Math.round(this.#score);
    
    if (score <= this.#config.criticalThreshold) {
      this.#callbacks.onCritical(score);
    } else if (score <= this.#config.warnThreshold) {
      this.#callbacks.onWarning(score);
    }
  }

  /** Calculate cookie freshness factor */
  #calculateCookieFreshness(): number {
    if (this.#cookieMaxAgeMs === 0) {
      return 100;
    }
    const freshness = 100 * (1 - this.#cookieAgeMs / this.#cookieMaxAgeMs);
    return Math.max(0, Math.min(100, freshness));
  }

  /** Calculate signal history factor */
  #calculateSignalHistory(): number {
    const now = Date.now();
    const hoursSinceSignal = (now - this.#lastSignalMs) / (60 * 60 * 1000);
    
    if (this.#signalCount === 0) {
      return 100;
    }

    // Score decreases with signal count, improves with time since last signal
    const signalPenalty = Math.min(50, this.#signalCount * 10);
    const timeRecovery = Math.min(30, hoursSinceSignal * 5);
    
    return Math.max(0, 100 - signalPenalty + timeRecovery);
  }

  /** Calculate error rate factor */
  #calculateErrorRate(): number {
    if (this.#requestCount === 0) {
      return 100;
    }

    const errorRate = this.#errorCount / this.#requestCount;
    return Math.max(0, Math.round(100 * (1 - errorRate * 10)));
  }

  /** Calculate uptime factor */
  #calculateUptime(): number {
    const now = Date.now();
    const uptimeHours = (now - this.#sessionStart) / (60 * 60 * 1000);
    
    // Score improves with uptime (up to 24 hours)
    return Math.min(100, Math.round(uptimeHours * 4.17));
  }

  /** Calculate connection quality factor */
  #calculateConnectionQuality(): number {
    const now = Date.now();
    const uptimeHours = (now - this.#sessionStart) / (60 * 60 * 1000);
    
    if (uptimeHours === 0) {
      return 100;
    }

    // Reconnects per hour
    const reconnectsPerHour = this.#reconnectCount / uptimeHours;
    
    // 0 reconnects = 100, 1/hour = 80, 2/hour = 60, 5+/hour = 0
    return Math.max(0, Math.round(100 - reconnectsPerHour * 20));
  }

}
