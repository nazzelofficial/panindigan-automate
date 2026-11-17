/**
 * Sliding-window rate limiting primitives for the Stealth Guard.
 *
 * Two mechanisms are combined on purpose:
 * - `TokenBucket` — short bursts plus a sustained refill rate, per operation type;
 * - `SlidingWindowCap` — hard hourly/daily counters for caps (A4), with an 80%
 *   warning threshold and a hard stop at 100%.
 */

/** Rate limit configuration for one operation class. */
export interface RateLimitConfig {
  /** Burst capacity (tokens available immediately). */
  readonly burst: number;
  /** Sustained tokens per hour. */
  readonly sustained: number;
  /** Sustained refill, tokens per second. Derived from `sustained`. */
  readonly refillRate: number;
}

/** Per-operation rate limits with a global fallback. */
export interface OperationLimits {
  readonly sendMessage: RateLimitConfig;
  readonly addReaction: RateLimitConfig;
  readonly createGroup: RateLimitConfig;
  readonly global: RateLimitConfig;
}

/** Token bucket with time-based refill. */
export class TokenBucket {
  #tokens: number;
  #lastRefill: number;
  readonly #capacity: number;
  readonly #refillRate: number;

  constructor(capacity: number, refillRatePerSec: number) {
    this.#capacity = capacity;
    this.#refillRate = refillRatePerSec;
    this.#tokens = capacity;
    this.#lastRefill = Date.now();
  }

  /** Try to consume `count` tokens; true when the caller may proceed. */
  tryConsume(count: number = 1): boolean {
    this.#refill();
    if (this.#tokens >= count) {
      this.#tokens -= count;
      return true;
    }
    return false;
  }

  #refill(): void {
    const now = Date.now();
    const elapsed = (now - this.#lastRefill) / 1000;
    if (elapsed <= 0) {
      return;
    }
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillRate);
    this.#lastRefill = now;
  }

  get available(): number {
    this.#refill();
    return this.#tokens;
  }
}

/** Mutable window state, persisted across restarts. */
export interface WindowState {
  /** Start of the current window, epoch ms. */
  windowStart: number;
  /** Count recorded inside the current window. */
  count: number;
}

export type CapLevel = "ok" | "warning" | "reached";

/**
 * A fixed window counter with an 80% warning level and a hard 100% stop.
 * Windows reset by elapsed time, not by clock alignment.
 */
export class SlidingWindowCap {
  readonly #windowMs: number;
  readonly #limit: number;
  #windowStart: number;
  #count: number;

  constructor(windowMs: number, limit: number, persisted?: WindowState | undefined) {
    this.#windowMs = windowMs;
    this.#limit = limit;
    const now = Date.now();
    if (persisted !== undefined && now - persisted.windowStart < windowMs) {
      this.#windowStart = persisted.windowStart;
      this.#count = persisted.count;
    } else {
      this.#windowStart = now;
      this.#count = 0;
    }
  }

  #roll(): void {
    const now = Date.now();
    if (now - this.#windowStart >= this.#windowMs) {
      this.#windowStart = now;
      this.#count = 0;
    }
  }

  /** Current level for this window. */
  level(): CapLevel {
    this.#roll();
    if (this.#count >= this.#limit) {
      return "reached";
    }
    if (this.#count >= Math.floor(this.#limit * 0.8)) {
      return "warning";
    }
    return "ok";
  }

  /** Whether the cap is fully reached. */
  isFull(): boolean {
    return this.level() === "reached";
  }

  /** Records one outbound action. Never exceeds the limit by itself. */
  record(): void {
    this.#roll();
    this.#count += 1;
  }

  /** Remaining slots in the current window. */
  remaining(): number {
    this.#roll();
    return Math.max(0, this.#limit - this.#count);
  }

  state(): WindowState {
    this.#roll();
    return { windowStart: this.#windowStart, count: this.#count };
  }
}
