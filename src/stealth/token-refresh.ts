/**
 * Token Refresh Manager (A11)
 *
 * Keeps the session fresh in the background. The actual rotation is
 * whatever `refreshFn` performs — the client wires it to the real cookie
 * refresh flow (`home.php` → `Set-Cookie` → persisted jar), which is the
 * only thing that actually moves `xs`/`datr` forward. Randomized intervals
 * keep the cadence from looking metronomic.
 */

import type { Logger } from "../logger/index.js";

/** Token refresh configuration. */
export interface TokenRefreshConfig {
  /** Enable automatic refresh. Default true. */
  readonly enabled: boolean;
  /** Minimum interval between refreshes, ms. Default 12h. */
  readonly minIntervalMs: number;
  /** Maximum interval between refreshes, ms. Default 24h. */
  readonly maxIntervalMs: number;
  /** Jitter as a fraction of the base interval. Default 0.2. */
  readonly jitterPercent: number;
}

/** Default token refresh configuration. */
export const DEFAULT_TOKEN_REFRESH_CONFIG: TokenRefreshConfig = {
  enabled: true,
  minIntervalMs: 12 * 60 * 60 * 1000,
  maxIntervalMs: 24 * 60 * 60 * 1000,
  jitterPercent: 0.2,
};

export type RefreshFn = () => Promise<boolean>;

/**
 * Schedules periodic refreshes and performs the one-off `forceRefresh()`
 * the client calls on "Not logged in" before giving up.
 */
export class TokenRefreshManager {
  readonly #config: TokenRefreshConfig;
  readonly #logger: Logger;
  readonly #refreshFn: RefreshFn;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastRefresh = 0;
  #running = false;

  constructor(deps: {
    config?: Partial<TokenRefreshConfig> | undefined;
    logger: Logger;
    refreshFn: RefreshFn;
  }) {
    this.#config = { ...DEFAULT_TOKEN_REFRESH_CONFIG, ...deps.config };
    this.#logger = deps.logger.child({ module: "token-refresh" });
    this.#refreshFn = deps.refreshFn;
  }

  /** Start the background schedule. */
  start(): void {
    if (!this.#config.enabled) {
      this.#logger.debug("Token refresh disabled");
      return;
    }
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#scheduleNext();
    this.#logger.info("Token refresh manager started");
  }

  /** Stop the background schedule. */
  stop(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#running = false;
    this.#logger.info("Token refresh manager stopped");
  }

  /**
   * Immediate out-of-band refresh. Used by the client on auth failure —
   * one attempt, never a retry loop. Returns whether it succeeded.
   */
  async forceRefresh(): Promise<boolean> {
    this.#logger.info("Force refreshing session cookies");
    try {
      const ok = await this.#refreshFn();
      if (ok) {
        this.#lastRefresh = Date.now();
      }
      return ok;
    } catch (error) {
      this.#logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Token refresh failed",
      );
      return false;
    }
  }

  /** Milliseconds until the next scheduled refresh (0 when unknown). */
  getNextRefreshMs(): number {
    if (this.#lastRefresh === 0) {
      return 0;
    }
    return Math.max(0, this.#nextInterval() - (Date.now() - this.#lastRefresh));
  }

  #scheduleNext(): void {
    if (!this.#running) {
      return;
    }
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
    const interval = this.#nextInterval();
    this.#timer = setTimeout(() => {
      void this.#tick();
    }, interval);
    this.#logger.debug({ intervalMs: interval }, "Scheduled next token refresh");
  }

  async #tick(): Promise<void> {
    const ok = await this.forceRefresh();
    if (!ok) {
      // Retry sooner once, not in a hot loop: half the min interval.
      this.#timer = setTimeout(() => {
        void this.#tickRetry();
      }, Math.min(this.#config.minIntervalMs / 2, 5 * 60 * 1000));
      return;
    }
    this.#scheduleNext();
  }

  async #tickRetry(): Promise<void> {
    await this.forceRefresh();
    this.#scheduleNext();
  }

  #nextInterval(): number {
    const { minIntervalMs, maxIntervalMs, jitterPercent } = this.#config;
    const base = minIntervalMs + Math.random() * (maxIntervalMs - minIntervalMs);
    const jitter = base * jitterPercent * (Math.random() * 2 - 1);
    return Math.max(minIntervalMs / 2, Math.round(base + jitter));
  }
}
