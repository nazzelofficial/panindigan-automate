/**
 * MQTT Watchdog (A10)
 * 
 * Detects stale connections and triggers clean reconnection.
 * Monitors:
 * - /t_ms traffic (should receive within N seconds)
 * - PINGRESP timeouts (should respond within heartbeat timeout)
 * - Message flow (at least some activity expected)
 */

import type { Logger } from "../logger/index.js";

/** Watchdog configuration */
export interface WatchdogConfig {
  /** Enable watchdog (default: true) */
  readonly enabled: boolean;
  /** Max time without /t_ms traffic in ms (default: 90 seconds) */
  readonly syncTimeoutMs: number;
  /** Max time without any MQTT traffic in ms (default: 180 seconds) */
  readonly idleTimeoutMs: number;
  /** Check interval in ms (default: 10 seconds) */
  readonly checkIntervalMs: number;
}

/** Default watchdog configuration */
export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  enabled: true,
  syncTimeoutMs: 90_000,    // 90 seconds
  idleTimeoutMs: 180_000,   // 3 minutes
  checkIntervalMs: 10_000,  // 10 seconds
};

/** Watchdog callbacks */
export interface WatchdogCallbacks {
  /** Called when connection appears stale */
  onStale: (reason: string) => void;
  /** Called when ping timeout detected */
  onPingTimeout: () => void;
}

/**
 * MQTT Connection Watchdog
 * 
 * Monitors connection health and triggers reconnection when stale.
 */
export class MQTTWatchdog {
  readonly #config: WatchdogConfig;
  readonly #logger: Logger;
  readonly #callbacks: WatchdogCallbacks;
  
  #timer: NodeJS.Timeout | null = null;
  #lastSyncMs: number = 0;
  #lastAnyMs: number = 0;
  #lastPingMs: number = 0;
  #running: boolean = false;

  constructor(deps: {
    config?: Partial<WatchdogConfig> | undefined;
    logger: Logger;
    callbacks: WatchdogCallbacks;
  }) {
    this.#config = { ...DEFAULT_WATCHDOG_CONFIG, ...deps.config };
    this.#logger = deps.logger.child({ module: "watchdog" });
    this.#callbacks = deps.callbacks;
  }

  /** Start watchdog monitoring */
  start(): void {
    if (!this.#config.enabled) {
      this.#logger.debug("Watchdog disabled");
      return;
    }

    if (this.#running) {
      return;
    }

    this.#running = true;
    const now = Date.now();
    this.#lastSyncMs = now;
    this.#lastAnyMs = now;
    this.#lastPingMs = now;

    this.#scheduleCheck();
    this.#logger.info("MQTT watchdog started");
  }

  /** Stop watchdog monitoring */
  stop(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#running = false;
    this.#logger.info("MQTT watchdog stopped");
  }

  /** Record /t_ms sync message received */
  recordSyncMessage(): void {
    const now = Date.now();
    this.#lastSyncMs = now;
    this.#lastAnyMs = now;
  }

  /** Record any MQTT message received */
  recordMessage(): void {
    this.#lastAnyMs = Date.now();
  }

  /** Record PING sent */
  recordPingSent(): void {
    this.#lastPingMs = Date.now();
  }

  /** Record PONG received */
  recordPongReceived(): void {
    this.#lastAnyMs = Date.now();
  }

  /** Get time since last sync in ms */
  timeSinceSync(): number {
    return Date.now() - this.#lastSyncMs;
  }

  /** Get time since last message in ms */
  timeSinceMessage(): number {
    return Date.now() - this.#lastAnyMs;
  }

  /** Schedule next check */
  #scheduleCheck(): void {
    if (!this.#running) {
      return;
    }

    this.#timer = setTimeout(() => {
      this.#check();
      this.#scheduleCheck();
    }, this.#config.checkIntervalMs);
  }

  /** Perform health check */
  #check(): void {
    const now = Date.now();
    
    // Check sync timeout
    const sinceSyncMs = now - this.#lastSyncMs;
    if (sinceSyncMs > this.#config.syncTimeoutMs) {
      this.#logger.warn(
        { sinceSyncMs, timeoutMs: this.#config.syncTimeoutMs },
        "No /t_ms sync messages received - connection may be stale"
      );
      this.#callbacks.onStale(
        `No sync messages for ${Math.round(sinceSyncMs / 1000)}s`
      );
      return;
    }

    // Check idle timeout
    const sinceAnyMs = now - this.#lastAnyMs;
    if (sinceAnyMs > this.#config.idleTimeoutMs) {
      this.#logger.warn(
        { sinceAnyMs, timeoutMs: this.#config.idleTimeoutMs },
        "No MQTT messages received - connection appears dead"
      );
      this.#callbacks.onStale(
        `No messages for ${Math.round(sinceAnyMs / 1000)}s`
      );
      return;
    }

    // Check ping timeout (if ping was sent)
    const sincePingMs = now - this.#lastPingMs;
    const sinceLastActivity = now - this.#lastAnyMs;
    
    // If we sent a ping more than 30s ago and got no response
    if (this.#lastPingMs > this.#lastAnyMs && sincePingMs > 30_000) {
      this.#logger.warn(
        { sincePingMs },
        "PINGRESP timeout - connection not responding"
      );
      this.#callbacks.onPingTimeout();
      return;
    }

    // All checks passed
    this.#logger.debug(
      {
        sinceSyncMs: Math.round(sinceSyncMs / 1000),
        sinceAnyMs: Math.round(sinceAnyMs / 1000)
      },
      "Watchdog check passed"
    );
  }

  /** Get watchdog status */
  getStatus(): {
    running: boolean;
    timeSinceSyncMs: number;
    timeSinceMessageMs: number;
    healthy: boolean;
  } {
    const now = Date.now();
    const timeSinceSyncMs = now - this.#lastSyncMs;
    const timeSinceMessageMs = now - this.#lastAnyMs;
    
    const healthy = this.#running &&
      timeSinceSyncMs < this.#config.syncTimeoutMs &&
      timeSinceMessageMs < this.#config.idleTimeoutMs;

    return {
      running: this.#running,
      timeSinceSyncMs,
      timeSinceMessageMs,
      healthy
    };
  }
}
