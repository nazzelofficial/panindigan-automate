/**
 * LRU cache with per-entity TTLs and tag-based invalidation, behind the
 * `CacheAdapter` interface.
 */

import { LRUCache } from "lru-cache";
import type { CacheAdapter } from "../types/index.js";

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAtMs: number | null;
  readonly tags: readonly string[];
}

export interface CacheAdapterStats {
  hits: number;
  misses: number;
  hitRate: number;
  sets: number;
  invalidations: number;
}

/**
 * The default `CacheAdapter`: an in-process LRU with per-entry TTLs and
 * tag-based invalidation. Not shared across processes.
 */
export class LruCache implements CacheAdapter {
  readonly #lru: LRUCache<string, CacheEntry>;
  readonly #tags = new Map<string, Set<string>>();
  readonly #stats = { hits: 0, misses: 0, sets: 0, invalidations: 0 };

  constructor(maxItems: number) {
    this.#lru = new LRUCache<string, CacheEntry>({
      max: Math.max(1, maxItems),
      // A hard ceiling on entry lifetime, so entries always eventually go
      // even when no TTL was requested.
      ttl: 24 * 60 * 60 * 1000,
      dispose: (value, key) => {
        this.#removeFromTags(key, value);
      },
    });
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.#lru.get(key);
    if (entry === undefined) {
      this.#stats.misses += 1;
      return null;
    }
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.#lru.delete(key);
      this.#stats.misses += 1;
      return null;
    }
    this.#stats.hits += 1;
    return entry.value as T;
  }

  async set(
    key: string,
    value: unknown,
    options?: { readonly ttlSeconds?: number | undefined; readonly tags?: readonly string[] | undefined },
  ): Promise<void> {
    const tags = options?.tags ?? [];
    const ttlSeconds = options?.ttlSeconds;
    const entry: CacheEntry = {
      value,
      expiresAtMs: ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000,
      tags,
    };
    const previous = this.#lru.get(key);
    if (previous !== undefined) {
      this.#removeFromTags(key, previous);
    }
    this.#lru.set(
      key,
      entry,
      ttlSeconds === undefined ? {} : { ttl: Math.max(1, ttlSeconds * 1000) },
    );
    for (const tag of tags) {
      let keys = this.#tags.get(tag);
      if (keys === undefined) {
        keys = new Set<string>();
        this.#tags.set(tag, keys);
      }
      keys.add(key);
    }
    this.#stats.sets += 1;
  }

  async delete(key: string): Promise<void> {
    this.#lru.delete(key);
  }

  async fetch<T>(
    key: string,
    options: { readonly ttlSeconds?: number | undefined; readonly tags?: readonly string[] | undefined },
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    const loaded = await loader();
    await this.set(key, loaded, options);
    return loaded;
  }

  async invalidateTag(tag: string): Promise<void> {
    const keys = this.#tags.get(tag);
    if (keys === undefined) {
      return;
    }
    for (const key of keys) {
      this.#lru.delete(key);
    }
    this.#tags.delete(tag);
    this.#stats.invalidations += 1;
  }

  async clear(): Promise<void> {
    this.#lru.clear();
    this.#tags.clear();
    this.#stats.invalidations += 1;
  }

  stats(): CacheAdapterStats {
    const total = this.#stats.hits + this.#stats.misses;
    return {
      hits: this.#stats.hits,
      misses: this.#stats.misses,
      hitRate: total === 0 ? 0 : this.#stats.hits / total,
      sets: this.#stats.sets,
      invalidations: this.#stats.invalidations,
    };
  }

  #removeFromTags(key: string, entry: CacheEntry): void {
    for (const tag of entry.tags) {
      this.#tags.get(tag)?.delete(key);
    }
  }
}

/**
 * A `CacheAdapter` whose keys are namespaced under a prefix. Plugins get
 * one of these so their entries can never collide with the library's or
 * with another plugin's.
 */
export class NamespacedCache implements CacheAdapter {
  readonly #delegate: CacheAdapter;
  readonly #prefix: string;
  readonly #written = new Set<string>();

  constructor(delegate: CacheAdapter, prefix: string) {
    this.#delegate = delegate;
    this.#prefix = prefix;
  }

  async get<T>(key: string): Promise<T | null> {
    return this.#delegate.get<T>(`${this.#prefix}:${key}`);
  }

  async set(
    key: string,
    value: unknown,
    options?: { readonly ttlSeconds?: number | undefined; readonly tags?: readonly string[] | undefined },
  ): Promise<void> {
    const namespaced = `${this.#prefix}:${key}`;
    await this.#delegate.set(namespaced, value, {
      ttlSeconds: options?.ttlSeconds,
      tags: options?.tags?.map((tag) => `${this.#prefix}:${tag}`),
    });
    this.#written.add(namespaced);
  }

  async delete(key: string): Promise<void> {
    const namespaced = `${this.#prefix}:${key}`;
    await this.#delegate.delete(namespaced);
    this.#written.delete(namespaced);
  }

  async fetch<T>(
    key: string,
    options: { readonly ttlSeconds?: number | undefined; readonly tags?: readonly string[] | undefined },
    loader: () => Promise<T>,
  ): Promise<T> {
    const namespaced = `${this.#prefix}:${key}`;
    const result = await this.#delegate.fetch<T>(
      namespaced,
      {
        ttlSeconds: options.ttlSeconds,
        tags: options.tags?.map((tag) => `${this.#prefix}:${tag}`),
      },
      loader,
    );
    this.#written.add(namespaced);
    return result;
  }

  async invalidateTag(tag: string): Promise<void> {
    await this.#delegate.invalidateTag(`${this.#prefix}:${tag}`);
  }

  async clear(): Promise<void> {
    for (const key of this.#written) {
      await this.#delegate.delete(key);
    }
    this.#written.clear();
  }

  stats(): CacheAdapterStats {
    return this.#delegate.stats();
  }
}
