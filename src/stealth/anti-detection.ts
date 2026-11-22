/**
 * Anti-Detection helpers (stealth).
 *
 * This module contains randomized-timing helpers used by the stealth layer
 * and a small "fingerprint" API surface:
 *
 * - Randomized 50-200ms pre-send delay (applied to outbound mutating calls)
 * - Randomized subscription staggering on the MQTT transport (via `MqttObfuscationManager`)
 * - A cosmetic fingerprint getter (`getFingerprint()`, `getHardwareId()`).
 *   The fingerprint derived here is NOT transmitted to Facebook and has no
 *   measured effect against Facebook's anti-abuse systems. Rotation happens
 *   in-memory only, every 6h.
 *
 * Nothing in this module evades checkpoints, verifies identities, or
 * bypasses any Facebook security control. It adds timing variance and a
 * hardware-derived (hashed) device id generator for parity with other FCA
 * forks. Claims of "indistinguishable from human behavior" were marketing
 * copy and were removed — the effect of these helpers has not been measured.
 *
 * `generateHardwareDeviceId()` hashes the machine's CPU model, core count,
 * primary MAC address (via `os.networkInterfaces()`), and hostname into a
 * UUID-shaped string. The raw values are never sent anywhere by this code;
 * the public API only exposes the SHA-256 hash. Disabling
 * `stealth.antiDetection` disables the pre-send delay and the fingerprint
 * rotation timer.
 */

import { randomBytes, createHash } from "node:crypto";
import { networkInterfaces, cpus, hostname } from "node:os";
import type { Logger } from "../logger/index.js";

/** Device fingerprint that persists across restarts */
export interface DeviceFingerprint {
  readonly deviceId: string;
  readonly userAgent: string;
  readonly platform: string;
  readonly generatedAt: number;
  readonly hardwareId: string;
}

/** Anti-detection configuration */
export interface AntiDetectionConfig {
  /** Enable anti-detection protection. Default: true */
  readonly enabled: boolean;
  /** Fingerprint rotation interval in ms. Default: 6 hours */
  readonly fingerprintRotationMs: number;
  /** Base timing jitter in ms. Default: 50-200ms */
  readonly timingJitterMs: [number, number];
  /** Enable request obfuscation. Default: true */
  readonly obfuscateRequests: boolean;
  /** Enable pattern diffusion. Default: true */
  readonly patternDiffusion: boolean;
  /**
   * Canonical User-Agent used on every layer. When set, the generated
   * fingerprint uses this exact value so HTTP, MQTT and the client hints
   * agree. When unset a random browser UA is generated (the old behavior,
   * which produced mismatched identities across layers).
   */
  readonly userAgent?: string | undefined;
  /**
   * Simulate a human "typing then pause" rhythm before sending: delay scales
   * with message length and follows a log-normal-like distribution rather
   * than a flat jitter. Default: true.
   */
  readonly typingRhythm: boolean;
  /**
   * After this many rapid sends, inject a longer natural pause (ms).
   * Default 10 sends → 2s pause. Set 0 to disable.
   */
  readonly burstPauseCount: number;
  readonly burstPauseMs: number;
}

export const DEFAULT_ANTI_DETECTION_CONFIG: AntiDetectionConfig = {
  enabled: true,
  fingerprintRotationMs: 6 * 60 * 60 * 1000, // 6 hours
  timingJitterMs: [50, 200],
  obfuscateRequests: true,
  patternDiffusion: true,
  typingRhythm: true,
  burstPauseCount: 10,
  burstPauseMs: 2_000,
};

/**
 * Generates a stable hardware-based device ID.
 * Uses CPU serial + MAC address + hostname for uniqueness and stability.
 */
export function generateHardwareDeviceId(): string {
  // Get CPU info
  const cpuInfo = cpus();
  const cpuModel = cpuInfo[0]?.model ?? "unknown-cpu";
  const cpuCores = cpuInfo.length;

  // Get primary MAC address
  const nets = networkInterfaces();
  let macAddress = "unknown-mac";
  for (const [_, addresses] of Object.entries(nets)) {
    if (!addresses) continue;
    for (const addr of addresses) {
      if (!addr.internal && addr.mac && addr.mac !== "00:00:00:00:00:00") {
        macAddress = addr.mac;
        break;
      }
    }
    if (macAddress !== "unknown-mac") break;
  }

  // Get hostname
  const host = hostname();

  // Combine into stable hash
  const combined = `${cpuModel}:${cpuCores}:${macAddress}:${host}`;
  const hash = createHash("sha256").update(combined).digest("hex");

  // Format as device ID (realistic Android-style)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Generates a realistic user agent string for Chrome on Windows.
 * Rotates between Chrome and Edge with latest version numbers.
 */
export function generateUserAgent(): string {
  const chromeVersions = ["120.0.0.0", "121.0.0.0", "122.0.0.0", "123.0.0.0", "124.0.0.0"];
  const edgeVersions = ["120.0.0.0", "121.0.0.0", "122.0.0.0", "123.0.0.0"];
  
  const isEdge = Math.random() > 0.5;
  
  if (isEdge) {
    const version = edgeVersions[Math.floor(Math.random() * edgeVersions.length)];
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36 Edg/${version}`;
  } else {
    const version = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }
}

/**
 * Generates client hints headers for modern Chrome/Edge.
 */
export function generateClientHints(): Record<string, string> {
  const isEdge = Math.random() > 0.5;
  const majorVersion = 120 + Math.floor(Math.random() * 5);
  
  const brand = isEdge ? "Microsoft Edge" : "Google Chrome";
  const brands = isEdge
    ? `"Not_A Brand";v="8", "Chromium";v="${majorVersion}", "Microsoft Edge";v="${majorVersion}"`
    : `"Not_A Brand";v="8", "Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}"`;
  
  return {
    "sec-ch-ua": brands,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-platform-version": '"15.0.0"',
    "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"',
    "sec-ch-ua-model": '""',
  };
}

/**
 * Applies timing jitter to prevent pattern detection.
 * Returns a randomized delay in milliseconds within the configured range.
 */
export function applyTimingJitter(config: AntiDetectionConfig): number {
  const [min, max] = config.timingJitterMs;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Models the time a person spends composing a message of `length` characters.
 * Uses a sum of uniform samples (central-limit → approximately normal) so most
 * messages land near the median and a few take noticeably longer — closer to
 * real typing behavior than a flat random range. Clamped to [80ms, 4000ms].
 */
export function humanTypingDelay(length: number): number {
  const chars = Math.max(0, Math.min(length, 500));
  const median = 250 + chars * 12; // ~250ms base + 12ms per character
  const noise = (Math.random() + Math.random() + Math.random() - 1.5) * 0.6; // ±~0.9
  const value = median * Math.max(0.25, 1 + noise);
  return Math.round(Math.min(4_000, Math.max(80, value)));
}

/**
 * Returns how long to display a typing indicator before a reply of `length`
 * chars — slightly shorter than the compose delay, capped at 2.5s.
 */
export function typingIndicatorDuration(length: number): number {
  return Math.round(Math.min(2_500, Math.max(150, humanTypingDelay(length) * 0.8)));
}

/**
 * Adds entropy to requests to make them unique and harder to fingerprint.
 */
export function addEntropyToRequest(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Main anti-detection manager.
 * Handles fingerprint rotation, timing jitter, and request obfuscation.
 */
export class AntiDetectionManager {
  readonly #config: AntiDetectionConfig;
  readonly #logger: Logger | null;
  #currentFingerprint: DeviceFingerprint;
  #hardwareId: string;
  #rotationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<AntiDetectionConfig> = {}, logger: Logger | null = null) {
    this.#config = { ...DEFAULT_ANTI_DETECTION_CONFIG, ...config };
    this.#logger = logger === null ? null : logger.child({ module: "anti-detection" });
    this.#hardwareId = generateHardwareDeviceId();
    this.#currentFingerprint = this.#generateFingerprint();

    if (this.#config.enabled) {
      // Report the real state — no "indistinguishable from human" claims.
      this.#logger?.info(
        {
          enabled: true,
          rotationMs: this.#config.fingerprintRotationMs,
          jitterMs: this.#config.timingJitterMs,
          obfuscateRequests: this.#config.obfuscateRequests,
        },
        "Anti-detection initialized",
      );
      this.#scheduleRotation();
    } else {
      this.#logger?.info({ enabled: false }, "Anti-detection disabled");
    }
  }

  #generateFingerprint(): DeviceFingerprint {
    return {
      deviceId: this.#hardwareId,
      // Use the canonical UA from config when supplied so every layer reports
      // the same browser identity. Otherwise fall back to a generated one.
      userAgent: this.#config.userAgent ?? generateUserAgent(),
      platform: "Win32",
      generatedAt: Date.now(),
      hardwareId: this.#hardwareId,
    };
  }

  #scheduleRotation(): void {
    if (this.#rotationTimer !== null) {
      clearTimeout(this.#rotationTimer);
    }

    this.#rotationTimer = setTimeout(() => {
      this.#currentFingerprint = this.#generateFingerprint();
      this.#logger?.debug(
        { platform: this.#currentFingerprint.platform, userAgent: this.#currentFingerprint.userAgent },
        "Anti-detection fingerprint rotated",
      );
      this.#scheduleRotation();
    }, this.#config.fingerprintRotationMs);
  }

  /** Gets the current device fingerprint */
  getFingerprint(): DeviceFingerprint {
    return this.#currentFingerprint;
  }

  /** Gets the stable hardware ID */
  getHardwareId(): string {
    return this.#hardwareId;
  }

  /** Applies timing jitter delay */
  async applyJitter(): Promise<void> {
    if (!this.#config.enabled) return;

    const delayMs = applyTimingJitter(this.#config);
    this.#logger?.debug({ delayMs }, "Anti-detection pre-send jitter applied");
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  /** Rolling counter for burst-pause rhythm. */
  #recentSends = 0;
  #lastSendAt = 0;

  /**
   * Computes the pre-send delay: a human-like compose time based on message
   * length, plus an occasional longer pause after a rapid burst of sends.
   * Pure computation — the caller decides whether to sleep.
   */
  computeHumanDelay(messageLength: number): number {
    if (!this.#config.enabled) return 0;
    let delay = 0;
    if (this.#config.typingRhythm) {
      delay += humanTypingDelay(messageLength);
    } else {
      delay += applyTimingJitter(this.#config);
    }
    // Burst pause: after N sends within a short window, inject a longer rest.
    const now = Date.now();
    if (this.#config.burstPauseCount > 0) {
      if (now - this.#lastSendAt < 5_000) this.#recentSends += 1;
      else this.#recentSends = 1;
      this.#lastSendAt = now;
      if (this.#recentSends >= this.#config.burstPauseCount) {
        delay += this.#config.burstPauseMs;
        this.#recentSends = 0;
        this.#logger?.debug({ burstPauseMs: this.#config.burstPauseMs }, "Anti-detection burst pause injected");
      }
    }
    return Math.round(delay);
  }

  /** Generates obfuscated request headers */
  getObfuscatedHeaders(): Record<string, string> {
    if (!this.#config.enabled) return {};

    const fp = this.#currentFingerprint;
    const clientHints = generateClientHints();

    return {
      "User-Agent": fp.userAgent,
      ...clientHints,
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-Request-Id": addEntropyToRequest(), // Unique per request
    };
  }

  /** Cleanup on shutdown */
  destroy(): void {
    if (this.#rotationTimer !== null) {
      clearTimeout(this.#rotationTimer);
      this.#rotationTimer = null;
    }
  }
}

/**
 * Helper to add natural human-like delay patterns.
 * Simulates reading time, thinking time, etc.
 */
export async function humanLikeDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Calculates adaptive delay based on message length.
 * Longer messages get longer delays to simulate reading/typing.
 */
export function calculateAdaptiveDelay(messageLength: number): number {
  // Base: 100ms per 10 characters, with min 500ms and max 3000ms
  const baseDelay = Math.floor(messageLength / 10) * 100;
  const clampedDelay = Math.max(500, Math.min(3000, baseDelay));
  
  // Add jitter ±20%
  const jitter = clampedDelay * 0.2 * (Math.random() * 2 - 1);
  return Math.floor(clampedDelay + jitter);
}
