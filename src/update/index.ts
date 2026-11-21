/**
 * Automatic Update Checker.
 *
 * On by default since 0.2.0: a client constructed with no `update` options
 * checks the npm registry on startup and every 24 hours, and installs a
 * newer published version automatically (backup before install, rollback on
 * failure; a process restart is required to activate the new version).
 *
 * Opt out with `update: { enabled: false }` (nothing is ever checked),
 * or `update: { autoInstall: false }` (announce-only — log and store the
 * verdict, `check()` returns it, nothing is installed).
 *
 * The public API is two-tier:
 *  1. The classic explicit surface — `check()` (announce-only) and
 *     `install()` — kept for backward compatibility with 0.1.9.
 *  2. The automatic surface — `initialize()` / `checkForUpdates()` /
 *     `installUpdate()` / `getStatus()` / `getHistory()` / `stop()` —
 *     used by the client when `enabled` (the default).
 */

import { exec } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, rename, rm, stat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger/index.js";
import type { StorageAdapter } from "../types/index.js";
import { getUpdateType } from "./semver.js";

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface PackageManagerInfo {
  readonly name: PackageManager;
  readonly version: string | null;
  readonly lockfile: string | null;
}

const REGISTRY_URL = "https://registry.npmjs.org/panindigan-automate";
const LAST_CHECK_KEY = "update:lastCheck";
const BACKUP_KEY_PREFIX = ".panindigan-automate-backup-";
const MAX_HISTORY = 10;

export interface UpdateCheckerOptions {
  /** Master switch. Default false — nothing checks without opt-in. */
  readonly enabled?: boolean | undefined;
  /** Check on startup. Default true when `enabled`. */
  readonly checkOnStartup?: boolean | undefined;
  /** Install automatically when an update is found. Default false. */
  readonly autoInstall?: boolean | undefined;
  /** Minimum ms between registry checks. Default 24h. */
  readonly checkIntervalMs?: number | undefined;
  /** Minimum ms between registry checks (alias of `checkIntervalMs`). */
  readonly checkInterval?: number | undefined;
  /** Package manager override. Auto-detected from the lockfile when unset. */
  readonly packageManager?: PackageManager | undefined;
  /** npm dist-tag to follow. Default "latest". */
  readonly releaseChannel?: string | undefined;
  /** Registry request timeout in ms. Default 30s. */
  readonly timeout?: number | undefined;
  /** Restart the process after a successful install. Default false. */
  readonly autoRestart?: boolean | undefined;
  /** Allow installing prereleases. Default false. */
  readonly allowPrerelease?: boolean | undefined;
}

export interface UpdateCheckerDeps {
  options?: UpdateCheckerOptions | undefined;
  logger: Logger;
  storage: StorageAdapter;
  version: string;
}

export interface UpdateInfo {
  readonly current: string;
  readonly latest: string;
  readonly url: string;
  readonly checkedAt: number;
}

export interface UpdateCheckResult {
  readonly updateAvailable: boolean;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly updateType: "major" | "minor" | "patch" | "prerelease" | "none" | null;
  readonly publishedAt: string | null;
}

export interface UpdateHistory {
  readonly timestamp: Date;
  readonly from: string;
  readonly to: string;
  readonly success: boolean;
  readonly error: string | null;
}

export type InstallationStatus =
  | "idle"
  | "checking"
  | "available"
  | "installing"
  | "installed"
  | "failed";

export interface UpdateStatus {
  readonly installedVersion: string;
  readonly latestVersion: string | null;
  readonly updateAvailable: boolean;
  readonly lastChecked: Date | null;
  readonly installationStatus: InstallationStatus;
  readonly installationError: string | null;
  readonly packageManager: PackageManager | null;
  readonly restartRequired: boolean;
  readonly history: ReadonlyArray<UpdateHistory>;
}

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

/** The package manager in use for this project, if one can be detected. */
export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    const names = new Set(entries.map((e) => e.name));
    if (names.has("pnpm-lock.yaml")) return "pnpm";
    if (names.has("yarn.lock")) return "yarn";
    if (names.has("package-lock.json") || names.has("npm-shrinkwrap.json")) return "npm";
  } catch {
    // fall through to npm default
  }
  return "npm";
}

export async function getPackageManagerInfo(
  manager: PackageManager,
): Promise<PackageManagerInfo> {
  const lockfile = await readFile(
    join(process.cwd(), manager === "pnpm" ? "pnpm-lock.yaml" : manager === "yarn" ? "yarn.lock" : "package-lock.json"),
    "utf8",
  )
    .then(() => (manager === "pnpm" ? "pnpm-lock.yaml" : manager === "yarn" ? "yarn.lock" : "package-lock.json"))
    .catch(() => null);
  const version = await run(`${manager} --version`, process.cwd()).catch(() => null);
  return { name: manager, version: version?.trim() || null, lockfile };
}

export async function validatePackageManager(manager: PackageManager): Promise<boolean> {
  try {
    const out = await run(`${manager} --version`, process.cwd(), 15_000);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export async function installPackageVersion(
  packageName: string,
  version: string,
  manager: PackageManager,
  timeoutMs = 120_000,
): Promise<{ success: boolean; stderr: string | null; error: string | null }> {
  const add = manager === "yarn" ? `yarn add` : `${manager} add`;
  try {
    await run(`${add} ${packageName}@${version}`, process.cwd(), timeoutMs);
    return { success: true, stderr: null, error: null };
  } catch (error) {
    const message = errorMessage(error);
    return { success: false, stderr: message, error: message };
  }
}

/**
 * Preflight for runtime self-updates. A process can only hot-swap its own
 * package when its install root is writable. Container hosts (Render/Docker)
 * run as a non-root user against a root-owned, read-only `node_modules` built
 * from a frozen lockfile — a runtime `pnpm add` there cannot work and any
 * change is discarded on restart. Detect that up front so the checker reports
 * an honest, actionable error instead of a false success.
 */
export async function canInstallAtRuntime(cwd: string = process.cwd()): Promise<{
  possible: boolean;
  reason: string | null;
}> {
  const pkgJson = join(cwd, "package.json");
  const nodeModules = join(cwd, "node_modules");
  try {
    await access(pkgJson, fsConstants.W_OK);
  } catch {
    return {
      possible: false,
      reason:
        "package.json is not writable by this user — a runtime update cannot persist. Redeploy with the new version instead.",
    };
  }
  try {
    await access(nodeModules, fsConstants.W_OK);
  } catch {
    return {
      possible: false,
      reason:
        "node_modules is not writable by this user (read-only container layer / frozen lockfile). Runtime self-update is not possible here — redeploy with the new version instead.",
    };
  }
  return { possible: true, reason: null };
}

export const DEFAULT_UPDATE_CONFIG: Readonly<Required<Omit<UpdateCheckerOptions, "packageManager" | "releaseChannel" | "timeout">>> = Object.freeze({
  enabled: true,
  checkOnStartup: true,
  autoInstall: true,
  checkIntervalMs: 24 * 60 * 60 * 1000,
  checkInterval: 24 * 60 * 60 * 1000,
  autoRestart: false,
  allowPrerelease: false,
});

/**
 * Checks the npm registry for updates and installs them — on by default
 * since 0.2.0. Opt out with `update: { enabled: false }` (off) or
 * `autoInstall: false` (announce-only).
 */
export class UpdateChecker {
  readonly #logger: Logger;
  readonly #storage: StorageAdapter;
  readonly #version: string;

  #isChecking = false;
  #isInstalling = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #status = {
    installedVersion: "",
    latestVersion: null as string | null,
    updateAvailable: false,
    lastChecked: null as Date | null,
    installationStatus: "idle" as InstallationStatus,
    installationError: null as string | null,
    packageManager: null as PackageManager | null,
    restartRequired: false,
    history: [] as UpdateHistory[],
  };

  readonly #config: Readonly<{
    enabled: boolean;
    checkOnStartup: boolean;
    autoInstall: boolean;
    checkInterval: number;
    checkIntervalMs: number;
    packageManager?: PackageManager | undefined;
    releaseChannel?: string | undefined;
    timeout?: number | undefined;
    autoRestart: boolean;
    allowPrerelease: boolean;
  }>;

  constructor(deps: UpdateCheckerDeps) {
    this.#logger = deps.logger.child({ module: "update" });
    this.#storage = deps.storage;
    this.#version = deps.version;
    const interval = deps.options?.checkIntervalMs ?? deps.options?.checkInterval ?? 24 * 60 * 60 * 1000;
    this.#config = Object.freeze({
      enabled: deps.options?.enabled ?? true,
      checkOnStartup: deps.options?.checkOnStartup ?? true,
      autoInstall: deps.options?.autoInstall ?? true,
      checkInterval: interval,
      checkIntervalMs: interval,
      ...(deps.options?.packageManager !== undefined
        ? { packageManager: deps.options.packageManager }
        : {}),
      ...(deps.options?.releaseChannel !== undefined
        ? { releaseChannel: deps.options.releaseChannel }
        : {}),
      ...(deps.options?.timeout !== undefined ? { timeout: deps.options.timeout } : {}),
      autoRestart: deps.options?.autoRestart ?? false,
      allowPrerelease: deps.options?.allowPrerelease ?? false,
    });
    this.#status.installedVersion = this.#version;
  }

  get enabled(): boolean {
    return this.#config.enabled;
  }

  /**
   * Announce-only check. No-op (returns null) unless `enabled`; at most one
   * registry hit per `checkIntervalMs`. Never installs.
   */
  async check(): Promise<UpdateInfo | null> {
    if (!this.#config.enabled) {
      this.#logger.debug("update checker disabled");
      return null;
    }

    const last = await this.#storage.get<number>(LAST_CHECK_KEY);
    if (last !== null && typeof last === "number" && Date.now() - last < this.#config.checkInterval) {
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
   * Called by the client after construction. Nothing happens unless
   * `enabled`; an automatic check is performed at most once per interval,
   * and an automatic install is performed only when `autoInstall` is set.
   */
  async initialize(): Promise<void> {
    if (!this.#config.enabled) {
      this.#logger.debug("update checker disabled");
      return;
    }

    if (this.#config.checkOnStartup) {
      this.#logger.info("Checking for updates on startup");
      await this.checkForUpdates();
    }

    if (this.#config.checkInterval > 0) {
      this.#scheduleCheck();
    }
  }

  /**
   * Checks for updates and — only when `autoInstall` is set — installs
   * automatically. Returns the verdict either way.
   */
  async checkForUpdates(): Promise<UpdateCheckResult> {
    if (this.#isChecking) {
      this.#logger.debug("Update check already in progress");
      return {
        updateAvailable: this.#status.updateAvailable,
        currentVersion: this.#version,
        latestVersion: this.#status.latestVersion,
        updateType: null,
        publishedAt: null,
      };
    }

    this.#isChecking = true;
    this.#status = { ...this.#status, installationStatus: "checking" };

    try {
      const tag = this.#config.releaseChannel ?? "latest";
      const latestInfo = await this.#fetchLatest(tag);

      if (latestInfo === null) {
        this.#logger.warn("Failed to fetch latest version from registry");
        this.#status = { ...this.#status, installationStatus: "idle", lastChecked: new Date() };
        return {
          updateAvailable: false,
          currentVersion: this.#version,
          latestVersion: null,
          updateType: null,
          publishedAt: null,
        };
      }

      const target = latestInfo.version;
      const updateAvailable = isOlder(this.#version, target);
      const updateType = updateAvailable ? getUpdateType(this.#version, target) : "none";

      if (updateAvailable) {
        this.#logger.info(
          { current: this.#version, latest: target, type: updateType },
          "Update available",
        );
      } else {
        this.#logger.debug({ current: this.#version, latest: target }, "Already up to date");
      }

      this.#status = {
        ...this.#status,
        latestVersion: target,
        updateAvailable,
        lastChecked: new Date(),
        installationStatus: updateAvailable ? "available" : "idle",
      };

      const result: UpdateCheckResult = {
        updateAvailable,
        currentVersion: this.#version,
        latestVersion: target,
        updateType,
        publishedAt: latestInfo.publishedAt ?? null,
      };

      if (updateAvailable && this.#config.autoInstall) {
        await this.installUpdate();
      }

      return result;
    } finally {
      this.#isChecking = false;
    }
  }

  /**
   * Installs the latest available update with backup and rollback. Never
   * called unless explicitly requested or `autoInstall` is set.
   */
  async installUpdate(): Promise<boolean> {
    const targetVersion = this.#status.latestVersion ?? (await this.#fetchLatest())?.version ?? null;
    if (targetVersion === null || !isOlder(this.#version, targetVersion)) {
      this.#logger.warn("No update available to install");
      return false;
    }
    if (this.#isInstalling) {
      this.#logger.warn("Installation already in progress");
      return false;
    }

    // Preflight: never claim an update is installable when the install root
    // is read-only (container hosts). Report the real, actionable reason.
    const environment = await canInstallAtRuntime(process.cwd());
    if (!environment.possible) {
      const reason = environment.reason ?? "runtime update is not possible";
      this.#logger.error({ reason, from: this.#version, to: targetVersion }, "Runtime update not possible");
      this.#status = {
        ...this.#status,
        installationStatus: "failed",
        installationError: reason,
      };
      this.#pushHistory({ timestamp: new Date(), from: this.#version, to: targetVersion, success: false, error: reason });
      return false;
    }

    this.#isInstalling = true;
    this.#status = { ...this.#status, installationStatus: "installing", installationError: null };

    this.#logger.info({ from: this.#version, to: targetVersion }, "Starting update installation");

    try {
      const packageManager =
        this.#config.packageManager ?? (await detectPackageManager(process.cwd()));
      this.#status = { ...this.#status, packageManager };

      const isValid = await validatePackageManager(packageManager);
      if (!isValid) {
        const error = `Package manager "${packageManager}" not available`;
        this.#logger.error(error);
        this.#status = {
          ...this.#status,
          installationStatus: "failed",
          installationError: error,
        };
        return false;
      }

      const pmInfo = await getPackageManagerInfo(packageManager);
      if (pmInfo) {
        this.#logger.info({ packageManager: pmInfo.name, version: pmInfo.version }, "Using package manager");
      }

      // Back up node_modules/panindigan-automate before installing.
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
        this.#logger.debug("no installed panindigan-automate under node_modules — installing without backup");
      }

      const result = await installPackageVersion("panindigan-automate", targetVersion, packageManager, 120_000);

      if (result.success) {
        this.#logger.info({ from: this.#version, to: targetVersion }, "Update installed successfully");
        this.#logger.info("Restart required to use the new version");

        this.#status = {
          ...this.#status,
          latestVersion: targetVersion,
          installationStatus: "installed",
          restartRequired: true,
        };

        this.#pushHistory({
          timestamp: new Date(),
          from: this.#version,
          to: targetVersion,
          success: true,
          error: null,
        });

        // autoRestart was a documented but dead option. When enabled, exit
        // so the platform's process manager starts the new version. Guard
        // against a restart loop with a storage marker for the target version.
        if (this.#config.autoRestart) {
          const restartKey = `update:restartedTo:${targetVersion}`;
          const alreadyRestarted = await this.#storage.get<boolean>(restartKey);
          if (alreadyRestarted !== true) {
            await this.#storage.set(restartKey, true);
            this.#logger.warn({ to: targetVersion }, "autoRestart enabled — exiting so the new version loads");
            setTimeout(() => process.exit(0), 250).unref?.();
          }
        }

        return true;
      }

      const error = result.error ?? "Installation failed";
      this.#logger.error({ error, stderr: result.stderr }, "Update installation failed");

      if (backedUp) {
        this.#logger.warn({ backupDir }, "rolling back the backup");
        await rm(pkgDir, { recursive: true, force: true }).catch(() => undefined);
        await rename(backupDir, pkgDir).catch(() => undefined);
      }

      this.#status = {
        ...this.#status,
        installationStatus: "failed",
        installationError: error,
      };

      this.#pushHistory({
        timestamp: new Date(),
        from: this.#version,
        to: targetVersion,
        success: false,
        error,
      });

      return false;
    } catch (error) {
      const message = errorMessage(error);
      this.#logger.error({ error: message }, "Unexpected error during installation");

      this.#status = {
        ...this.#status,
        installationStatus: "failed",
        installationError: message,
      };

      return false;
    } finally {
      this.#isInstalling = false;
    }
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

  #pushHistory(entry: UpdateHistory): void {
    const history = [...this.#status.history, entry].slice(-MAX_HISTORY);
    this.#status = { ...this.#status, history };
  }

  getStatus(): UpdateStatus {
    return {
      ...this.#status,
      history: [...this.#status.history],
    };
  }

  getHistory(): ReadonlyArray<UpdateHistory> {
    return this.#status.history;
  }

  getLatestVersion(): string | null {
    return this.#status.latestVersion;
  }

  /** Stops the periodic update timer. Idempotent; safe to call during shutdown. */
  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #scheduleCheck(): void {
    this.stop();
    this.#timer = setInterval(() => {
      void this.checkForUpdates().catch((error) => {
        this.#logger.warn({ err: errorMessage(error) }, "scheduled update check failed");
      });
    }, this.#config.checkInterval);
    if (typeof this.#timer.unref === "function") {
      this.#timer.unref();
    }
  }

  async #fetchLatest(tag: string = "latest"): Promise<{
    version: string;
    url: string;
    publishedAt: string | null;
  } | null> {
    try {
      const url = tag === "latest"
        ? `${REGISTRY_URL}/latest`
        : `${REGISTRY_URL}/${encodeURIComponent(tag)}`;
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.#config.timeout ?? 30_000),
      });
      if (!response.ok) {
        this.#logger.warn({ status: response.status }, "registry answered with an error");
        return null;
      }
      const body = (await response.json()) as {
        version?: unknown;
        dist?: { tarball?: unknown } | undefined;
        time?: Record<string, unknown> | undefined;
        license?: unknown;
      };
      const version = typeof body.version === "string" ? body.version : null;
      const tarball = typeof body.dist?.tarball === "string" ? body.dist.tarball : REGISTRY_URL;
      const publishedAt =
        typeof body.time === "object" && body.time !== null && typeof body.time[version ?? ""] === "string"
          ? (body.time[version ?? ""] as string)
          : null;
      if (version === null) {
        return null;
      }
      if (!this.#config.allowPrerelease && PRE_RELEASE_TAG.test(version)) {
        // The registry points at a prerelease and prereleases are not
        // allowed — treat it exactly like any other "no update" answer.
        this.#logger.debug({ version }, "latest dist-tag is a prerelease — skipping it");
        return null;
      }
      return { version, url: tarball, publishedAt };
    } catch (error) {
      this.#logger.warn({ err: errorMessage(error) }, "could not fetch the latest version");
      return null;
    }
  }
}

const PRE_RELEASE_TAG = /-/;

function packageManager(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function run(command: string, cwd: string, timeoutMs = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
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
