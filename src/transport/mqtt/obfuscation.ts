/**
 * MQTT Obfuscation Layer
 * 
 * Implements MQTT-specific anti-detection techniques:
 * - Topic subscription order randomization
 * - Presence pattern variation
 * - Connection timing jitter
 * - Publish spacing randomization
 * 
 * These techniques make MQTT traffic patterns less predictable and
 * harder to distinguish from legitimate human-driven sessions.
 */

import { randomBytes } from "node:crypto";

/**
 * MQTT obfuscation configuration
 */
export interface MqttObfuscationConfig {
  /** Enable MQTT obfuscation. Default: true */
  readonly enabled: boolean;
  /** Randomize topic subscription order. Default: true */
  readonly randomizeSubscriptionOrder: boolean;
  /** Add jitter to presence publishes. Default: true */
  readonly varyPresencePattern: boolean;
  /** Presence publish interval jitter range in ms. Default: [5000, 15000] */
  readonly presenceIntervalJitterMs: [number, number];
  /** Delay between MQTT operations in ms. Default: [50, 300] */
  readonly operationDelayMs: [number, number];
}

export const DEFAULT_MQTT_OBFUSCATION_CONFIG: MqttObfuscationConfig = {
  enabled: true,
  randomizeSubscriptionOrder: true,
  varyPresencePattern: true,
  presenceIntervalJitterMs: [5000, 15000], // 5-15 seconds variance
  operationDelayMs: [50, 300], // 50-300ms between operations
};

/**
 * Fisher-Yates shuffle algorithm for randomizing array order
 */
function shuffleArray<T>(array: readonly T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Generates a random delay within the specified range
 */
function randomDelay(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Adds cryptographic entropy to timing
 */
function cryptoJitter(baseMs: number, variancePercent: number = 20): number {
  const bytes = randomBytes(2);
  const random = bytes.readUInt16BE(0) / 0xFFFF; // 0.0 to 1.0
  const variance = baseMs * (variancePercent / 100);
  const jitter = (random * 2 - 1) * variance; // -variance to +variance
  return Math.floor(baseMs + jitter);
}

/**
 * MQTT Obfuscation Manager
 * 
 * Manages obfuscation of MQTT traffic patterns to avoid detection.
 */
export class MqttObfuscationManager {
  readonly #config: MqttObfuscationConfig;
  #lastPresencePublishMs: number = 0;
  #presenceIntervalMs: number;
  #subscriptionOrderSeed: number;

  constructor(config: Partial<MqttObfuscationConfig> = {}) {
    this.#config = { ...DEFAULT_MQTT_OBFUSCATION_CONFIG, ...config };
    this.#presenceIntervalMs = this.#calculatePresenceInterval();
    this.#subscriptionOrderSeed = Math.random();
  }

  /**
   * Randomizes the order of topic subscriptions.
   * Makes the subscription pattern less predictable.
   */
  randomizeTopicOrder(topics: readonly string[]): string[] {
    if (!this.#config.enabled || !this.#config.randomizeSubscriptionOrder) {
      return [...topics];
    }
    return shuffleArray(topics);
  }

  /**
   * Calculates the next presence publish interval with jitter.
   * Varies timing to avoid predictable patterns.
   */
  #calculatePresenceInterval(): number {
    if (!this.#config.enabled || !this.#config.varyPresencePattern) {
      return 60_000; // Default 60s
    }

    const [minMs, maxMs] = this.#config.presenceIntervalJitterMs;
    const baseInterval = 60_000; // 1 minute base
    const jitter = randomDelay(minMs, maxMs);
    return baseInterval + jitter;
  }

  /**
   * Gets the delay in milliseconds before the next presence publish.
   * Returns 0 if it's time to publish immediately.
   */
  getPresencePublishDelay(): number {
    if (!this.#config.enabled) {
      return 0;
    }

    const now = Date.now();
    const timeSinceLastPublish = now - this.#lastPresencePublishMs;

    if (timeSinceLastPublish >= this.#presenceIntervalMs) {
      return 0;
    }

    return this.#presenceIntervalMs - timeSinceLastPublish;
  }

  /**
   * Records that a presence publish occurred and calculates next interval.
   */
  recordPresencePublish(): void {
    this.#lastPresencePublishMs = Date.now();
    this.#presenceIntervalMs = this.#calculatePresenceInterval();
  }

  /**
   * Gets a randomized delay for MQTT operations (subscribe, publish, etc.).
   * Adds natural variability to avoid metronomic patterns.
   */
  getOperationDelay(): number {
    if (!this.#config.enabled) {
      return 0;
    }

    const [minMs, maxMs] = this.#config.operationDelayMs;
    return randomDelay(minMs, maxMs);
  }

  /**
   * Applies jitter to a base delay value.
   * Uses cryptographic randomness for higher quality variance.
   */
  applyJitter(baseMs: number, variancePercent: number = 20): number {
    if (!this.#config.enabled) {
      return baseMs;
    }
    return cryptoJitter(baseMs, variancePercent);
  }

  /**
   * Generates a random session-scoped delay for connection establishment.
   * Prevents all instances from connecting at the exact same time.
   */
  getConnectionJitter(): number {
    if (!this.#config.enabled) {
      return 0;
    }
    // 0-5 second jitter on initial connection
    return randomDelay(0, 5000);
  }

  /**
   * Calculates adaptive delay between sequential MQTT publishes.
   * Longer delays for high-frequency operations to avoid bursts.
   */
  getPublishSpacingDelay(recentPublishCount: number): number {
    if (!this.#config.enabled) {
      return 0;
    }

    // Base delay increases with burst activity
    const baseDelay = Math.min(100 + recentPublishCount * 20, 500);
    return this.applyJitter(baseDelay, 30);
  }

  /**
   * Determines if a presence publish should be sent now.
   * Varies the pattern to avoid predictable "heartbeat" timing.
   */
  shouldPublishPresence(): boolean {
    if (!this.#config.enabled || !this.#config.varyPresencePattern) {
      return true; // Let caller decide
    }

    // Sometimes skip presence to vary the pattern (10% chance)
    if (Math.random() < 0.10) {
      return false;
    }

    return this.getPresencePublishDelay() === 0;
  }

  /**
   * Gets the delay before subscribing to a specific topic.
   * Staggers subscriptions to avoid burst patterns.
   */
  getSubscriptionDelay(topicIndex: number, totalTopics: number): number {
    if (!this.#config.enabled) {
      return 0;
    }

    // Stagger subscriptions: 10-50ms per topic
    const baseDelay = topicIndex * 30;
    return this.applyJitter(baseDelay, 40);
  }

  /**
   * Generates entropy for MQTT client ID to make it unique per session.
   */
  generateClientIdEntropy(): string {
    return randomBytes(4).toString("hex");
  }

  /**
   * Resets internal state (useful for reconnections)
   */
  reset(): void {
    this.#lastPresencePublishMs = 0;
    this.#presenceIntervalMs = this.#calculatePresenceInterval();
    this.#subscriptionOrderSeed = Math.random();
  }
}

/**
 * Helper to add delay between operations
 */
export async function applyObfuscationDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

/**
 * Tracks recent publish activity to adapt spacing
 */
export class PublishRateTracker {
  readonly #window: number[] = [];
  readonly #windowSizeMs: number = 10_000; // 10 second window

  recordPublish(): void {
    const now = Date.now();
    this.#window.push(now);
    
    // Remove old entries outside the window
    const cutoff = now - this.#windowSizeMs;
    while (this.#window.length > 0 && this.#window[0]! < cutoff) {
      this.#window.shift();
    }
  }

  getRecentCount(): number {
    return this.#window.length;
  }

  reset(): void {
    this.#window.length = 0;
  }
}
