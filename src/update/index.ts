/**
 * Safe Update Checker (B) — opt-in, announce-only by default.
 *
 * Nothing happens unless `update.enabled` is explicitly set. The checker
 * reads the npm registry at most once per `checkIntervalMs` (default one
 * day), logs "update available", and stores the verdict — it never
 * installs anything by itself. `install()` is always an explicit,
 * user-invoked call that:
 *   1. prints a plan (current → latest);
 *   2. backs up node_modules/panindigan-automate;
 *   3. installs;
 *   4. rolls the backup back on any failure;
 *   5. requires a process restart on success.
 *
 * Not a silent "self-healing" mechanism. Restart is on you.
 */

import { exec } from "node:child_process";
import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger/index.js";
import type { StorageAdapter } from "../types/index.js";

export interface UpdateCheckerOptions {
  /** Master switch. Default false — nothing checks without opt-in. */
  readonly enabled?: boolean | undefined;
  /** Minimum ms between registry checks. Default 24h. */
  readonly checkIntervalMs?: number | undefined;
}

export interface UpdateInfo {
  readonly current: string;
  readonly latest: string;
  readonly url: string;
  readonly checkedAt: number;
}

const REGISTRY_URL = "https://registry.npmjs.org/panindigan-automate/latest";
const LAST_CHECK_KEY = "update:lastCheck";
const BACKUP_KEY_PREFIX = ".panindigan-automate-backup-";

/** Minimal semver compare: true when `a` is strictly older than `b`. */
export function isOlder(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d < 0;
    }
  }
  return false;
}

export class UpdateChecker {
  readonly #logger: Logger;
  readonly #storage: StorageAdapter;
  readonly #version: string;
  readonly #enabled: boolean;
  readonly #checkIntervalMs: number;

  constructor(deps: {
    options?: UpdateCheckerOptions | undefined;
    logger: Logger;
    storage: StorageAdapter;
    version: string;
  }) {
    this.#logger = deps.logger.child({ module: "update" });
    this.#storage = deps.storage;
    this.#version = deps.version;
    this.#enabled = deps.options?.enabled ?? false;
    this.#checkIntervalMs = deps.options?.checkIntervalMs ?? 24 * 60 * 60 * 1000;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /**
   * Announce-only check. No-op (returns null) unless `enabled`; at most one
   * registry hit per `checkIntervalMs`. Never installs.
   */
  async check(): Promise<UpdateInfo | null> {
    if (!this.#enabled) {
      this.#logger.debug("update checker disabled");
      return null;
    }
    const last = await this.#storage.get<number>(LAST_CHECK_KEY);
    if (last !== null && Date.now() - last < this.#checkIntervalMs) {
      this.#logger.debug({ checkedAt: last }, "update check skipped — too soon since the last one");
      return null;
    }
    const latest = await this.#fetchLatest();
    await this.#storage.set(LAST_CHECK_KEY, Date.now());
    if (latest === null) {
      return null;
    }
    if (!isOlder(this.#version, latest.version)) {
      this.#logger.debug({ current: this.#version, latest: latest.version }, "already up to date");
      return null;
    }
    const info: UpdateInfo = {
      current: this.#version,
      latest: latest.version,
      url: latest.url,
      checkedAt: Date.now(),
    };
    this.#logger.info({ current: this.#version, latest: latest.version }, "update available");
    return info;
  }

  /**
   * Explicit, user-invoked install of the latest published version.
   * Backs up node_modules/panindigan-automate, installs, and rolls back on
   * failure. On success the process must be restarted by the caller.
   */
  async install(): Promise<{ installed: true; from: string; to: string; requiresRestart: true }> {
    const latest = await this.#fetchLatest();
    if (latest === null) {
      throw new Error("could not reach the npm registry — install aborted, nothing changed");
    }
    if (!isOlder(this.#version, latest.version)) {
      this.#logger.info({ version: this.#version }, "already up to date");
      return { installed: true, from: this.#version, to: this.#version, requiresRestart: true };
    }

    const cwd = process.cwd();
    const pkgDir = join(cwd, "node_modules", "panindigan-automate");
    const backupDir = join(cwd, "node_modules", `${BACKUP_KEY_PREFIX}${Date.now()}`);

    let backedUp = false;
    try {
      await stat(pkgDir);
      this.#logger.info({ backupDir }, "backing up installed package");
      await rename(pkgDir, backupDir);
      backedUp = true;
    } catch {
      // Package not installed under cwd (or unreadable) — install fresh without a backup.
      this.#logger.debug("no installed panindigan-automate under node_modules — installing without backup");
    }

    try {
      this.#logger.warn({ from: this.#version, to: latest.version }, "installing update — process restart required");
      await run(`${packageManager()} add panindigan-automate@latest`, cwd);
    } catch (error) {
      if (backedUp) {
        this.#logger.error({ err: errorMessage(error) }, "install failed — rolling back the backup");
        await rm(pkgDir, { recursive: true, force: true }).catch(() => undefined);
        await rename(backupDir, pkgDir).catch(() => undefined);
      }
      throw new Error(`update install failed and was rolled back: ${errorMessage(error)}`);
    }

    return { installed: true, from: this.#version, to: latest.version, requiresRestart: true };
  }

  async #fetchLatest(): Promise<{ version: string; url: string } | null> {
    try {
      const response = await fetch(REGISTRY_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        this.#logger.warn({ status: response.status }, "registry answered with an error");
        return null;
      }
      const body = (await response.json()) as { version?: unknown; dist?: { tarball?: unknown } };
      const version = typeof body.version === "string" ? body.version : null;
      const tarball = typeof body.dist?.tarball === "string" ? body.dist.tarball : REGISTRY_URL;
      if (version === null) {
        return null;
      }
      return { version, url: tarball };
    } catch (error) {
      this.#logger.warn({ err: errorMessage(error) }, "could not fetch the latest version");
      return null;
    }
  }
}

function packageManager(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function run(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: 5 * 60_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
