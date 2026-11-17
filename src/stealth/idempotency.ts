/**
 * Idempotent Send (G5)
 * 
 * Every outbound message gets a client-side idempotency key.
 * Retries after timeout reuse the key → no duplicate messages ever.
 * Retry-safe by construction.
 */

import type { Logger } from "../logger/index.js";
import type { StorageAdapter } from "../types/index.js";

/** Idempotency configuration */
export interface IdempotencyConfig {
  /** Enable idempotency (default: true) */
  readonly enabled: boolean;
  /** TTL for idempotency keys in ms (default: 24 hours) */
  readonly keyTTLMs: number;
  /** Maximum keys to keep in memory (default: 1000) */
  readonly maxKeys: number;
}

/** Default idempotency configuration */
export const DEFAULT_IDEMPOTENCY_CONFIG: IdempotencyConfig = {
  enabled: true,
  keyTTLMs: 24 * 60 * 60 * 1000, // 24 hours
  maxKeys: 1000,
};

/** Idempotency key entry */
interface IdempotencyEntry {
  readonly key: string;
  readonly timestamp: number;
  readonly messageId?: string;
  readonly status: "pending" | "sent" | "failed";
}

/**
 * Idempotency Manager
 * 
 * Tracks message send attempts and prevents duplicates on retry.
 */
export class IdempotencyManager {
  readonly #config: IdempotencyConfig;
  readonly #logger: Logger;
  readonly #storage: StorageAdapter;
  
  // In-memory cache for fast lookup
  #cache: Map<string, IdempotencyEntry> = new Map();
  #cleanupTimer: NodeJS.Timeout | null = null;

  constructor(deps: {
    config?: Partial<IdempotencyConfig> | undefined;
    logger: Logger;
    storage: StorageAdapter;
  }) {
    this.#config = { ...DEFAULT_IDEMPOTENCY_CONFIG, ...deps.config };
    this.#logger = deps.logger.child({ module: "idempotency" });
    this.#storage = deps.storage;
  }

  /** Start idempotency manager */
  async start(): Promise<void> {
    if (!this.#config.enabled) {
      this.#logger.debug("Idempotency disabled");
      return;
    }

    // Load persisted keys
    await this.#loadPersisted();

    // Schedule periodic cleanup
    this.#scheduleCleanup();

    this.#logger.info("Idempotency manager started");
  }

  /** Stop idempotency manager */
  stop(): void {
    if (this.#cleanupTimer !== null) {
      clearTimeout(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
    this.#logger.info("Idempotency manager stopped");
  }

  /** Generate new idempotency key */
  generateKey(operation: string, target: string, content: string): string {
    const timestamp = Date.now();
    const hash = this.#simpleHash(`${operation}:${target}:${content}:${timestamp}`);
    return `${operation}_${hash}_${timestamp}`;
  }

  /** Check if key was already processed */
  async checkKey(key: string): Promise<{
    exists: boolean;
    messageId?: string | undefined;
    status?: "pending" | "sent" | "failed" | undefined;
  }> {
    if (!this.#config.enabled) {
      return { exists: false };
    }

    // Check memory cache first
    const cached = this.#cache.get(key);
    if (cached) {
      if (this.#isExpired(cached)) {
        this.#cache.delete(key);
        return { exists: false };
      }
      return {
        exists: true,
        messageId: cached.messageId,
        status: cached.status,
      };
    }

    // Check storage
    const stored = await this.#storage.get<IdempotencyEntry>(`idempotency:${key}`);
    if (stored !== null) {
      if (this.#isExpired(stored)) {
        await this.#storage.delete(`idempotency:${key}`);
        return { exists: false };
      }
      
      // Add to cache
      this.#cache.set(key, stored);
      
      return {
        exists: true,
        messageId: stored.messageId,
        status: stored.status,
      };
    }

    return { exists: false };
  }

  /** Record new send attempt */
  async recordAttempt(key: string): Promise<void> {
    if (!this.#config.enabled) {
      return;
    }

    const entry: IdempotencyEntry = {
      key,
      timestamp: Date.now(),
      status: "pending",
    };

    this.#cache.set(key, entry);
    await this.#storage.set(`idempotency:${key}`, entry);

    this.#logger.debug({ key }, "Recorded send attempt");
  }

  /** Mark send as successful */
  async markSuccess(key: string, messageId: string): Promise<void> {
    if (!this.#config.enabled) {
      return;
    }

    const existing = this.#cache.get(key);
    const entry: IdempotencyEntry = {
      key,
      timestamp: existing?.timestamp ?? Date.now(),
      messageId,
      status: "sent",
    };

    this.#cache.set(key, entry);
    await this.#storage.set(`idempotency:${key}`, entry);

    this.#logger.debug({ key, messageId }, "Marked send as successful");
  }

  /** Mark send as failed */
  async markFailure(key: string): Promise<void> {
    if (!this.#config.enabled) {
      return;
    }

    const existing = this.#cache.get(key);
    const entry: IdempotencyEntry = {
      key,
      timestamp: existing?.timestamp ?? Date.now(),
      status: "failed",
    };

    this.#cache.set(key, entry);
    await this.#storage.set(`idempotency:${key}`, entry);

    this.#logger.debug({ key }, "Marked send as failed");
  }

  /** Check if entry is expired */
  #isExpired(entry: IdempotencyEntry): boolean {
    const age = Date.now() - entry.timestamp;
    return age > this.#config.keyTTLMs;
  }

  /** Load persisted keys on startup */
  async #loadPersisted(): Promise<void> {
    try {
      // Storage adapter doesn't support listing, so we just log
      this.#logger.debug("Idempotency keys will be loaded on demand");
    } catch (error) {
      this.#logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to load persisted idempotency keys"
      );
    }
  }

  /** Schedule periodic cleanup */
  #scheduleCleanup(): void {
    const cleanupInterval = Math.min(this.#config.keyTTLMs / 4, 60 * 60 * 1000); // Max 1 hour
    
    this.#cleanupTimer = setTimeout(() => {
      void this.#cleanup();
      this.#scheduleCleanup();
    }, cleanupInterval);
  }

  /** Clean up expired keys */
  async #cleanup(): Promise<void> {
    const before = this.#cache.size;
    const now = Date.now();

    // Clean memory cache
    for (const [key, entry] of this.#cache.entries()) {
      if (now - entry.timestamp > this.#config.keyTTLMs) {
        this.#cache.delete(key);
        // Also delete from storage
        await this.#storage.delete(`idempotency:${key}`).catch(() => {
          // Ignore errors
        });
      }
    }

    // If cache is too large, remove oldest entries
    if (this.#cache.size > this.#config.maxKeys) {
      const entries = Array.from(this.#cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      const toRemove = entries.slice(0, entries.length - this.#config.maxKeys);
      for (const [key] of toRemove) {
        this.#cache.delete(key);
      }
    }

    const removed = before - this.#cache.size;
    if (removed > 0) {
      this.#logger.debug(
        { removed, remaining: this.#cache.size },
        "Cleaned up expired idempotency keys"
      );
    }
  }

  /** Simple string hash (non-cryptographic) */
  #simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /** Get stats */
  getStats(): {
    cacheSize: number;
    enabled: boolean;
  } {
    return {
      cacheSize: this.#cache.size,
      enabled: this.#config.enabled,
    };
  }
}
