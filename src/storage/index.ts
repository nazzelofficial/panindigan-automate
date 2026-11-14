/**
 * Storage subsystem: in-memory and file-backed adapters with atomic writes.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "../logger/index.js";
import type { StorageAdapter } from "../types/index.js";

/** In-memory storage. Values are lost on process exit. */
export class MemoryStorage implements StorageAdapter {
  readonly #store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    const value = this.#store.get(key);
    return value === undefined ? null : (value as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.#store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#store.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    return [...this.#store.keys()].sort();
  }

  async clear(): Promise<void> {
    this.#store.clear();
  }
}

/**
 * File-based storage. Every key becomes a JSON document under the storage
 * directory; writes are atomic (temp file, then rename).
 */
export class FileStorage implements StorageAdapter {
  readonly #directory: string;
  readonly #logger: Logger | null;

  constructor(directory: string, logger: Logger | null = null) {
    this.#directory = directory;
    this.#logger = logger;
  }

  async get<T>(key: string): Promise<T | null> {
    const file = this.#fileFor(key);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch {
      return null;
    }
    try {
      return JSON.parse(contents) as T;
    } catch (error) {
      this.#logger?.warn({ key, file }, "Storage file is not valid JSON; ignoring");
      void error;
      return null;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const file = this.#fileFor(key);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#fileFor(key), { force: true });
  }

  async keys(): Promise<readonly string[]> {
    let entries: readonly import("node:fs").Dirent[];
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch {
      return [];
    }
    const keys: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        keys.push(decodeFileName(entry.name.slice(0, -".json".length)));
      }
    }
    return keys.sort();
  }

  async clear(): Promise<void> {
    await rm(this.#directory, { recursive: true, force: true });
  }

  #fileFor(key: string): string {
    return join(this.#directory, `${encodeFileName(key)}.json`);
  }
}

/** Maps a storage key to a filesystem-safe file stem. */
function encodeFileName(key: string): string {
  return encodeURIComponent(key).replace(/%/g, "~");
}

/** Inverse of {@link encodeFileName}. */
function decodeFileName(stem: string): string {
  return decodeURIComponent(stem.replace(/~/g, "%"));
}

/**
 * A `StorageAdapter` whose keys are namespaced under a prefix. Plugins get
 * one of these so their documents can never collide with the library's or
 * with another plugin's.
 */
export class NamespacedStorage implements StorageAdapter {
  readonly #delegate: StorageAdapter;
  readonly #prefix: string;

  constructor(delegate: StorageAdapter, prefix: string) {
    this.#delegate = delegate;
    this.#prefix = prefix;
  }

  async get<T>(key: string): Promise<T | null> {
    return this.#delegate.get<T>(`${this.#prefix}:${key}`);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.#delegate.set(`${this.#prefix}:${key}`, value);
  }

  async delete(key: string): Promise<void> {
    await this.#delegate.delete(`${this.#prefix}:${key}`);
  }

  async keys(): Promise<readonly string[]> {
    const all = await this.#delegate.keys();
    const prefix = `${this.#prefix}:`;
    return all.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  async clear(): Promise<void> {
    const own = await this.keys();
    for (const key of own) {
      await this.#delegate.delete(`${this.#prefix}:${key}`);
    }
  }
}
