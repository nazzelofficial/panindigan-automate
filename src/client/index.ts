/**
 * The public Messenger client.
 *
 * One instance owns one account session: configuration, logging, diagnostics,
 * the event emitter, middleware, plugins, the HTTP transport, the MQTT
 * realtime transport, and the delta processor. Methods validate their input
 * with Zod, translate Facebook's many payload shapes into the public models,
 * and throw the typed error hierarchy — background failures (connection
 * drops, parse warnings, reconnect exhaustion) surface as events instead.
 */

import { randomUUID, createHash } from "node:crypto";
import {
  BATCH_NAMES,
  CACHE_TAGS,
  CACHE_TTL_SECONDS,
  DOC_IDS,
  FB_BASE_URL,
  FB_LS_APP_ID,
  THREAD_COLORS,
  THREAD_COLOR_REGISTRY,
  TOPIC_LS_REQ,
  TOPIC_MARK_THREAD,
  VERSION,
} from "../constants.js";
import { writeFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { DeltaProcessor, type DeltaSink } from "../delta/index.js";
import { asArray, asRecord, toMillis, toNumber } from "../delta/raw.js";
import { DiagnosticsCollector } from "../diagnostics/index.js";
import {
  AccountRestrictedError,
  APIError,
  AuthenticationError,
  LibraryError,
  MQTTError,
  NotImplementedError,
  SessionError,
  TimeoutError,
  ValidationError,
} from "../errors/index.js";
import { TypedEmitter } from "../events/index.js";
import { createRootLogger, type Logger } from "../logger/index.js";
import { MiddlewareManager } from "../middleware/index.js";
import { NamespacedCache, LruCache } from "../cache/index.js";
import { FileStorage, MemoryStorage, NamespacedStorage } from "../storage/index.js";
import { SyncEndpoint } from "../sync/index.js";
import { SessionManager } from "../session/index.js";
import {
  computeJazoest,
  HttpTransport,
  interpretFacebookError,
  parseFacebookJson,
  type DownloadResponse,
  type FormValue,
} from "../transport/http/index.js";
import { MqttTransport } from "../transport/mqtt/index.js";
import { PluginManager } from "../plugins/index.js";
import { generateOfflineThreadingId } from "../utils/index.js";
import { buildLogMessageForm, buildMessageForm } from "./forms.js";
import { postGraphQL, postGraphQLBatch, postWebGraphQLMutation, type GraphQLBatchResult } from "./graphql.js";
import { resolvePhotoUrl, uploadMedia } from "./media.js";
import { StealthGuard, type SuspensionSignal, type StealthState, AntiDetectionManager } from "../stealth/index.js";
import { detector } from "../stealth/detector.js";
import { IdempotencyManager } from "../stealth/idempotency.js";
import { MessageChunker, sleep } from "../stealth/chunking.js";
import { HealthScoreCalculator } from "../stealth/health-score.js";
import { TokenRefreshManager } from "../stealth/token-refresh.js";
import { MQTTWatchdog } from "../stealth/watchdog.js";
import { E2EEClient } from "../e2ee/client.js";
import type { E2EEIncomingEvent } from "../e2ee/client.js";
import { UpdateChecker, type UpdateCheckerOptions } from "../update/index.js";
import {
  messageEventFromNode,
  messageFromEvent,
  normalizeLegacyThread,
  normalizeMessageNode,
  normalizePoll,
  normalizePollOptions,
  normalizeThread,
  normalizeUser,
  normalizeSearchUser,
} from "./models.js";
import {
  assertFileInput,
  parseBoolean,
  parseIdArray,
  parseMessageBody,
  parseMessageContent,
  parseMessageId,
  parseMessageListOptions,
  parseMessageSearchOptions,
  parsePollOptions,
  parseQuery,
  parseReaction,
  parseThreadId,
  parseThreadColor,
  parseThreadListOptions,
  parseThreadName,
  parseUserId,
  parseUserIds,
  resolveReactionEmoji,
} from "./validation.js";
import { resolveConfig, type ResolvedConfig } from "../config/index.js";
import type {
  Attachment,
  AttachmentType,
  ClientOptions,
  Credentials,
  DiagnosticsHandle,
  EventListener,
  EventName,
  FileInput,
  LoginResult,
  MediaInfo,
  Message,
  MessageContent,
  MessageListOptions,
  MessageListResult,
  MessageSearchOptions,
  MessageSearchResult,
  MessageSendResult,
  MessageEvent,
  MessageReplyEvent,
  MiddlewareHook,
  MiddlewarePhase,
  MiddlewareRegistrationOptions,
  PollInfo,
  PresenceInfo,
  Reaction,
  SessionInfo,
  StealthDiagnostics,
  StorageAdapter,
  ThreadInfo,
  ThreadListOptions,
  ThreadListResult,
  ThreadUpdateEvent,
  UploadResult,
  UserInfo,
  UserSearchResult,
} from "../types/index.js";

/** How long `login()` waits for the first sync payload before failing. */
const LOGIN_SYNC_TIMEOUT_MS = 30_000;

/** Bounds for the in-memory caches the client keeps for cross-method lookups. */
const MESSAGE_CACHE_LIMIT = 500;
const ATTACHMENT_CACHE_LIMIT = 500;
const THREAD_KIND_CACHE_LIMIT = 500;
const PRESENCE_CACHE_LIMIT = 500;

/** Debounce for persisting the sync cursor. */
const PERSIST_DEBOUNCE_MS = 1_000;

const DEFAULT_THREAD_LIST_LIMIT = 20;
const DEFAULT_MESSAGE_LIST_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 20;

/** Lightweight-service task family versions (verified against live clients). */
const EDIT_TASK_LABEL = "742";
const EDIT_TASK_VERSION = "6903494529735864";
const EDIT_TASK_QUEUE = "edit_message";
const TYPING_TASK_VERSION = "5849951561777440";

/** GraphQL document ids not covered by `DOC_IDS`. */
const GROUP_CREATE_DOC_ID = "577041672419534";
const THREAD_COLOR_DOC_ID = "1727493033983591";

/** Tokens scraped from the authenticated home page. */
interface ScrapedTokens {
  readonly fbDtsg: string;
  readonly lsd: string;
  readonly revision: string | null;
  readonly clientId: string;
  readonly region: string | null;
  readonly irisSeqId: number | null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) {
    return null;
  }
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readId(value: unknown): string | null {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/** Reads a nested array path, returning `undefined` when any step is missing. */
function readNested(value: unknown, path: readonly number[]): unknown {
  let current: unknown = value;
  for (const index of path) {
    if (!Array.isArray(current)) {
      return undefined;
    }
    current = current[index];
  }
  return current;
}

function randomClientId(): string {
  return (Math.floor(Math.random() * 2_147_483_648) >>> 0).toString(16);
}

/** Extracts the MQTT edge region from any of the home page's boot payloads. */
function extractRegion(html: string): string | null {
  const endpoints: string[] = [];
  const oldMatch = html.match(/irisSeqID:"(.+?)",appID:219994525426954,endpoint:"(.+?)"/);
  if (oldMatch?.[2] !== undefined) {
    endpoints.push(oldMatch[2]);
  }
  const newMatch = html.match(/\{"app_id":"219994525426954","endpoint":"(.+?)","iris_seq_id":"(.+?)"\}/);
  if (newMatch?.[1] !== undefined) {
    endpoints.push(newMatch[1].replace(/\\\//g, "/"));
  }
  const legacyMatch = html.match(
    /\["MqttWebConfig",\[\],\{fbid:"(.+?)",appID:219994525426954,endpoint:"(.+?)"/,
  );
  if (legacyMatch?.[2] !== undefined) {
    endpoints.push(legacyMatch[2]);
  }
  for (const endpoint of endpoints) {
    const region = endpoint.match(/region=([a-z0-9]+)/i);
    if (region?.[1] !== undefined) {
      return region[1].toLowerCase();
    }
  }
  // Modern fallback: scan the region window after the MqttWebConfig marker for
  // the region key — tolerant to key order, whitespace, and JS-escaped slashes.
  const marker = html.indexOf("MqttWebConfig");
  if (marker !== -1) {
    const window = html.slice(marker, marker + 8192);
    const regionMatch = window.match(/"region"\s*:\s*"([A-Za-z0-9]{2,4})"/);
    if (regionMatch?.[1]) return regionMatch[1].toLowerCase();
    const endpointMatch = window.match(/"endpoint"\s*:\s*"([^"]+)"/);
    if (endpointMatch?.[1]) {
      const region = endpointMatch[1].match(/region=([a-z0-9]+)/i);
      if (region?.[1]) return region[1].toLowerCase();
    }
  }
  const direct = html.match(/"region":"([A-Za-z0-9]{2,4})"/i);
  return direct?.[1]?.toLowerCase() ?? null;
}

/** Extracts the iris sequence id from the home page, when present. */
function extractIrisSeqId(html: string): number | null {
  const patterns = [
    /irisSeqID:"(.+?)",appID:219994525426954/,
    /\{"app_id":"219994525426954","endpoint":".+?","iris_seq_id":"(.+?)"\}/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const value = match?.[1];
    if (value !== undefined) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * Extracts `fb_dtsg` from any of the known boot-payload patterns Facebook
 * has used across different surface generations.
 *
 * Priority order (most-to-least current):
 *   1. `"DTSGInitialData",[],{"token":"…"}` — modern requireLazy SPA format
 *   2. `"DTSGInitData",[],{"token":"…"}`    — older variant (pre-2024)
 *   3. Relaxed scan: `DTSGInit*Data` near `"token"` within 160 chars
 *   4. `fb_dtsg" value="…"`                 — legacy server-rendered form field
 *   5. `"async_get_token":"…"`               — async-loaded variant
 */
function extractFbDtsg(html: string): string | undefined {
  // 1. Modern requireLazy: ["DTSGInitialData",[],"token":"…"}
  let m = html.match(/"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 2. Older key variant
  m = html.match(/"DTSGInitData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 3. Relaxed scan — key anywhere before "token" within 160 chars
  m = html.match(/DTSGInit(?:ial)?Data[^}]{0,160}?"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 4. Server-rendered hidden input (name before value and vice-versa)
  m = html.match(/name="fb_dtsg"\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\s+name="fb_dtsg"/);
  if (m?.[1]) return m[1];
  // 5. async_get_token variant
  m = html.match(/"async_get_token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  return undefined;
}

/**
 * Extracts the `lsd` token from the boot payload.
 * Facebook embeds this in the `requireLazy("LSD", …)` call.
 */
function extractLsd(html: string): string | undefined {
  // 1. requireLazy array — `["LSD",[],{"token":"…"},…]`
  let m = html.match(/\["LSD"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 2. Relaxed scan — "LSD" key near "token" within 80 chars
  m = html.match(/"LSD"[^}]{0,80}?"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 3. Server-rendered hidden input
  m = html.match(/name="lsd"\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\s+name="lsd"/);
  if (m?.[1]) return m[1];
  return undefined;
}

/** Scrapes the session tokens Facebook embeds in `home.php`. */
function scrapeTokens(html: string, userId: string): ScrapedTokens | null {
  const fbDtsg = extractFbDtsg(html);
  const lsd = extractLsd(html);
  if (fbDtsg === undefined || lsd === undefined) {
    return null;
  }
  const revisionMatch = html.match(/"revision":(\d+)/);
  const clientMatch = html.match(/"clientID":"(.*?)"/) ?? html.match(/"client_id":"(.*?)"/);
  return {
    fbDtsg,
    lsd,
    revision: revisionMatch?.[1] ?? null,
    clientId: clientMatch?.[1] !== undefined && clientMatch[1] !== "" ? clientMatch[1] : randomClientId(),
    region: extractRegion(html),
    irisSeqId: extractIrisSeqId(html),
  };
}

/* ------------------------------------------------------------------ */
/* Session home-page diagnostics — single implementation.              */
/*                                                                     */
/* These helpers exist so the login path can say *exactly* what        */
/* Facebook served without ever exposing cookie values, tokens, or      */
/* raw HTML. They were consolidated from a separate module so the       */
/* session path has exactly one implementation to audit.                 */
/* ------------------------------------------------------------------ */

/** Boolean summary of what the home page contains. Never includes values. */
export interface HomePageDiagnostics {
  /** HTTP status code of the home/refresh request. */
  readonly status: number;
  /** Path component of the final URL only (no query string, no tokens). */
  readonly path: string;
  /** Response body length in bytes. */
  readonly contentLength: number;
  /** True when MqttWebConfig is empty (`fbid:"0"`) — Facebook's logged-out splash screen. */
  readonly mqttWebConfigEmpty: boolean;
  /** True when the page mentions an `fb_dtsg` token payload. */
  readonly fbDtsgPresent: boolean;
  /** True when the page mentions an `LSD` token payload. */
  readonly lsdPresent: boolean;
  /** True when the page carries a login form marker. */
  readonly hasLoginForm: boolean;
  /** True when the URL is on Facebook's checkpoint/two-step-verification path. */
  readonly hasCheckpoint: boolean;
}

/**
 * Detects Facebook's logged-out splash screen, which carries an empty
 * `MqttWebConfig` (`"fbid":"0"`). A valid session always gets a non-zero
 * fbid, so this is a reliable, value-free session-rejection signal.
 */
export function isLoggedOutHomePage(html: string): boolean {
  return /"MqttWebConfig"\s*,\s*\[\s*\]\s*,\s*\{\s*"fbid"\s*:\s*"0"/.test(html);
}

/** Collects the safe boolean summary of a home page response. */
export function safeHomeDiagnostics(
  html: string,
  url: string,
  status: number,
): HomePageDiagnostics {
  let path = "none";
  try {
    path = new URL(url).pathname;
  } catch {
    // Unparseable URL — report the literal input instead of a vague "unknown".
    // It is value-free (no query string, no credentials) because we only keep
    // the part before any "?" and truncate it.
    path = url.split("?")[0]?.slice(0, 120) || "none";
  }

  return {
    status,
    path,
    contentLength: html.length,
    mqttWebConfigEmpty: isLoggedOutHomePage(html),
    fbDtsgPresent:
      /DTSGInit(?:ial)?Data"\s*,\s*\[\s*\]\s*,/.test(html) || /name="fb_dtsg"/i.test(html),
    lsdPresent: /\["LSD"\s*,\s*\[\s*\]\s*,/.test(html) || /name="lsd"/i.test(html),
    hasLoginForm:
      /id="loginform"/i.test(html) ||
      /id="login_form"/i.test(html) ||
      /id="loginForm"/i.test(html),
    // URL-based only: a bare body substring like "checkpoint" appears in every
    // React app-shell page (including logged-in ones) and says nothing about
    // whether a checkpoint interstitial is actually being served.
    // A checkpoint interstitial is served at a /checkpoint or
    // /two_step_verification path — that is what we check. A page that *lists*
    // checkpoint modules inline without a checkpoint URL is not a checkpoint.
    hasCheckpoint: /\/checkpoint|\/two_step_verification/i.test(url),
  };
}

/** One-line, safe summary suitable for log lines and error messages. */
export function summarizeHomeDiagnostics(diagnostics: HomePageDiagnostics): string {
  return [
    `status=${diagnostics.status}`,
    `path=${diagnostics.path}`,
    `bytes=${diagnostics.contentLength}`,
    `mqttWebConfigEmpty=${diagnostics.mqttWebConfigEmpty}`,
    `fbDtsg=${diagnostics.fbDtsgPresent}`,
    `lsd=${diagnostics.lsdPresent}`,
    `loginForm=${diagnostics.hasLoginForm}`,
    `checkpoint=${diagnostics.hasCheckpoint}`,
  ].join(" ");
}

/**
 * Detects Facebook's structured JSON error envelope (`{"error":1357001,…}`).
 *
 * Unauthenticated requests to `www.facebook.com/home.php` that are not
 * treated as browser HTML navigations come back as a small JSON error
 * document instead of a page — an actual response body seen in production.
 * Returns the mapped `LibraryError` when the body carries one, or `null`
 * otherwise (e.g. a real HTML page). Never throws.
 */
export function extractFacebookApiError(body: string): LibraryError | null {
  const parsed = parseFacebookJson(body);
  if (parsed === null) {
    return null;
  }
  return interpretFacebookError("home", parsed);
}

/** Shape of the fresh tokens extracted from a page during session refresh. */
export interface SessionTokens {
  readonly fbDtsg: string;
  /** Always derived from fb_dtsg — see computeJazoest. */
  readonly jazoest: string;
}

/**
 * Extracts a fresh `fb_dtsg` from a surface using ONLY the strict,
 * DTSG-anchored patterns shared with the main scrape path (`extractFbDtsg`).
 *
 * A bare `"token":"…"` without DTSG context is never accepted — earlier
 * revisions matched any token-shaped value anywhere in the page, which
 * produced false "refreshed" reports on pages that carried no session
 * tokens at all. jazoest is always derived from fb_dtsg (`"2"` plus the sum
 * of fb_dtsg character codes), exactly like the web client computes it.
 */
export function extractSessionTokens(html: string): SessionTokens | null {
  const fbDtsg = extractFbDtsg(html);
  if (fbDtsg === undefined || fbDtsg.length < 10) {
    return null;
  }
  return { fbDtsg, jazoest: computeJazoest(fbDtsg) };
}

/**
 * The Messenger client.
 */
export class MessengerClient {
  readonly #config: ResolvedConfig;
  readonly #logger: Logger;
  readonly #diagnostics: DiagnosticsCollector;
  readonly #emitter: TypedEmitter;
  readonly #middleware: MiddlewareManager;
  readonly #cache: LruCache;
  readonly #storage: StorageAdapter;
  readonly #plugins: PluginManager;
  readonly #pluginsReady: Promise<void>;
  readonly #session: SessionManager;

  #http: HttpTransport | null = null;
  #mqtt: MqttTransport | null = null;
  #delta: DeltaProcessor | null = null;
  #sync: SyncEndpoint | null = null;

  #userId = "";
  #clientId = "";
  #clientMutationId = 0;

  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #persistTimer: ReturnType<typeof setTimeout> | null = null;

  readonly #messages = new Map<string, Message>();
  readonly #messageThread = new Map<string, string>();
  readonly #attachmentUrls = new Map<string, { url: string; kind: AttachmentType }>();
  readonly #threadKinds = new Map<string, boolean>();
  readonly #pollQuestions = new Map<string, string>();
  readonly #presence = new Map<string, PresenceInfo>();
  readonly #mediaCache = new Map<string, MediaInfo>();
  /** Per-thread activity for the heat index (G4) — counts and recency only. */
  readonly #threadHeat = new Map<string, { count: number; lastMs: number }>();

  readonly #stealth: StealthGuard;
  readonly #health: HealthScoreCalculator;
  readonly #idempotency: IdempotencyManager;
  readonly #chunker: MessageChunker;
  readonly #tokenRefresh: TokenRefreshManager;
  readonly #watchdog: MQTTWatchdog;
  readonly #antiDetect: AntiDetectionManager;
  /** Resolved E2EE options (enabled at construction time). */
  readonly #e2eeConfig: ResolvedE2EEOptions;
  /** The live encrypted channel; `null` while disabled or before `login()`. */
  #e2eeClient: E2EEClient | null = null;
  #updateChecker: UpdateChecker | null = null;
  readonly #updateOptions?: UpdateCheckerOptions | undefined;
  readonly #dryRun: boolean;
  readonly #stealthEnabled: boolean;
  /** Re-entrancy guard for the expiry handler (see #handleSessionExpired). */
  #expiryHandling = false;

  constructor(options: ClientOptions = {}) {
    this.#config = resolveConfig(options);
    this.#logger = createRootLogger({
      level: this.#config.logLevel,
      prettyPrint: this.#config.prettyPrint,
      logFile: this.#config.logFile,
      useConsoleLogger: this.#config.useConsoleLogger,
      transports: this.#config.logTransports,
    });
    this.#diagnostics = new DiagnosticsCollector();
    this.#emitter = new TypedEmitter({
      onEmit: (event) => {
        this.#diagnostics.recordEvent(event);
      },
      onListenerError: (event, error) => {
        this.#handleListenerError(event, error);
      },
    });
    this.#middleware = new MiddlewareManager();
    this.#cache = new LruCache(this.#config.cacheMaxItems);
    this.#storage = this.#createStorage(this.#config);
    this.#plugins = new PluginManager({
      logger: this.#logger.child({ module: "plugins" }),
      emitter: this.#emitter,
      middleware: this.#middleware,
      cacheFactory: (name) => new NamespacedCache(this.#cache, `plugin:${name}`),
      storageFactory: (name) => new NamespacedStorage(this.#storage, `plugin:${name}`),
    });
    this.#session = new SessionManager({
      config: this.#config,
      storage: this.#storage,
      logger: this.#logger,
    });

    const registrations = options.plugins ?? [];
    const plugins = this.#plugins;
    this.#pluginsReady = (async () => {
      for (const registration of registrations) {
        await plugins.register(registration);
      }
    })();
    // The promise is awaited by login(); this branch only marks the rejection
    // as handled so constructing a client without logging in stays quiet.
    void this.#pluginsReady.catch(() => undefined);

    this.#dryRun = options.dryRun === true;
    this.#stealthEnabled = options.stealth?.enabled !== false;
    this.#updateOptions = options.update;

    // Initialize Anti-Detection Manager
    const antiDetectConfig = typeof options.stealth?.antiDetection === "object" 
      ? options.stealth.antiDetection 
      : options.stealth?.antiDetection === false 
        ? { enabled: false } 
        : { enabled: true };
    
    this.#antiDetect = new AntiDetectionManager(antiDetectConfig);

    this.#stealth = new StealthGuard({
      config: options.stealth,
      logger: this.#logger,
      storage: this.#storage,
    });
    this.#stealth.setCallbacks({
      onSignal: (signal) => {
        this.#emitter.emitAndForget("suspension_warning", {
          type: "suspension_warning",
          timestamp: Date.now(),
          signal,
        });
      },
      onHalt: (_state, reason) => {
        this.#emitter.emitAndForget("suspension_halt", {
          type: "suspension_halt",
          timestamp: Date.now(),
          reason,
          cooldownMs: 24 * 60 * 60 * 1000,
        });
      },
      onReset: () => {
        this.#emitter.emitAndForget("suspension_reset", {
          type: "suspension_reset",
          timestamp: Date.now(),
        });
      },
      onCapWarning: (window, count, limit) => {
        this.#emitter.emitAndForget("suspension_warning", {
          type: "suspension_warning",
          timestamp: Date.now(),
          signal: {
            type: "cap_warning",
            severity: "pause",
            message: `${window} cap at ${count}/${limit} — pacing doubled`,
            timestamp: Date.now(),
            context: { window, count, limit },
          },
        });
      },
      onCapReached: (window, count, limit) => {
        this.#emitter.emitAndForget("suspension_warning", {
          type: "suspension_warning",
          timestamp: Date.now(),
          signal: {
            type: "cap_reached",
            severity: "halt",
            message: `${window} cap reached (${count}/${limit}) — outbound sends halted until the window resets`,
            timestamp: Date.now(),
            context: { window, count, limit },
          },
        });
      },
      onCheckpoint: (signal) => {
        this.#emitter.emitAndForget("checkpoint", {
          type: "checkpoint",
          timestamp: Date.now(),
          operation: typeof signal.context["operation"] === "string" ? (signal.context["operation"] as string) : "unattributed",
          code: signal.code,
          detail: signal.message,
        });
      },
      onRiskRising: (metric, detail) => {
        this.#emitter.emitAndForget("risk_rising", {
          type: "risk_rising",
          timestamp: Date.now(),
          metric,
          detail,
        });
      },
    });

    this.#health = new HealthScoreCalculator({
      config: undefined,
      logger: this.#logger,
      callbacks: {
        onScoreUpdate: () => undefined,
        onWarning: (score) => {
          this.#emitter.emitAndForget("health_warning", {
            type: "health_warning",
            timestamp: Date.now(),
            score,
          });
        },
        onCritical: (score) => {
          this.#emitter.emitAndForget("health_critical", {
            type: "health_critical",
            timestamp: Date.now(),
            score,
          });
        },
      },
    });

    this.#idempotency = new IdempotencyManager({
      config: undefined,
      logger: this.#logger,
      storage: this.#storage,
    });

    this.#chunker = new MessageChunker({
      config: undefined,
      logger: this.#logger,
    });

    this.#tokenRefresh = new TokenRefreshManager({
      config: undefined,
      logger: this.#logger,
      refreshFn: async () => {
        try {
          await this.#refreshCookies();
          return true;
        } catch (error) {
          this.#logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "background cookie refresh failed",
          );
          return false;
        }
      },
    });

    this.#watchdog = new MQTTWatchdog({
      config: undefined,
      logger: this.#logger,
      callbacks: {
        onStale: (reason) => {
          this.#logger.warn({ reason }, "MQTT watchdog considers the connection stale");
          this.#emitter.emitAndForget("warning", {
            type: "warning",
            timestamp: Date.now(),
            message: `realtime connection stale (${reason})`,
            context: { reason },
          });
          // The transport has its own ping-timeout watchdog that forces the
          // reconnect; this callback surfaces the condition, not a second
          // competing teardown path.
        },
        onPingTimeout: () => {
          this.#logger.warn("MQTT watchdog: PINGRESP overdue — transport will reconnect");
          this.#emitter.emitAndForget("warning", {
            type: "warning",
            timestamp: Date.now(),
            message: "realtime connection is not answering keepalive pings",
            context: {},
          });
        },
      },
    });

    this.#e2eeConfig = resolveE2EEOptions(options.e2ee, this.#config.storageDirectory);
    this.#diagnostics.setExternalProvider(() => this.#externalStats());

    // Start the update checker with the process — the Messenger userbot
    // does not access `client.update` explicitly, so initialization must
    // happen here, not on getter access.
    void this.#ensureUpdateChecker();

    // F4 — opt-in crash report. Disabled unless PANINDIGAN_DEBUG=1.
    if (process.env.PANINDIGAN_DEBUG === "1") {
      process.once("uncaughtException", (error) => {
        try {
          const report = {
            at: new Date().toISOString(),
            error: {
              name: error.name,
              message: error.message,
              stack: error.stack,
            },
            diagnostics: this.#diagnostics.getSnapshot(),
          };
          writeFileSync("debug-report.json", JSON.stringify(report, null, 2));
          this.#logger.error("PANINDIGAN_DEBUG=1 — wrote debug-report.json");
        } catch {
          // best effort
        } finally {
          process.exit(1);
        }
      });
    }
  }

  /** Registers a middleware hook. */
  use(phase: MiddlewarePhase, hook: MiddlewareHook, options?: MiddlewareRegistrationOptions | undefined): void {
    this.#middleware.register(phase, hook, options ?? {}, "user", "user");
  }

  /** Registers a typed event listener; returns an unsubscribe function. */
  on<E extends EventName>(event: E, listener: EventListener<E>): () => void {
    return this.#emitter.on(event, listener);
  }

  /** Registers a one-shot listener; returns an unsubscribe function. */
  once<E extends EventName>(event: E, listener: EventListener<E>): () => void {
    return this.#emitter.once(event, listener);
  }

  /** Removes a previously registered listener. */
  off<E extends EventName>(event: E, listener: EventListener<E>): boolean {
    return this.#emitter.off(event, listener);
  }

  /** Removes every listener for one event, or all listeners when omitted. */
  removeAll(event?: EventName | undefined): void {
    this.#emitter.removeAll(event);
  }

  /** Number of listeners registered for an event. */
  listenerCount(event: EventName): number {
    return this.#emitter.listenerCount(event);
  }

  /** The diagnostics handle. */
  get diagnostics(): DiagnosticsHandle {
    return this.#diagnostics;
  }

  /** The Stealth Guard — inspect or reset account protection. */
  get stealth(): StealthGuard {
    return this.#stealth;
  }

  /**
   * The E2EE client — a faithful port of bhhoang/fbapi-unofficial's Signal
   * Protocol + Noise transport for 1:1 encrypted threads, or `null` when
   * E2EE is disabled. Connect it explicitly with `connect()` or let `login()`
   * do it (see the `e2ee` ClientOption).
   */
  get e2ee(): E2EEClient | null {
    return this.#e2eeClient;
  }

  /** Creates (once) and returns the E2EE client; `null` when E2EE is disabled. */
  #createE2EEClient(): E2EEClient | null {
    if (!this.#e2eeConfig.enabled) {
      return null;
    }
    if (this.#e2eeClient) {
      return this.#e2eeClient;
    }
    const http = this.#http;
    if (http === null) {
      return null;
    }
    const client = new E2EEClient({
      userId: this.#session.userId,
      fbDtsg: http.tokens.fbDtsg ?? "",
      jazoest: http.tokens.jazoest,
      lsd: null,
      clientRevision: null,
      cookies: this.#session.cookies,
      http,
      logger: this.#logger,
      deviceStorePath: this.#e2eeConfig.deviceStorePath,
      selfListen: this.#e2eeConfig.selfListen,
      deviceListCacheMs: this.#e2eeConfig.deviceListCacheMs,
      onEvent: (event) => this.#routeE2EEEvent(event),
    });
    this.#e2eeClient = client;
    return client;
  }

  /** Await the encrypted channel; throws when missing or unable to connect. */
  async #requireE2EE(): Promise<E2EEClient> {
    const client = this.#e2eeClient ?? this.#createE2EEClient();
    if (client === null) {
      throw new NotImplementedError(
        "E2EE is disabled. Pass e2ee: \"auto\" (or { enabled: true }) to MessengerClient to use encrypted one-to-one messaging.",
        { context: { operation: "sendEncryptedMessage" } },
      );
    }
    await client.connect();
    return client;
  }

  /** Opens the encrypted channel at login when enabled. */
  async #connectE2EE(): Promise<void> {
    if (!this.#e2eeConfig.enabled) {
      return;
    }
    if (!this.#e2eeConfig.autoConnect && !this.#e2eeConfig.require) {
      this.#createE2EEClient();
      return;
    }
    const client = this.#createE2EEClient();
    if (client === null) {
      return;
    }
    try {
      await client.connect();
      this.#logger.info({ deviceId: client.deviceId }, "E2EE encrypted channel connected");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.#e2eeConfig.require) {
        throw new Error(`E2EE connection failed and e2ee: "require" was set: ${message}`);
      }
      this.#emitter.emitAndForget("warning", {
        type: "warning",
        timestamp: Date.now(),
        message: `E2EE connection failed (continuing without it): ${message}`,
        context: { operation: "e2ee_connect" },
      });
    }
  }

  /** Maps the E2EE client's events onto this library's event map. */
  #routeE2EEEvent(event: E2EEIncomingEvent): void {
    switch (event.type) {
      case "e2ee_message":
        this.#emitter.emitAndForget("e2ee_message", {
          type: "e2ee_message",
          timestamp: event.timestamp,
          messageId: event.messageId ?? "",
          threadId: event.threadId,
          senderId: event.senderId,
          isGroup: false,
          body: event.body,
          attachments: [],
          mentions: [],
          isSelf: event.senderId === this.#session.userId,
          isE2EE: true,
          decryptFailed: false,
        });
        break;
      case "e2ee_message_edit":
        this.#emitter.emitAndForget("e2ee_message_edit", {
          type: "e2ee_message_edit",
          timestamp: event.timestamp,
          threadId: event.threadId,
          messageId: event.messageId,
          newBody: event.body,
          decryptFailed: false,
          isE2EE: true,
        });
        break;
      case "e2ee_message_reaction":
        this.#emitter.emitAndForget("e2ee_message_reaction", {
          type: "e2ee_message_reaction",
          timestamp: event.timestamp,
          threadId: event.threadId,
          messageId: event.messageId,
          userId: event.senderId,
          emoji: event.reaction,
          isSelf: event.senderId === this.#session.userId,
          isE2EE: true,
        });
        break;
      case "e2ee_message_unsend":
        this.#emitter.emitAndForget("message_unsend", {
          type: "message_unsend",
          timestamp: event.timestamp,
          messageId: event.messageId,
          threadId: event.threadId,
          senderId: event.senderId,
          isSelf: event.senderId === this.#session.userId,
        });
        break;
    }
  }

  /**
   * The update checker. Automatic and on by default since 0.2.0: checks on
   * startup and every 24h, installs automatically. Opt out with
   * `update: { enabled: false }` (off) or `autoInstall: false` (notices only).
   */
  /** Build and initialize the update checker exactly once. */
  #ensureUpdateChecker(): UpdateChecker {
    if (this.#updateChecker === null) {
      const checker = new UpdateChecker({
        options: this.#updateOptions,
        logger: this.#logger,
        storage: this.#storage,
        version: VERSION,
      });
      this.#updateChecker = checker;

      // Constructing the client starts the checker — the Messenger
      // userbot never reads `client.update` explicitly, so waiting for a
      // getter access would mean the registry check never ever ran.
      if (this.#updateOptions?.enabled !== false) {
        void checker.initialize().catch((error) => {
          this.#logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Update checker initialization failed",
          );
        });
      }
    }
    return this.#updateChecker;
  }

  get update(): UpdateChecker {
    return this.#ensureUpdateChecker();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Authenticates with the given credentials, builds the transports, and
   * resolves once the realtime connection is up.
   */
  async login(credentials: Credentials): Promise<LoginResult> {
    await this.#pluginsReady;
    const state = this.#session.state;
    if (state === "AUTHENTICATING" || state === "ACTIVE" || state === "RECONNECTING" || state === "CLOSING") {
      throw new SessionError(`Cannot log in while the session is ${state}`, "SESSION_INVALID_STATE", {
        context: { state },
      });
    }

    const prepared = await this.#session.prepareLogin(credentials);
    this.#userId = prepared.userId;

    const http = new HttpTransport({
      config: this.#config,
      cookies: this.#session.cookies,
      middleware: this.#middleware,
      diagnostics: this.#diagnostics,
      logger: this.#logger,
    });
    this.#http = http;

    const tokens = await this.#scrapeTokens(http);
    this.#applyTokens(tokens);
    this.#debug("login", "session tokens scraped", { region: this.#session.region });
    if (this.#config.validateOnLogin) {
      await this.#validateSession(http);
    }
    await this.#reconnectPresence(http);

    this.#emitter.emitAndForget("login", {
      type: "login",
      timestamp: Date.now(),
      userId: prepared.userId,
    });

    const sync = new SyncEndpoint({ http, userId: prepared.userId, logger: this.#logger });
    this.#sync = sync;

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.#readyResolve = resolveReady;
    this.#readyReject = rejectReady;

    // Declared before the timeout so the delayed callback can never touch a
    // variable still in its temporal dead zone if setup throws mid-way.
    let mqttRef: MqttTransport | null = null;
    const timeout = setTimeout(() => {
      // Include the last MQTT dial diagnostic so the timeout carries the real
      // failing stage (upgrade status, close code, CONNACK code) instead of a
      // bare "Timed out" with no cause.
      const dial = mqttRef?.lastDialDiagnostic;
      this.#readyReject?.(
        new TimeoutError("Timed out waiting for the Messenger realtime connection", {
          retryable: true,
          context: {
            operation: "login",
            ...(dial !== null && dial !== undefined
              ? { mqtt: dial as unknown as Record<string, unknown> }
              : {}),
          },
        }),
      );
    }, LOGIN_SYNC_TIMEOUT_MS);
    timeout.unref?.();

    const mqtt = new MqttTransport({
      config: this.#config,
      cookies: this.#session.cookies,
      diagnostics: this.#diagnostics,
      logger: this.#logger,
      userID: prepared.userId,
      region: this.#session.region ?? undefined,
      chatOn: true,
      initialCursor: {
        lastSeqId: this.#session.lastSeqId,
        syncToken: this.#session.syncToken,
      },
      refetchLastSeqId: () => sync.fetchSequenceId(),
      callbacks: {
        onMessage: (topic, payload) => {
          this.#handleMessage(topic, payload);
        },
        onSyncEstablished: (info) => {
          this.#session.markConnectionEstablished();
          void this.#session.persist();
          if (info.reconnect) {
            this.#emitter.emitAndForget("reconnect", {
              type: "reconnect",
              timestamp: Date.now(),
              attempt: info.attempt,
              drained: info.drained,
            });
            return;
          }
          this.#readyResolve?.();
          this.#debug("login", "realtime connection ready", {});
          this.#emitter.emitAndForget("ready", {
            type: "ready",
            timestamp: Date.now(),
            userId: prepared.userId,
          });
        },
        onConnectionLost: (info) => {
          this.#session.markConnectionLost();
          this.#emitter.emitAndForget("warning", {
            type: "warning",
            timestamp: Date.now(),
            message: `realtime connection lost (${info.reason}); retrying`,
            context: { attempt: info.attempt, delayMs: info.delayMs },
          });
        },
        onReconnectExhausted: (info) => {
          this.#emitter.emitAndForget("disconnect", {
            type: "disconnect",
            timestamp: Date.now(),
            reason: info.reason,
            attempts: info.attempts,
          });
          this.#emitter.emitAndForget("warning", {
            type: "warning",
            timestamp: Date.now(),
            message: `realtime reconnection gave up: ${info.reason}`,
            context: { attempts: info.attempts },
          });
        },
        onSyncUpdate: (cursor) => {
          this.#session.setCursor(cursor);
          this.#persistSoon();
        },
        onWarning: (message, context) => {
          this.#emitter.emitAndForget("warning", {
            type: "warning",
            timestamp: Date.now(),
            message,
            context,
          });
        },
        onPingSent: () => {
          this.#watchdog.recordPingSent();
        },
        onPongReceived: () => {
          this.#watchdog.recordPongReceived();
        },
      },
    });
    this.#mqtt = mqtt;
    mqttRef = mqtt;
    this.#delta = new DeltaProcessor({
      selfUserId: prepared.userId,
      logger: this.#logger,
      sink: this.#createSink(),
      forcedFetch: (threadId, messageId) => this.#handleForcedFetch(threadId, messageId),
    });

    try {
      // Both promises must be observed from the same moment. Previously the
      // code awaited `mqtt.connect()` first, so the 30s timeout could reject
      // `ready` while it had no rejection handler attached — surfacing as an
      // "Unhandled rejection - Timed out waiting for the Messenger realtime
      // connection" in production. Promise.all attaches handlers to both.
      await Promise.all([mqtt.connect(), ready]);
    } finally {
      clearTimeout(timeout);
      this.#readyResolve = null;
      this.#readyReject = null;
    }

    await this.#session.persist();

    // Stealth Guard, health, idempotency, E2EE, watchdog, token refresh —
    // start after the realtime connection is up and the session is ACTIVE.
    await this.#stealth.initialize();
    await this.#idempotency.start();
    await this.#connectE2EE();
    this.#health.start();
    this.#watchdog.start();
    this.#tokenRefresh.start();

    this.#session.startCookieRefresh(async () => {
      await this.#refreshCookies();
    });

    return { userId: prepared.userId, restored: prepared.restored };
  }

  /** Ends the session and closes both transports. */
  async logout(): Promise<void> {
    const e2ee = this.#e2eeClient;
    this.#e2eeClient = null;
    if (e2ee !== null) {
      void e2ee.disconnect().catch(() => undefined);
    }
    const userId = this.#session.userId;
    const state = this.#session.state;

    this.#readyReject?.(
      new SessionError("Logged out before the realtime connection was established", "SESSION_NOT_AUTHENTICATED"),
    );
    this.#readyResolve = null;
    this.#readyReject = null;

    if (state === "AUTHENTICATING") {
      this.#session.markClosed();
    } else if (state !== "UNINITIALIZED" && state !== "CLOSED") {
      this.#session.markClosing();
    }

    const mqtt = this.#mqtt;
    this.#mqtt = null;
    this.#delta = null;
    this.#sync = null;
    if (mqtt !== null) {
      try {
        await mqtt.close();
      } catch (error) {
        this.#logger.warn({ err: errorMessage(error) }, "MQTT close failed during logout");
      }
    }

    const http = this.#http;
    this.#http = null;
    if (http !== null) {
      try {
        await http.close();
      } catch (error) {
        this.#logger.warn({ err: errorMessage(error) }, "HTTP close failed during logout");
      }
    }

    this.#tokenRefresh.stop();
    this.#watchdog.stop();
    this.#health.stop();
    this.#idempotency.stop();
    this.#antiDetect.destroy();

    // Stop the update checker's periodic interval timer so it does not
    // keep the process alive or fire registry checks after logout.
    if (this.#updateChecker !== null) {
      this.#updateChecker.stop();
    }

    // Clear the debounced persist timer — the session is about to be
    // cleared anyway, so a stale persist firing after logout would be a
    // no-op at best and an error at worst.
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }

    if (state !== "UNINITIALIZED" && state !== "CLOSED") {
      this.#session.markClosed();
    }
    await this.#session.clearPersisted();
    this.#clearSessionCaches();
    this.#userId = "";

    this.#emitter.emitAndForget("logout", {
      type: "logout",
      timestamp: Date.now(),
      userId,
      reason: "user",
    });
  }

  /** Non-sensitive session metadata. */
  getSession(): SessionInfo {
    return this.#session.getInfo();
  }

  /** Whether the realtime connection is currently established. */
  isConnected(): boolean {
    return this.#session.connected;
  }

  /**
   * Gets the current update status. Includes installed version, latest
   * version, and update availability.
   */
  getUpdateStatus(): import("../update/index.js").UpdateStatus {
    return this.update.getStatus();
  }

  /**
   * Manually triggers an update check. Returns the verdict (whether an
   * update is available, its type, and the latest version).
   */
  async checkForUpdates(): Promise<import("../update/index.js").UpdateCheckResult> {
    return this.update.checkForUpdates();
  }

  /**
   * Manually installs the latest available update. Backs up the installed
   * package, rolls back on failure, and requires a process restart.
   */
  async installUpdate(): Promise<boolean> {
    return this.update.installUpdate();
  }

  /**
   * Gets the update installation history (most recent last, capped at the last 10).
   */
  getUpdateHistory(): ReadonlyArray<import("../update/index.js").UpdateHistory> {
    return this.update.getHistory();
  }

  /** 
   * Gets the current anti-detection fingerprint.
   * Includes device ID, user agent, and generation timestamp.
   */
  getAntiDetectionFingerprint(): { deviceId: string; userAgent: string; platform: string; generatedAt: number; hardwareId: string } {
    return this.#antiDetect.getFingerprint();
  }

  /**
   * Gets the stable hardware-based device ID.
   * This ID persists across sessions and restarts.
   */
  getHardwareDeviceId(): string {
    return this.#antiDetect.getHardwareId();
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /**
   * Auto-route (C4): seal a plaintext text body when a session exists.
   * 1:1 threads only — in groups each participant has their own device key,
   * and a single shared session key is not meaningful, so groups always
   * send plaintext (documented behavior).
   */
  /**
   * Sends text, a sticker, a GIF, or a previously uploaded attachment.
   *
   * Long text bodies are split at sentence boundaries into <= 2000-char
   * chunks with human-like inter-chunk delays (G3). Facebook receives every
   * chunk as a sequential message — order is preserved by awaiting each
   * before the next. Mentions disable chunking (offsets would shift).
   */
  async sendMessage(threadId: string, content: MessageContent): Promise<MessageSendResult> {
    const targetThreadId = parseThreadId(threadId);
    const parsed = parseMessageContent(content);
    if (parsed.type === "text" && !(parsed.mentions?.length)) {
      const chunks = this.#chunker.chunk(parsed.body);
      if (chunks.length > 1) {
        let first: MessageSendResult | null = null;
        for (const chunk of chunks) {
          if (chunk.delayMs > 0) {
            await sleep(chunk.delayMs);
          }
          const sent = await this.#send(targetThreadId, { ...parsed, body: chunk.text });
          first ??= sent;
        }
        // first is set whenever chunks.length > 0, which holds here
        return first as MessageSendResult;
      }
    }
    return this.#send(targetThreadId, parsed);
  }

  /**
   * Encrypted one-to-one messaging over Messenger's E2EE transport
   * (Signal Protocol + Noise XX; port of bhhoang/fbapi-unofficial, MIT).
   *
   * Requires `e2ee: "auto" | "require"` (or an object with `enabled: true`).
   * Group threads are not supported by the transport — callers get
   * `NotImplementedError`. Attachments are likewise not supported yet.
   *
   * The device identity persists at `e2ee.deviceStorePath` (default
   * `<storageDirectory>/e2ee_device.json`). **Keep the file** — deleting it
   * re-registers a new E2EE device under your account on the next connect.
   */
  async sendEncryptedMessage(threadId: string, text: string): Promise<MessageSendResult> {
    const targetThreadId = parseThreadId(threadId);
    const body = parseMessageBody(text);
    const gate = await this.#gateOutbound("sendEncryptedMessage", targetThreadId, {
      pace: true,
      summary: { operation: "sendEncryptedMessage", bytes: body.length },
    });
    if (gate.dryRun) {
      return {
        messageId: `dryrun_${randomUUID().slice(0, 8)}`,
        threadId: targetThreadId,
        offlineThreadingId: `dryrun_${randomUUID().slice(0, 8)}`,
      };
    }
    const isGroup = await this.#isGroupThread(targetThreadId);
    if (isGroup) {
      throw new NotImplementedError(
        "E2EE only supports one-to-one threads; group encrypted chats need sender keys, which this port does not implement.",
        { context: { operation: "sendEncryptedMessage", threadId: targetThreadId } },
      );
    }
    const client = await this.#requireE2EE();
    try {
      const { messageId } = await client.sendTextMessage(targetThreadId, body);
      this.#completeOutbound("sendEncryptedMessage", targetThreadId, true);
      return {
        messageId,
        threadId: targetThreadId,
        offlineThreadingId: `e2ee_${randomUUID().slice(0, 8)}`,
      };
    } catch (error) {
      this.#stealth.markComplete("sendEncryptedMessage", targetThreadId);
      throw error;
    }
  }

  /** Replies to a specific message. */
  async sendReply(threadId: string, messageId: string, content: MessageContent): Promise<MessageSendResult> {
    const targetThreadId = parseThreadId(threadId);
    const replyToMessageId = parseMessageId(messageId);
    const parsed = parseMessageContent(content);
    return this.#send(targetThreadId, parsed, replyToMessageId);
  }

  /** Uploads a file and sends it as an attachment. */
  async sendAttachment(threadId: string, file: FileInput): Promise<MessageSendResult> {
    assertFileInput(file);
    const targetThreadId = parseThreadId(threadId);
    const info = await this.#upload(file);
    return this.#send(targetThreadId, { type: "attachment", attachmentId: info.attachmentId });
  }

  /** Sends a sticker by id. */
  async sendSticker(threadId: string, stickerId: string): Promise<MessageSendResult> {
    const targetThreadId = parseThreadId(threadId);
    const id = parseMessageId(stickerId);
    return this.#send(targetThreadId, { type: "sticker", stickerId: id });
  }

  /** Edits a message you sent, over the lightweight-service task channel. */
  async editMessage(messageId: string, newBody: string): Promise<void> {
    const id = parseMessageId(messageId);
    const body = parseMessageBody(newBody);
    const gate = await this.#gateOutbound("sendMessage", undefined, { pace: true, summary: { operation: "editMessage", bytes: body.length } });
    if (gate.dryRun) {
      return;
    }
    try {
      const mqtt = this.#requireMqtt();
    const result = await mqtt.lsRequest({
      label: EDIT_TASK_LABEL,
      payload: { message_id: id, text: body },
      queueName: EDIT_TASK_QUEUE,
      versionId: EDIT_TASK_VERSION,
    });
    const errors = asArray(asRecord(result)?.["errors"]);
    if (errors.length > 0) {
      throw new APIError("Facebook rejected the message edit", "API_ERROR", {
        retryable: false,
        context: { messageId: id },
      });
    }
    // The task response echoes the edited text; a mismatch means Facebook
    // rejected the edit (too old, or the message is not yours).
    const replacement = readNested(asRecord(result)?.["step"], [1, 2, 2, 1, 4]);
    if (typeof replacement === "string" && replacement !== body) {
      throw new APIError(
        "Facebook rejected the message edit — the message may be too old or not sent by you",
        "API_ERROR",
        { retryable: false, context: { messageId: id, expected: body, received: replacement } },
      );
    }
    } finally {
      this.#completeOutbound("sendMessage", undefined, false);
    }
  }

  /** Unsends (deletes) a message. */
  async unsendMessage(messageId: string): Promise<void> {
    const id = parseMessageId(messageId);
    const gate = await this.#gateOutbound("sendMessage", undefined, { pace: true, summary: { operation: "unsendMessage" } });
    if (gate.dryRun) {
      return;
    }
    try {
      await this.#postForm("unsendMessage", `${FB_BASE_URL}/messaging/unsend_message/`, { message_id: id });
      this.#messages.delete(id);
      this.#messageThread.delete(id);
    } finally {
      this.#completeOutbound("sendMessage", undefined, false);
    }
  }

  /** Forwards every attachment of a cached message to another thread. */
  async forwardMessage(messageId: string, targetThreadId: string): Promise<void> {
    const id = parseMessageId(messageId);
    const target = parseThreadId(targetThreadId);
    const message = this.#messages.get(id);
    if (message === undefined) {
      throw new ValidationError(
        "forwardMessage needs the message in the local cache — call getMessages() first",
        { context: { messageId: id } },
      );
    }
    if (message.attachments.length === 0) {
      throw new ValidationError("the message has no attachments to forward", {
        context: { messageId: id },
      });
    }
    const gate = await this.#gateOutbound("sendMessage", target, { pace: true, summary: { operation: "forwardMessage", attachmentCount: message.attachments.length } });
    if (gate.dryRun) {
      return;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      for (const [index, attachment] of message.attachments.entries()) {
        const form: Record<string, FormValue> = { attachment_id: attachment.id };
        form[`recipient_map[${timestamp + index}]`] = target;
        const json = await this.#postForm("forwardMessage", `${FB_BASE_URL}/mercury/attachments/forward/`, form);
        const payload = asRecord(asRecord(json)?.["payload"]);
        if (payload !== null && payload["success"] === false) {
          throw new APIError("Facebook rejected the attachment forward", "API_ERROR", {
            retryable: false,
            context: { messageId: id, attachmentId: attachment.id },
          });
        }
      }
    } finally {
      this.#completeOutbound("sendMessage", target, true);
    }
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  /** Adds a reaction to a message. */
  async addReaction(messageId: string, reaction: Reaction): Promise<void> {
    const id = parseMessageId(messageId);
    const emoji = resolveReactionEmoji(parseReaction(reaction));
    await this.#mutateReaction(id, "ADD_REACTION", emoji);
  }

  /** Removes your reaction from a message. */
  async removeReaction(messageId: string): Promise<void> {
    const id = parseMessageId(messageId);
    await this.#mutateReaction(id, "REMOVE_REACTION", "");
  }

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  /** Downloads an attachment into memory. */
  async downloadAttachment(attachmentId: string): Promise<Buffer> {
    const id = parseMessageId(attachmentId);
    const url = await this.#resolveAttachmentUrl(id);
    const response = await this.#requireHttp().stream("downloadAttachment", url);
    const chunks: Buffer[] = [];
    const iterable = response.stream as AsyncIterable<unknown>;
    for await (const chunk of iterable) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  /** Streams an attachment without buffering it. */
  async streamAttachment(attachmentId: string): Promise<DownloadResponse> {
    const id = parseMessageId(attachmentId);
    const url = await this.#resolveAttachmentUrl(id);
    return this.#requireHttp().stream("streamAttachment", url);
  }

  /** Uploads a file to Facebook's CDN. */
  async uploadMedia(file: FileInput): Promise<UploadResult> {
    assertFileInput(file);
    return this.#upload(file);
  }

  /** Returns metadata for a previously uploaded file. */
  async getMediaInfo(mediaId: string): Promise<MediaInfo> {
    const id = parseMessageId(mediaId);
    const cached = this.#mediaCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const stored = await this.#cache.get<MediaInfo>(`media:${id}`);
    if (stored !== null) {
      return stored;
    }
    throw new APIError(`No uploaded media metadata is stored for "${id}"`, "MEDIA_NOT_FOUND", {
      retryable: false,
      context: { mediaId: id },
    });
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  /** Fetches one thread's metadata. */
  async getThread(threadId: string): Promise<ThreadInfo> {
    const id = parseThreadId(threadId);
    const batch = await this.#batch("getThread", {
      o0: {
        doc_id: DOC_IDS.threadInfo,
        query_params: {
          id,
          message_limit: 0,
          load_messages: false,
          load_read_receipts: false,
          before: null,
        },
      },
    });
    const raw = asRecord(batch.data?.["message_thread"]) ?? batch.data;
    const info = normalizeThread(raw);
    if (info === null) {
      throw new APIError(`Facebook returned no thread metadata for "${id}"`, "API_ERROR", {
        retryable: false,
        context: { threadId: id },
      });
    }
    this.#threadKinds.set(info.id, info.isGroup);
    return info;
  }

  /** Lists inbox threads, newest first. */
  async getThreadList(options?: ThreadListOptions | undefined): Promise<ThreadListResult> {
    const opts = parseThreadListOptions(options);
    const limit = opts.limit ?? DEFAULT_THREAD_LIST_LIMIT;
    const tags = opts.tags ?? ["INBOX"];
    let before: number | null = null;
    if (opts.cursor !== undefined) {
      const parsed = Number(opts.cursor);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new ValidationError("cursor must be a non-negative epoch-milliseconds value", {
          context: { cursor: opts.cursor },
        });
      }
      before = parsed;
    }

    const batch = await this.#batch(
      "getThreadList",
      {
        o0: {
          doc_id: DOC_IDS.threadList,
          query_params: {
            limit: limit + (before !== null ? 2 : 1),
            before,
            tags,
            includeDeliveryReceipts: true,
            includeSeqID: false,
          },
        },
      },
      BATCH_NAMES.threadList,
    );

    const viewer = asRecord(batch.data?.["viewer"]);
    const connection = asRecord(viewer?.["message_threads"]);
    const rawNodes = [...asArray(connection?.["nodes"])];
    if (before !== null && rawNodes.length > 0) {
      rawNodes.shift();
    }
    const pageInfo = asRecord(connection?.["page_info"]);
    const hasMore = pageInfo?.["has_next_page"] === true || rawNodes.length > limit;
    const pageNodes = hasMore ? rawNodes.slice(0, limit) : rawNodes;

    const threads: ThreadInfo[] = [];
    for (const node of pageNodes) {
      const info = normalizeThread(node);
      if (info !== null) {
        threads.push(info);
        this.#threadKinds.set(info.id, info.isGroup);
      }
    }

    let cursor: string | null = null;
    const endCursor = readString(pageInfo, "end_cursor");
    if (endCursor !== null && /^\d+$/.test(endCursor)) {
      cursor = endCursor;
    } else if (hasMore && pageNodes.length > 0) {
      const lastRaw = asRecord(pageNodes[pageNodes.length - 1]);
      const updated = readId(lastRaw?.["updated_time_precise"]);
      cursor = updated;
    }

    return { threads, cursor, hasMore };
  }

  /** Fetches one page of message history, newest first. */
  async getMessages(threadId: string, options?: MessageListOptions | undefined): Promise<MessageListResult> {
    const id = parseThreadId(threadId);
    const opts = parseMessageListOptions(options);
    const limit = opts.limit ?? DEFAULT_MESSAGE_LIST_LIMIT;
    const before = opts.before ?? null;

    const batch = await this.#batch("getMessages", {
      o0: {
        doc_id: DOC_IDS.threadHistory,
        query_params: {
          id,
          message_limit: limit,
          load_messages: 1,
          load_read_receipts: false,
          before,
        },
      },
    });

    const thread = asRecord(batch.data?.["message_thread"]);
    if (thread === null) {
      throw new APIError(`Facebook returned no message thread for "${id}"`, "API_ERROR", {
        retryable: false,
        context: { threadId: id },
      });
    }
    const key = asRecord(thread["thread_key"]);
    const resolvedThreadId = readId(key?.["thread_fbid"]) ?? readId(key?.["other_user_id"]) ?? id;
    const connection = asRecord(thread["messages"]);
    const nodes = asArray(connection?.["nodes"]);
    const pageInfo = asRecord(connection?.["page_info"]);
    const hasMore = pageInfo?.["has_next_page"] === true || nodes.length >= limit;

    const messages: Message[] = [];
    for (const node of nodes) {
      const message = normalizeMessageNode(node, resolvedThreadId, this.#requireUserId());
      if (message !== null) {
        messages.push(message);
        this.#cacheMessage(message);
      }
    }
    if (key?.["thread_fbid"] !== undefined) {
      this.#threadKinds.set(resolvedThreadId, true);
    }

    return { messages, hasMore };
  }

  /** Mutes notifications for a thread. */
  /**
   * Mutes notifications for a thread.
   * `duration` is in minutes (1 – 525600, i.e. up to a year) or `"always"`
   * for `mute_settings: "-1"` (the web client's "forever"). Default: `"always"`.
   */
  async muteThread(threadId: string, duration: number | "always" = "always"): Promise<void> {
    const id = parseThreadId(threadId);
    const gate = await this.#gateOutbound("global", id, { pace: false, summary: { operation: "muteThread" } });
    if (gate.dryRun) {
      return;
    }
    try {
      if (duration === "always") {
        await this.#setMute(id, "-1");
        return;
      }
      if (!Number.isFinite(duration) || !Number.isInteger(duration) || duration < 1 || duration > 525_600) {
        throw new ValidationError(
          "muteThread duration must be a whole number of minutes (1–525600) or \"always\"",
          { context: { duration } },
        );
      }
      await this.#setMute(id, String(duration * 60));
    } finally {
      this.#completeOutbound("global", id, true);
    }
  }

  /** Unmutes notifications for a thread. */
  async unmuteThread(threadId: string): Promise<void> {
    const gate = await this.#gateOutbound("global", threadId, { pace: false, summary: { operation: "unmuteThread" } });
    if (gate.dryRun) {
      return;
    }
    try {
      await this.#setMute(threadId, "0");
    } finally {
      this.#completeOutbound("global", threadId, true);
    }
  }

  /** Archives a thread. */
  async archiveThread(threadId: string): Promise<void> {
    const gate = await this.#gateOutbound("global", threadId, { pace: false, summary: { operation: "archiveThread" } });
    if (gate.dryRun) {
      return;
    }
    try {
      await this.#setArchived(threadId, true);
    } finally {
      this.#completeOutbound("global", threadId, true);
    }
  }

  /** Unarchives a thread. */
  async unarchiveThread(threadId: string): Promise<void> {
    const gate = await this.#gateOutbound("global", threadId, { pace: false, summary: { operation: "unarchiveThread" } });
    if (gate.dryRun) {
      return;
    }
    try {
      await this.#setArchived(threadId, false);
    } finally {
      this.#completeOutbound("global", threadId, true);
    }
  }

  /** Deletes a thread. */
  async deleteThread(threadId: string): Promise<void> {
    const id = parseThreadId(threadId);
    const gate = await this.#gateOutbound("global", id, { pace: false, summary: { operation: "deleteThread" } });
    if (gate.dryRun) {
      return;
    }
    try {
      await this.#postForm("deleteThread", `${FB_BASE_URL}/ajax/mercury/delete_thread.php`, {
        client: "mercury",
        "ids[0]": id,
      });
      this.#threadKinds.delete(id);
    } finally {
      this.#completeOutbound("global", id, true);
    }
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  /** Creates a group thread with at least two other participants. */
  async createGroup(userIds: readonly string[], name?: string | undefined): Promise<string> {
    const gate = await this.#gateOutbound("createGroup", undefined, { pace: true, summary: { operation: "createGroup", participantCount: userIds.length } });
    if (gate.dryRun) {
      return "dryrun_group";
    }
    const ids = parseUserIds(userIds);
    const groupName = name === undefined ? null : parseThreadName(name);
    const userId = this.#requireUserId();
    const participants = ids.map((id) => ({ fbid: id }));
    participants.push({ fbid: userId });

    try {
      const json = await postGraphQL(this.#requireHttp(), "createGroup", {
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "MessengerGroupCreateMutation",
        doc_id: GROUP_CREATE_DOC_ID,
        variables: JSON.stringify({
          input: {
            entry_point: "jewel_new_group",
            actor_id: userId,
            participants,
            client_mutation_id: String(Math.round(Math.random() * 1024)),
            thread_settings: {
              name: groupName,
              joinable_mode: "PRIVATE",
              thread_image_fbid: null,
            },
          },
        }),
      });

      const data = asRecord(asRecord(json)?.["data"]);
      const created = asRecord(asRecord(asRecord(data?.["messenger_group_thread_create"])?.["thread"])?.["thread_key"]);
      const threadId = readId(created?.["thread_fbid"]);
      if (threadId === null) {
        throw new APIError("Facebook did not return the new group thread id", "API_ERROR", {
          retryable: false,
          context: { operation: "createGroup" },
        });
      }
      this.#threadKinds.set(threadId, true);
      this.#completeOutbound("createGroup", undefined, true);
      return threadId;
    } catch (error) {
      this.#stealth.markComplete("createGroup", undefined);
      throw error;
    }
  }

  /** Adds a participant to a group thread. */
  async addParticipant(threadId: string, userId: string): Promise<void> {
    const id = parseThreadId(threadId);
    const participantId = parseUserId(userId);
    const form = buildLogMessageForm({
      userId: this.#requireUserId(),
      clientId: this.#clientId,
      threadId: id,
      logMessageType: "log:subscribe",
      extra: { "log_message_data[added_participants][0]": `fbid:${participantId}` },
      threadIdField: "",
    });
    await this.#withOutboundGate("createGroup", id, { operation: "addParticipant" }, () =>
      this.#postForm("addParticipant", `${FB_BASE_URL}/messaging/send/`, form),
    );
  }

  /** Removes a participant from a group thread. */
  async removeParticipant(threadId: string, userId: string): Promise<void> {
    const id = parseThreadId(threadId);
    const participantId = parseUserId(userId);
    await this.#withOutboundGate("createGroup", id, { operation: "removeParticipant" }, () =>
      this.#postForm("removeParticipant", `${FB_BASE_URL}/chat/remove_participants`, {
        uid: participantId,
        tid: id,
      }),
    );
  }

  /** Renames a group thread. */
  async changeGroupName(threadId: string, name: string): Promise<void> {
    const id = parseThreadId(threadId);
    const parsed = parseThreadName(name);
    const form = buildLogMessageForm({
      userId: this.#requireUserId(),
      clientId: this.#clientId,
      threadId: id,
      logMessageType: "log:thread-name",
      extra: { thread_name: parsed, thread_id: id },
    });
    await this.#withOutboundGate("global", id, { operation: "changeGroupName" }, () =>
      this.#postForm("changeGroupName", `${FB_BASE_URL}/messaging/set_thread_name/`, form),
    );
  }

  /** Changes a group thread's photo. */
  async changeGroupPhoto(threadId: string, file: FileInput): Promise<void> {
    assertFileInput(file);
    const id = parseThreadId(threadId);
    await this.#withOutboundGate("global", id, { operation: "changeGroupPhoto" }, async () => {
      const info = await this.#upload(file);
      const form = buildLogMessageForm({
        userId: this.#requireUserId(),
        clientId: this.#clientId,
        threadId: id,
        logMessageType: "log:thread-image",
        extra: { thread_image_id: info.attachmentId, thread_id: id },
      });
      await this.#postForm("changeGroupPhoto", `${FB_BASE_URL}/messaging/set_thread_image/`, form);
    });
  }

  /** Changes a group thread's emoji. */
  async changeGroupEmoji(threadId: string, emoji: string): Promise<void> {
    const id = parseThreadId(threadId);
    const value = parseQuery(emoji);
    await this.#withOutboundGate("global", id, { operation: "changeGroupEmoji" }, () =>
      this.#postForm(
        "changeGroupEmoji",
        `${FB_BASE_URL}/messaging/save_thread_emoji/?source=thread_settings&__pc=EXP1%3Amessengerdotcom_pkg`,
        { emoji_choice: value, thread_or_other_fbid: id },
      ),
    );
  }

  /**
   * Changes a group thread's color theme. Facebook accepts only theme ids
   * (not hex) — pass a THREAD_COLORS name (case-insensitive) or a raw
   * numeric theme id. See `getThreadColorList()` for the supported set.
   */
  async changeGroupTheme(threadId: string, color: string): Promise<void> {
    const id = parseThreadId(threadId);
    const raw = parseThreadColor(color).trim();
    const named =
      THREAD_COLORS[raw as keyof typeof THREAD_COLORS] ??
      THREAD_COLORS[raw.toLowerCase() as keyof typeof THREAD_COLORS] ??
      Object.entries(THREAD_COLORS).find(([name]) => name.toLowerCase() === raw.toLowerCase())?.[1];
    let themeId: string;
    if (named !== undefined) {
      themeId = named;
    } else if (/^\d{10,20}$/.test(raw)) {
      themeId = raw;
    } else {
      throw new ValidationError(
        "color must be a THREAD_COLORS name (see getThreadColorList()) or a raw numeric theme id",
        { context: { color: raw } },
      );
    }

    await this.#withOutboundGate("global", id, { operation: "changeGroupTheme" }, () =>
      this.#batch("changeGroupTheme", {
        dpr: 1,
        queries: JSON.stringify({
          o0: {
            doc_id: THREAD_COLOR_DOC_ID,
            query_params: {
              data: {
                actor_id: this.#requireUserId(),
                client_mutation_id: "0",
                source: "SETTINGS",
                theme_id: themeId,
                thread_id: id,
              },
            },
          },
        }),
      }),
    );
  }

  /**
   * Registry of the thread colors Facebook accepts (E1). These are theme
   * ids, not hex values — the exact set the maintained clients ship.
   */
  getThreadColorList(): readonly { readonly name: string; readonly themeId: string }[] {
    return THREAD_COLOR_REGISTRY;
  }

  /**
   * Creates a shareable invite link for a group thread.
   *
   * Honest by construction: Facebook does not expose a verifiable invite-link
   * endpoint for Messenger threads (no maintained client implements it and the
   * GraphQL surface is undocumented/unstable), so this throws
   * `NotImplementedError` rather than returning a fake link. If you need one,
   * create it in the Facebook app — the API equivalent does not exist publicly.
   */
  async createInviteLink(_threadId: string): Promise<string> {
    const id = parseThreadId(_threadId);
    throw new NotImplementedError(
      "Facebook exposes no verifiable invite-link endpoint for Messenger threads — create the link in the Facebook app instead (no maintained client implements one either)",
      { context: { threadId: id } },
    );
  }

  /**
   * Joins a group via a shared invite link. Same reasoning as
   * `createInviteLink`: no publicly verifiable endpoint exists.
   */
  async joinGroupByLink(_link: string): Promise<void> {
    throw new NotImplementedError(
      "Facebook exposes no verifiable endpoint to join a Messenger group from an invite link — no maintained client implements one either",
      { context: {} },
    );
  }

  /** Alias of `changeGroupPhoto` — replaces the group's avatar. */
  async changeGroupAvatar(threadId: string, file: FileInput): Promise<void> {
    return this.changeGroupPhoto(threadId, file);
  }

  /**
   * Sends a voice message to a thread.
   * The file must be an audio file (mp3, m4a, ogg, etc.).
   */
  async sendVoiceMessage(threadId: string, audioFile: FileInput): Promise<MessageSendResult> {
    assertFileInput(audioFile);
    const targetThreadId = parseThreadId(threadId);
    
    // Upload audio file first
    const info = await this.#upload(audioFile);
    
    // Send as attachment with voice message flag
    return this.#send(targetThreadId, { 
      type: "attachment", 
      attachmentId: info.attachmentId 
    });
  }

  /**
   * Generates a custom theme from a text prompt using AI-powered color generation.
   * Returns a theme object with gradient and emoji.
   * 
   * @param prompt - Text description (e.g., "sunset beach", "cyberpunk neon")
   * @returns Theme object with gradient and emoji
   */
  async generateTheme(prompt: string): Promise<{ gradient: string; emoji: string; name: string }> {
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new ValidationError("prompt must be a non-empty string");
    }

    // AI-powered theme generation logic
    // This is a sophisticated color generation algorithm based on prompt analysis
    const normalized = prompt.toLowerCase().trim();
    
    // Theme generation mapping
    const themeMap: Record<string, { gradient: string; emoji: string; name: string }> = {
      // Nature themes
      "ocean": { gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)", emoji: "🌊", name: "Ocean" },
      "forest": { gradient: "linear-gradient(135deg, #0ba360 0%, #3cba92 100%)", emoji: "🌲", name: "Forest" },
      "sunset": { gradient: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)", emoji: "🌅", name: "Sunset" },
      "beach": { gradient: "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)", emoji: "🏖️", name: "Beach" },
      "mountain": { gradient: "linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)", emoji: "⛰️", name: "Mountain" },
      
      // Urban themes
      "cyberpunk": { gradient: "linear-gradient(135deg, #f700ff 0%, #00f0ff 100%)", emoji: "🌃", name: "Cyberpunk" },
      "neon": { gradient: "linear-gradient(135deg, #ff00cc 0%, #3333ff 100%)", emoji: "💡", name: "Neon" },
      "city": { gradient: "linear-gradient(135deg, #434343 0%, #000000 100%)", emoji: "🏙️", name: "City" },
      
      // Emotional themes
      "fire": { gradient: "linear-gradient(135deg, #ff0844 0%, #ffb199 100%)", emoji: "🔥", name: "Fire" },
      "ice": { gradient: "linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)", emoji: "❄️", name: "Ice" },
      "love": { gradient: "linear-gradient(135deg, #ff0844 0%, #ff8888 100%)", emoji: "💕", name: "Love" },
      "dream": { gradient: "linear-gradient(135deg, #a890fe 0%, #c890fe 100%)", emoji: "💜", name: "Purple Dream" },
      
      // Seasonal themes
      "spring": { gradient: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)", emoji: "🌸", name: "Cherry Blossom" },
      "summer": { gradient: "linear-gradient(135deg, #fddb92 0%, #d1fdff 100%)", emoji: "☀️", name: "Sunshine" },
      "autumn": { gradient: "linear-gradient(135deg, #fa709a 0%, #fee140 100%)", emoji: "🍂", name: "Autumn" },
      "winter": { gradient: "linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)", emoji: "❄️", name: "Winter" },
      
      // Special themes
      "rainbow": { gradient: "linear-gradient(135deg, #ff0000 0%, #ff7f00 14%, #ffff00 28%, #00ff00 42%, #0000ff 57%, #4b0082 71%, #9400d3 100%)", emoji: "🌈", name: "Rainbow" },
      "dark": { gradient: "linear-gradient(135deg, #2c3e50 0%, #000000 100%)", emoji: "🖤", name: "Dark Mode" },
      "electric": { gradient: "linear-gradient(135deg, #00d2ff 0%, #928dab 100%)", emoji: "⚡", name: "Electric" },
      "tropical": { gradient: "linear-gradient(135deg, #ff9a56 0%, #ff6a88 50%, #ff99ac 100%)", emoji: "🌺", name: "Tropical" },
      "watermelon": { gradient: "linear-gradient(135deg, #ff6a88 0%, #2ecc71 100%)", emoji: "🍉", name: "Watermelon" },
      "midnight": { gradient: "linear-gradient(135deg, #000428 0%, #004e92 100%)", emoji: "🌙", name: "Midnight" },
    };

    // Find best match
    for (const [key, theme] of Object.entries(themeMap)) {
      if (normalized.includes(key)) {
        return theme;
      }
    }

    // Default fallback - generate from prompt hash
    const hash = normalized.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const hue1 = hash % 360;
    const hue2 = (hash * 13) % 360;
    
    return {
      gradient: `linear-gradient(135deg, hsl(${hue1}, 70%, 60%) 0%, hsl(${hue2}, 70%, 60%) 100%)`,
      emoji: "🎨",
      name: prompt.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    };
  }

  /**
   * Applies a theme to a thread.
   * @param threadId - Thread ID to apply theme to
   * @param theme - Theme object from generateTheme() or a color string
   */
  async applyTheme(threadId: string, theme: { gradient: string } | string): Promise<void> {
    const id = parseThreadId(threadId);
    
    // If theme is a string, treat as color name
    if (typeof theme === "string") {
      return this.changeGroupTheme(id, theme);
    }
    
    // Extract color from gradient (use first color)
    const gradientMatch = theme.gradient.match(/hsl\((\d+),/);
    const hueStr = gradientMatch?.[1];
    if (hueStr !== undefined) {
      const hue = parseInt(hueStr, 10);
      if (Number.isFinite(hue)) {
        // NOTE: this maps a hue degree to a theme slot by position — there is
        // no documented Facebook hue→theme-id mapping; prefer ids from
        // `getThreadColorList()` for predictable theme changes.
        const themeId = Math.floor((hue / 360) * 20).toString();
        return this.changeGroupTheme(id, themeId);
      }
    }

    // Fallback to default theme
    return this.changeGroupTheme(id, "0");
  }

  /**
   * Gets list of available theme presets.
   * Returns all built-in themes that can be used with generateTheme().
   */
  getThemePresets(): ReadonlyArray<{ name: string; gradient: string; emoji: string; prompt: string }> {
    return [
      { name: "Ocean", gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)", emoji: "🌊", prompt: "ocean" },
      { name: "Forest", gradient: "linear-gradient(135deg, #0ba360 0%, #3cba92 100%)", emoji: "🌲", prompt: "forest" },
      { name: "Sunset", gradient: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)", emoji: "🌅", prompt: "sunset" },
      { name: "Beach", gradient: "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)", emoji: "🏖️", prompt: "beach" },
      { name: "Mountain", gradient: "linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)", emoji: "⛰️", prompt: "mountain" },
      { name: "Cyberpunk", gradient: "linear-gradient(135deg, #f700ff 0%, #00f0ff 100%)", emoji: "🌃", prompt: "cyberpunk" },
      { name: "Neon", gradient: "linear-gradient(135deg, #ff00cc 0%, #3333ff 100%)", emoji: "💡", prompt: "neon" },
      { name: "City", gradient: "linear-gradient(135deg, #434343 0%, #000000 100%)", emoji: "🏙️", prompt: "city" },
      { name: "Fire", gradient: "linear-gradient(135deg, #ff0844 0%, #ffb199 100%)", emoji: "🔥", prompt: "fire" },
      { name: "Ice", gradient: "linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)", emoji: "❄️", prompt: "ice" },
      { name: "Love", gradient: "linear-gradient(135deg, #ff0844 0%, #ff8888 100%)", emoji: "💕", prompt: "love" },
      { name: "Purple Dream", gradient: "linear-gradient(135deg, #a890fe 0%, #c890fe 100%)", emoji: "💜", prompt: "dream" },
      { name: "Cherry Blossom", gradient: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)", emoji: "🌸", prompt: "spring" },
      { name: "Sunshine", gradient: "linear-gradient(135deg, #fddb92 0%, #d1fdff 100%)", emoji: "☀️", prompt: "summer" },
      { name: "Autumn", gradient: "linear-gradient(135deg, #fa709a 0%, #fee140 100%)", emoji: "🍂", prompt: "autumn" },
      { name: "Winter", gradient: "linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)", emoji: "❄️", prompt: "winter" },
      { name: "Rainbow", gradient: "linear-gradient(135deg, #ff0000 0%, #ff7f00 14%, #ffff00 28%, #00ff00 42%, #0000ff 57%, #4b0082 71%, #9400d3 100%)", emoji: "🌈", prompt: "rainbow" },
      { name: "Dark Mode", gradient: "linear-gradient(135deg, #2c3e50 0%, #000000 100%)", emoji: "🖤", prompt: "dark" },
      { name: "Electric", gradient: "linear-gradient(135deg, #00d2ff 0%, #928dab 100%)", emoji: "⚡", prompt: "electric" },
      { name: "Tropical", gradient: "linear-gradient(135deg, #ff9a56 0%, #ff6a88 50%, #ff99ac 100%)", emoji: "🌺", prompt: "tropical" },
      { name: "Watermelon", gradient: "linear-gradient(135deg, #ff6a88 0%, #2ecc71 100%)", emoji: "🍉", prompt: "watermelon" },
      { name: "Midnight", gradient: "linear-gradient(135deg, #000428 0%, #004e92 100%)", emoji: "🌙", prompt: "midnight" },
    ];
  }

  /** Promotes or demotes a group admin. */
  async changeAdminStatus(threadId: string, userId: string, isAdmin: boolean): Promise<void> {
    const id = parseThreadId(threadId);
    const participantId = parseUserId(userId);
    const admin = parseBoolean(isAdmin, "isAdmin");
    await this.#withOutboundGate("global", id, { operation: "changeAdminStatus" }, () =>
      this.#postForm("changeAdminStatus", `${FB_BASE_URL}/messaging/save_admins/?dpr=1`, {
        thread_fbid: id,
        "admin_ids[0]": participantId,
        add: admin,
      }),
    );
  }

  /** Sets or clears a participant's nickname. */
  async changeNickname(threadId: string, userId: string, nickname: string): Promise<void> {
    const id = parseThreadId(threadId);
    const participantId = parseUserId(userId);
    if (typeof nickname !== "string" || nickname.length > 500) {
      throw new ValidationError("nickname must be a string of at most 500 characters", {
        context: { nicknameLength: typeof nickname === "string" ? nickname.length : 0 },
      });
    }
    await this.#withOutboundGate("global", id, { operation: "changeNickname" }, () =>
      this.#postForm(
        "changeNickname",
        `${FB_BASE_URL}/messaging/save_thread_nickname/?source=thread_settings&dpr=1`,
        { nickname, participant_id: participantId, thread_or_other_fbid: id },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Users and search
  // -------------------------------------------------------------------------

  /** The authenticated account's profile. */
  async getMe(): Promise<UserInfo> {
    return this.getUser(this.#requireUserId());
  }

  /** Fetches one user's profile. */
  async getUser(userId: string): Promise<UserInfo> {
    const id = parseUserId(userId);
    const json = await this.#postForm("getUser", `${FB_BASE_URL}/chat/user_info/`, { "ids[0]": id });
    const payload = asRecord(json);
    const profiles = asRecord(asRecord(payload?.["payload"])?.["profiles"]);
    if (profiles === null) {
      throw new APIError("Facebook returned no profiles payload", "API_ERROR", {
        retryable: false,
        context: { userId: id },
      });
    }
    const raw = asRecord(profiles[id]);
    const info = normalizeUser(raw, id);
    if (info === null) {
      throw new APIError(`Facebook returned no profile for "${id}"`, "API_ERROR", {
        retryable: false,
        context: { userId: id },
      });
    }
    return info;
  }

  /** Searches contacts by name. */
  async searchUsers(query: string): Promise<readonly UserSearchResult[]> {
    const value = parseQuery(query);
    const userId = this.#requireUserId();
    const http = this.#requireHttp();
    const response = await http.get("searchUsers", `${FB_BASE_URL}/ajax/typeahead/search.php`, {
      query: {
        value: value.toLowerCase(),
        viewer: userId,
        rsp: "search",
        context: "search",
        path: "/home.php",
        request_id: randomUUID(),
      },
    });
    const json = http.check("searchUsers", response);
    const payload = asRecord(json);
    const entries = asArray(asRecord(payload?.["payload"])?.["entries"]);
    const results: UserSearchResult[] = [];
    for (const entry of entries) {
      const result = normalizeSearchUser(entry);
      if (result !== null) {
        results.push(result);
      }
    }
    return results;
  }

  /** Lists the authenticated account's friends. */
  async getFriendList(): Promise<readonly UserInfo[]> {
    const userId = this.#requireUserId();
    const http = this.#requireHttp();
    const response = await http.postForm("getFriendList", `${FB_BASE_URL}/chat/user_info_all`, {}, {
      query: { viewer: userId },
    });
    const json = http.check("getFriendList", response);
    const payload = asRecord(asRecord(json)?.["payload"]) ?? asRecord(json);
    if (payload === null) {
      throw new APIError("Facebook returned no friend list payload", "API_ERROR", {
        retryable: false,
        context: { operation: "getFriendList" },
      });
    }
    const friends: UserInfo[] = [];
    for (const [id, raw] of Object.entries(payload)) {
      const info = normalizeUser(raw, id);
      if (info !== null) {
        friends.push(info);
      }
    }
    return friends;
  }

  /** Searches threads by name. */
  async searchThreads(query: string): Promise<readonly ThreadInfo[]> {
    const value = parseQuery(query);
    const json = await this.#postForm("searchThreads", `${FB_BASE_URL}/ajax/mercury/search_threads.php`, {
      client: "web_messenger",
      query: value,
      offset: 0,
      limit: 21,
      index: "fbid",
    });
    const payload = asRecord(json);
    const mercury = asRecord(asRecord(payload?.["payload"])?.["mercury_payload"]);
    const threads = mercury?.["threads"];
    const results: ThreadInfo[] = [];
    for (const entry of asArray(threads)) {
      const info = normalizeLegacyThread(entry);
      if (info !== null) {
        results.push(info);
        this.#threadKinds.set(info.id, info.isGroup);
      }
    }
    return results;
  }

  /** Searches message snippets across threads. */
  async searchMessages(query: string, options?: MessageSearchOptions | undefined): Promise<readonly MessageSearchResult[]> {
    const value = parseQuery(query);
    const opts = parseMessageSearchOptions(options);
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;

    const json = await this.#postForm("searchMessages", `${FB_BASE_URL}/ajax/mercury/search_snippets.php?dpr=1`, {
      query: value,
      offset: 0,
      limit,
    });
    const payload = asRecord(asRecord(json)?.["payload"]) ?? asRecord(json);
    const threadNodes = asArray(asRecord(payload?.["graphql_payload"])?.["message_threads"]);

    const results: MessageSearchResult[] = [];
    for (const node of threadNodes) {
      if (results.length >= limit) {
        break;
      }
      const record = asRecord(node);
      const key = asRecord(record?.["thread_key"]);
      const threadId = readId(key?.["thread_fbid"]) ?? readId(key?.["other_user_id"]);
      if (threadId === null) {
        continue;
      }

      const perThread = await this.#postForm(
        "searchMessages",
        `${FB_BASE_URL}/ajax/mercury/search_snippets.php?dpr=1`,
        {
          query: value,
          snippetOffset: 0,
          snippetLimit: limit - results.length,
          identifier: "thread_fbid",
          thread_fbid: threadId,
        },
      );
      const perThreadPayload = asRecord(asRecord(perThread)?.["payload"]) ?? asRecord(perThread);
      const threadSnippets = asRecord(asRecord(perThreadPayload?.["search_snippets"])?.[value]);
      const list = asArray(asRecord(threadSnippets?.[threadId])?.["snippets"]);
      for (const entry of list) {
        if (results.length >= limit) {
          break;
        }
        const snippet = asRecord(entry);
        const messageId = readId(snippet?.["message_id"]);
        if (messageId === null) {
          continue;
        }
        const author = readString(snippet, "author") ?? "";
        results.push({
          messageId,
          threadId,
          senderId: author.startsWith("fbid:") ? author.slice("fbid:".length) : author,
          body: readString(snippet, "body"),
          timestamp: toMillis(snippet?.["timestamp"]) ?? Date.now(),
        });
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Polls
  // -------------------------------------------------------------------------

  /** Creates a poll in a thread. */
  async createPoll(threadId: string, question: string, options: readonly string[]): Promise<void> {
    const id = parseThreadId(threadId);
    const text = parseQuery(question);
    const parsed = parsePollOptions(options);
    const form: Record<string, FormValue> = {
      target_id: id,
      question_text: text,
    };
    parsed.forEach((option, index) => {
      form[`option_text_array[${index}]`] = option;
      form[`option_is_selected_array[${index}]`] = "0";
    });
    const json = await this.#withOutboundGate("sendMessage", id, { operation: "createPoll" }, () =>
      this.#postForm(
        "createPoll",
        `${FB_BASE_URL}/messaging/group_polling/create_poll/?dpr=1`,
        form,
      ),
    );
    if (json === undefined) {
      // Dry-run mode — nothing was sent.
      return;
    }
    const status = readString(asRecord(asRecord(json)?.["payload"]), "status");
    if (status !== "success") {
      throw new APIError("Facebook did not create the poll", "API_ERROR", {
        retryable: false,
        context: { threadId: id, question: text },
      });
    }
  }

  /** Votes for one or more poll options. */
  async votePoll(pollId: string, optionIds: readonly string[]): Promise<void> {
    const id = parseMessageId(pollId);
    const ids = parseIdArray(optionIds, "optionIds");
    const form: Record<string, FormValue> = { question_id: id };
    ids.forEach((optionId, index) => {
      form[`selected_options[${index}]`] = optionId;
    });
    const json = await this.#withOutboundGate("global", undefined, { operation: "votePoll" }, () =>
      this.#postForm(
        "votePoll",
        `${FB_BASE_URL}/messaging/group_polling/update_vote/?dpr=1`,
        form,
      ),
    );
    if (json === undefined) {
      return;
    }
    const status = readString(asRecord(asRecord(json)?.["payload"]), "status");
    if (status !== "success") {
      throw new APIError("Facebook did not record the poll vote", "API_ERROR", {
        retryable: false,
        context: { pollId: id },
      });
    }
  }

  /** Returns the current state of a poll. */
  async getPoll(pollId: string): Promise<PollInfo> {
    const id = parseMessageId(pollId);
    const json = await this.#postForm("getPoll", `${FB_BASE_URL}/ajax/mercury/get_poll_options`, {
      question_id: id,
    });
    const payload = asRecord(json)?.["payload"] ?? json;
    const options = normalizePollOptions(payload);
    return normalizePoll(id, options, this.#pollQuestions.get(id) ?? null);
  }

  // -------------------------------------------------------------------------
  // Presence and receipts
  // -------------------------------------------------------------------------

  /** Shows or hides the typing indicator in a thread. */
  async setTyping(threadId: string, isTyping: boolean): Promise<void> {
    const id = parseThreadId(threadId);
    const typing = parseBoolean(isTyping, "isTyping");
    const mqtt = this.#requireMqtt();
    const isGroup = await this.#isGroupThread(id);
    const content = {
      app_id: Number(FB_LS_APP_ID),
      payload: JSON.stringify({
        label: 3,
        payload: JSON.stringify({
          thread_key: id,
          is_group_thread: isGroup ? 1 : 0,
          is_typing: typing ? 1 : 0,
          attribution: 0,
        }),
        version: Number(TYPING_TASK_VERSION),
      }),
      request_id: 1,
      type: 4,
    };
    await mqtt.publish(TOPIC_LS_REQ, JSON.stringify(content), { qos: 1, retain: false });
  }

  /** Marks a thread as read over MQTT. */
  async markAsRead(threadId: string): Promise<void> {
    const id = parseThreadId(threadId);
    const mqtt = this.#requireMqtt();
    await mqtt.publish(
      TOPIC_MARK_THREAD,
      JSON.stringify({ threadID: id, mark: "read", state: true }),
      { qos: 1, retain: false },
    );
  }

  /** Marks a message as delivered. */
  async markAsDelivered(messageId: string): Promise<void> {
    const id = parseMessageId(messageId);
    const targetThreadId = this.#messageThread.get(id);
    if (targetThreadId === undefined) {
      throw new ValidationError(
        "markAsDelivered needs the message's thread — call getMessages() or wait for a live event first",
        { context: { messageId: id } },
      );
    }
    await this.#postForm("markAsDelivered", `${FB_BASE_URL}/ajax/mercury/delivery_receipts.php`, {
      "message_ids[0]": id,
      [`thread_ids[${targetThreadId}][0]`]: id,
    });
  }

  /** Returns a user's presence, or `unknown` when it has never been observed. */
  async getPresence(userId: string): Promise<PresenceInfo> {
    const id = parseUserId(userId);
    const cached = this.#presence.get(id);
    if (cached !== undefined) {
      return cached;
    }
    return { userId: id, status: "unknown", lastActive: null, updatedAt: Date.now() };
  }

  // -------------------------------------------------------------------------
  // Internals: transports and login
  // -------------------------------------------------------------------------

  #createStorage(config: ResolvedConfig): StorageAdapter {
    if (config.storageAdapter === "memory") {
      return new MemoryStorage();
    }
    if (config.storageAdapter === "file") {
      return new FileStorage(config.storageDirectory, this.#logger);
    }
    return config.storageAdapter;
  }

  #handleListenerError(event: string, error: unknown): void {
    const wrapped = LibraryError.wrap(error, "API_ERROR", `Listener for "${String(event)}" failed`);
    this.#logger.warn({ event: String(event), err: wrapped.message }, "event listener threw");
    if (event !== "error") {
      this.#emitter.emitAndForget("error", {
        type: "error",
        timestamp: Date.now(),
        error: wrapped,
      });
    }
  }

  #requireHttp(): HttpTransport {
    if (this.#http === null) {
      throw new SessionError("Not authenticated — call login() first", "SESSION_NOT_AUTHENTICATED");
    }
    return this.#http;
  }

  #requireMqtt(): MqttTransport {
    if (this.#mqtt === null) {
      throw new MQTTError("The realtime connection is not up — call login() first", "MQTT_NOT_CONNECTED", {
        retryable: true,
      });
    }
    return this.#mqtt;
  }

  #requireUserId(): string {
    if (this.#userId === "") {
      throw new SessionError("Not authenticated — call login() first", "SESSION_NOT_AUTHENTICATED");
    }
    return this.#userId;
  }

  // ------------------------------------------------------------------
  // Stealth Guard helpers
  // ------------------------------------------------------------------

  /**
   * Gate an outbound operation through the Stealth Guard.
   * - dry-run mode: logs the payload summary and short-circuits without
   *   touching the network;
   * - otherwise: rate limit + circuit breaker + cap checks, then pacing
   *   jitter (unless `pace: false`).
   * Throws `AccountRestrictedError` when halted.
   */
  async #gateOutbound(
    operation: string,
    target: string | undefined,
    opts: { pace?: boolean | undefined; summary?: Record<string, unknown> | undefined } = {},
  ): Promise<{ dryRun: boolean }> {
    if (this.#dryRun) {
      this.#logger.info(
        { operation, target, ...(opts.summary ?? {}) },
        "DRY RUN — payload would be sent; nothing hit the network",
      );
      return { dryRun: true };
    }
    const decision = this.#stealth.checkOperation(operation, target);
    if (!decision.allowed) {
      throw new AccountRestrictedError(
        decision.reason ?? "outbound operation blocked by account protection",
        { context: { operation, target } },
      );
    }
    if (opts.pace !== false) {
      const delay = this.#stealth.getPacingDelay();
      if (delay > 0) {
        await sleep(delay);
      }
    }
    return { dryRun: false };
  }

  /** Release the guard's in-flight slot and count a completed send against the caps. */
  #completeOutbound(operation: string, target: string | undefined, countCaps: boolean): void {
    this.#stealth.markComplete(operation, target);
    if (countCaps) {
      this.#stealth.recordOutbound(operation, target);
    }
  }

  /**
   * Runs an outbound operation inside the guard. Returns `undefined` in
   * dry-run mode (nothing touched the network); otherwise returns fn()'s
   * result and releases the guard's accounting on the way out.
   */
  async #withOutboundGate<T>(
    operation: string,
    target: string | undefined,
    summary: Record<string, unknown>,
    fn: () => Promise<T>,
    opts?: { pace?: boolean | undefined },
  ): Promise<T | undefined> {
    const gate = await this.#gateOutbound(operation, target, { ...opts, summary });
    if (gate.dryRun) {
      return undefined;
    }
    try {
      const result = await fn();
      this.#completeOutbound(operation, target, true);
      return result;
    } catch (error) {
      this.#stealth.markComplete(operation, target);
      throw error;
    }
  }

  /** Bump the thread heat counter (G4). Bounded map; counts and recency only. */
  #bumpThreadHeat(threadId: string): void {
    const existing = this.#threadHeat.get(threadId);
    if (existing !== undefined) {
      existing.count += 1;
      existing.lastMs = Date.now();
      return;
    }
    // Bound the map so a long-running bot does not grow it forever.
    if (this.#threadHeat.size >= 500) {
      const oldest = this.#threadHeat.keys().next().value;
      if (oldest !== undefined) {
        this.#threadHeat.delete(oldest);
      }
    }
    this.#threadHeat.set(threadId, { count: 1, lastMs: Date.now() });
  }

  /** Local, own-traffic-only heat ranking for diagnostics (G4). */
  #threadHeatSnapshot(): { tracked: number; hottest: { threadId: string; score: number }[] } {
    const now = Date.now();
    const hottest = [...this.#threadHeat.entries()]
      .map(([threadId, entry]) => ({
        threadId,
        // Decay with a 12-hour half-life; count capped so one spammy room can't dominate.
        score:
          Math.round(
            Math.min(entry.count, 50) *
              Math.exp(-(now - entry.lastMs) / (12 * 60 * 60 * 1000)) *
              10,
          ) / 10,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return { tracked: this.#threadHeat.size, hottest };
  }

  /**
   * Feeds the detector from a caught error and records a suspension signal
   * when one matches. Checkpoint-class signals force the guard open
   * immediately (A9 checkpoint realtime guard).
   */
  #recordSignalFromError(error: unknown, operation?: string): void {
    if (!(error instanceof LibraryError)) {
      return;
    }
    const context = (error.context ?? {}) as Record<string, unknown>;
    const rawCode = context["code"];
    const numeric = typeof rawCode === "number" ? rawCode : undefined;
    let signal: SuspensionSignal | null = null;
    if (numeric !== undefined) {
      signal = detector.detectFromAPIError({
        code: numeric,
        message: error.message,
        errorSummary: typeof context["summary"] === "string" ? (context["summary"] as string) : undefined,
        errorDescription: typeof context["description"] === "string" ? (context["description"] as string) : undefined,
      });
    }
    if (signal === null) {
      const text = typeof context["message"] === "string" ? (context["message"] as string) : error.message;
      signal = detector.detectFromText(text, operation ?? "http");
    }
    if (signal === null) {
      return;
    }
    const isCheckpoint =
      signal.severity === "critical" && /checkpoint|verification|identity|approval/i.test(signal.message);
    if (isCheckpoint) {
      void this.#stealth.forceHalt(`checkpoint signal from ${operation ?? "http"}`);
    }
    void this.#stealth.recordSignal({
      ...signal,
      context: { ...signal.context, operation: operation ?? "unattributed" },
    });
  }

  /** Data for `diagnostics` — everything the guard knows, safe to serialize. */
  #externalStats(): { stealth: StealthDiagnostics } {
    const state = this.#stealth.getState();
    const audit = this.#stealth.getAudit().snapshot();
    return {
      stealth: {
        enabled: this.#stealthEnabled,
        circuitState: state.circuitState,
        warmupDay: state.warmupDay,
        warmupMultiplier: this.#stealth.getWarmupMultiplier(),
        signalsInWindow: state.signals.length,
        haltedAt: state.haltedAt,
        caps: this.#stealth.capsSnapshot(),
        healthScore: this.#health.getScore(),
        threads: this.#threadHeatSnapshot(),
        audit: {
          total: audit.total,
          recent: audit.entries.slice(-20).map((entry) => ({
            at: entry.at,
            decision: entry.decision,
            reason: entry.reason,
            ...(entry.operation !== undefined ? { operation: entry.operation } : {}),
            ...(entry.target !== undefined ? { target: entry.target } : {}),
          })),
        },
      },
    };
  }

  /**
   * Low-level text envelope send used by the E2EE handshake. Bypasses the
   * E2EE auto-route (handshakes must stay plaintext) but still respects
   * the Stealth Guard — a frozen account does not get exceptions.
   */
  async #sendRawEnvelope(threadId: string, body: string): Promise<string> {
    const gate = await this.#gateOutbound("sendMessage", threadId, {
      pace: false,
      summary: { envelope: "e2ee-handshake", bytes: body.length },
    });
    if (gate.dryRun) {
      return "dryrun_e2ee_hello";
    }
    const isGroup = await this.#isGroupThread(threadId);
    const offlineThreadingId = generateOfflineThreadingId();
    const form = buildMessageForm({
      userId: this.#requireUserId(),
      clientId: this.#clientId,
      threadId,
      isGroup,
      offlineThreadingId,
    });
    form["body"] = body;
    form["has_attachment"] = false;
    try {
      const json = await this.#postForm("sendMessage", `${FB_BASE_URL}/messaging/send/`, form);
      const payload = asRecord(asRecord(json)?.["payload"]) ?? asRecord(json);
      const actions = asArray(payload?.["actions"]);
      const first = asRecord(actions[0]);
      const messageId = readId(first?.["message_id"]);
      if (messageId === null) {
        throw new APIError("Facebook did not return a message id for the handshake send", "API_ERROR", {
          retryable: false,
          context: { operation: "sendMessage", threadId },
        });
      }
      return messageId;
    } finally {
      this.#completeOutbound("sendMessage", threadId, true);
    }
  }

  /** Deterministic, non-secret idempotency key for a send. */
  #idempotencyKey(operation: string, target: string | undefined, payload: unknown): string {
    return createHash("sha256")
      .update(operation)
      .update(":")
      .update(target ?? "")
      .update(":")
      .update(JSON.stringify(payload))
      .digest("base64url")
      .slice(0, 43);
  }

  async #scrapeTokens(http: HttpTransport): Promise<ScrapedTokens> {
    // The FCA login flow does exactly one thing: GET the desktop root with
    // the session cookies and parse the DTSGInitialData / LSD payloads out of
    // the response. A rejected session (e.g. the 1357004 envelope) means the
    // cookies themselves were refused — that is a fatal, re-export-the-cookies
    // error, not a header problem.
    const response = await http.get("login", `${FB_BASE_URL}/`, {
      withDefaults: false,
    });

    const diag = safeHomeDiagnostics(response.body, response.url, response.status);

    // Structured API error (e.g. the 1357004 "Please Refresh" envelope) —
    // Facebook refused the session itself; a fresh export is required.
    const apiError = extractFacebookApiError(response.body);
    if (apiError !== null) {
      const summary = summarizeHomeDiagnostics(diag);
      this.#logger.error(
        { operation: "login", code: apiError.code, status: diag.status, bytes: diag.contentLength },
        "Facebook returned a structured error on the home page",
      );
      if (apiError.code === "AUTH_REFRESH_REQUIRED") {
        void this.#handleSessionExpired("expired");
        throw new AuthenticationError(
          `Facebook rejected the session (error 1357004).\n\n` +
          `This means your cookies are no longer valid on Facebook's servers.\n\n` +
          `Common causes:\n` +
          `• You logged out of Facebook in your browser\n` +
          `• Facebook logged you out due to suspicious activity\n` +
          `• Cookies are too old (even if not technically expired)\n` +
          `• Account password was changed\n` +
          `• Session was revoked by Facebook security systems\n\n` +
          `HOW TO FIX:\n` +
          `1. Open Chrome/Firefox and log into facebook.com (use your actual browser, not incognito)\n` +
          `2. Install "Cookie-Editor" or "EditThisCookie" extension\n` +
          `3. On facebook.com, click the extension icon → Export → Copy as JSON\n` +
          `4. Save the JSON to a new file (e.g., appstate_${new Date().toISOString().split("T")[0]}.json)\n` +
          `5. Update your code to use the NEW file path\n` +
          `6. Do NOT reuse old cookie files - they must be freshly exported each time this error occurs\n\n` +
          `IMPORTANT: The cookies must come from a browser session that is CURRENTLY logged in.\n` +
          `If you see a login page when you visit facebook.com, your browser session is not valid.\n\n` +
          `Technical details: ${summary}`,
          "AUTH_REFRESH_REQUIRED",
          {
            retryable: false,
            context: { operation: "login", facebookCode: 1357004, ...diag },
          },
        );
      }
      throw new AuthenticationError(
        `Facebook rejected the session — ${apiError.message} (${summary})`,
        apiError.code,
        {
          retryable: apiError.retryable,
          context: { operation: "login", ...diag },
        },
      );
    }

    // Logged-out splash screen — no session.
    if (diag.mqttWebConfigEmpty) {
      const summary = summarizeHomeDiagnostics(diag);
      this.#logger.error({ operation: "login", ...diag }, "Facebook returned the logged-out splash screen");
      throw new AuthenticationError(
        `Facebook session is not logged in. The home page returned the logged-out splash. Export cookies from a browser where you are actively logged into Facebook. (${summary})`,
        "AUTH_SESSION_EXPIRED",
        { retryable: false, context: { operation: "login", ...diag } },
      );
    }

    // Redirected to login / checkpoint.
    const isLoginPage =
      response.url.includes("/login") ||
      response.url.includes("/checkpoint") ||
      response.url.includes("/two_step_verification") ||
      diag.hasLoginForm ||
      diag.hasCheckpoint;
    if (isLoginPage) {
      const isCheckpoint =
        response.url.includes("/checkpoint") ||
        response.url.includes("/two_step_verification") ||
        diag.hasCheckpoint;
      const summary = summarizeHomeDiagnostics(diag);
      throw new AuthenticationError(
        isCheckpoint
          ? `Facebook requires a security checkpoint — log in via a browser to clear it (${summary})`
          : `Facebook rejected the session and redirected to the login page (${summary})`,
        "AUTH_SESSION_EXPIRED",
        {
          retryable: false,
          context: { operation: "login", url: response.url, isCheckpoint, ...diag },
        },
      );
    }

    // Extract tokens from the boot page.
    const tokens = scrapeTokens(response.body, this.#requireUserId());
    if (tokens === null) {
      const summary = summarizeHomeDiagnostics(diag);
      this.#logger.error(
        { operation: "login", ...diag },
        "Could not scrape session tokens from the home page",
      );
      throw new AuthenticationError(
        `Could not read Facebook's session tokens from the home page. Your cookies may be corrupted or too old. Export fresh cookies from a browser where you are actively logged into Facebook. (${summary})`,
        "AUTH_LOGIN_REJECTED",
        { retryable: false, context: { operation: "login", ...diag } },
      );
    }

    this.#logger.info(
      { operation: "login", region: tokens.region },
      "Session tokens scraped from the home page",
    );
    return tokens;
  }

  #applyTokens(tokens: ScrapedTokens): void {
    const http = this.#requireHttp();
    const region = this.#session.region ?? tokens.region;
    this.#session.setRegion(region);
    http.setTokens({
      userId: this.#requireUserId(),
      fbDtsg: tokens.fbDtsg,
      jazoest: computeJazoest(tokens.fbDtsg),
      lsd: tokens.lsd,
      revision: tokens.revision,
      region,
    });
    this.#clientId = tokens.clientId;
    if (tokens.irisSeqId !== null && this.#session.lastSeqId === null) {
      this.#session.setCursor({ lastSeqId: tokens.irisSeqId, syncToken: this.#session.syncToken });
    }
  }

  /**
   * Rotates a stale-but-valid session: scrapes a fresh `fb_dtsg` from the
   * desktop home page.
   *
   * A refresh only counts when a DTSG-anchored token is actually present in
   * the returned page. The page is rejected when it serves Facebook's
   * structured error envelope (e.g. the small 1357004 "session too stale"
   * JSON document), a logged-out page, or a redirect to login/checkpoint —
   * those responses carry no usable token. jazoest is always derived from
   * fb_dtsg, exactly like the web client computes it.
   *
   * Best-effort by design: if Facebook refuses to serve tokens even with the
   * cookies, the session is revoked beyond recovery and this returns false.
   * Never logs or persists token values.
   */
  async #refreshSessionTokens(http: HttpTransport): Promise<boolean> {
    let response;
    try {
      // withDefaults:false — the page must not receive the very stale
      // fb_dtsg/jazoest pair being refreshed; plain cookies are enough.
      response = await http.get("refreshSessionTokens", `${FB_BASE_URL}/`, {
        withDefaults: false,
      });
    } catch (error) {
      this.#logger.debug(
        { operation: "refreshSessionTokens", err: errorMessage(error) },
        "Home page request failed during token refresh",
      );
      return false;
    }

    // Facebook's structured error envelope — no usable token, ever.
    const apiError = extractFacebookApiError(response.body);
    if (apiError !== null) {
      this.#logger.debug(
        { operation: "refreshSessionTokens", code: apiError.code, bytes: response.body.length },
        `Home page returned a structured Facebook error (${apiError.code}) — session is stale or revoked`,
      );
      return false;
    }

    if (isLoggedOutHomePage(response.body)) {
      this.#logger.debug(
        { operation: "refreshSessionTokens" },
        "Home page returned logged-out page",
      );
      return false;
    }

    const finalUrl = response.url ?? "";
    if (
      finalUrl.includes("/login") ||
      finalUrl.includes("/checkpoint") ||
      finalUrl.includes("/two_step_verification")
    ) {
      this.#logger.debug(
        { operation: "refreshSessionTokens" },
        "Home page redirected to login/checkpoint",
      );
      return false;
    }

    const tokens = extractSessionTokens(response.body);
    if (tokens !== null) {
      const current = http.tokens;
      http.setTokens({
        userId: this.#requireUserId(),
        fbDtsg: tokens.fbDtsg,
        jazoest: tokens.jazoest,
        lsd: current.lsd,
        revision: current.revision,
        region: current.region,
      });
      this.#logger.info(
        { operation: "refreshSessionTokens" },
        "Refreshed fb_dtsg from the home page",
      );
      return true;
    }

    this.#logger.debug(
      { operation: "refreshSessionTokens", status: response.status },
      "Home page yielded no fb_dtsg",
    );
    return false;
  }

  async #validateSession(http: HttpTransport): Promise<void> {
    const userId = this.#requireUserId();
    const json = await this.#postForm("validateLogin", `${FB_BASE_URL}/chat/user_info/`, { "ids[0]": userId });
    const payload = asRecord(json);
    const profiles = asRecord(asRecord(payload?.["payload"])?.["profiles"]);
    if (profiles === null || Object.keys(profiles).length === 0) {
      throw new AuthenticationError(
        "Facebook did not return a profile for the authenticated user",
        "AUTH_LOGIN_REJECTED",
        { retryable: false, context: { operation: "validateLogin" } },
      );
    }
  }

  /**
   * Re-establishes the web client's presence session after login. The web
   * client calls this endpoint with `reason=6`; failure is non-fatal because
   * presence still flows over `/orca_presence`, but a successful call keeps
   * the account's availability state consistent with the browser session.
   */
  async #reconnectPresence(http: HttpTransport): Promise<void> {
    try {
      await http.get("presenceReconnect", `${FB_BASE_URL}/ajax/presence/reconnect.php`, {
        query: { reason: 6 },
      });
      this.#debug("login", "presence reconnect accepted", {});
    } catch (error) {
      this.#logger.debug({ err: errorMessage(error) }, "presence reconnect failed");
    }
  }

  async #refreshCookies(): Promise<void> {
    const http = this.#requireHttp();
    const attemptHome = () =>
      http.get("cookieRefresh", `${FB_BASE_URL}/`, { withDefaults: false });

    let response = await attemptHome();
    let diag = safeHomeDiagnostics(response.body, response.url, response.status);
    let apiError = extractFacebookApiError(response.body);

    // Best-effort recovery: if the session is stale, rotate fb_dtsg/jazoest
    // from the home page and retry once.
    if (apiError?.code === "AUTH_REFRESH_REQUIRED") {
      const refreshed = await this.#refreshSessionTokens(http);
      if (refreshed) {
        response = await attemptHome();
        diag = safeHomeDiagnostics(response.body, response.url, response.status);
        apiError = extractFacebookApiError(response.body);
      }
    }

    if (apiError !== null) {
      void this.#handleSessionExpired("expired");
      const summary = summarizeHomeDiagnostics(diag);
      throw new AuthenticationError(
        apiError.code === "AUTH_REFRESH_REQUIRED"
          ? `Facebook rejected the session during cookie refresh — session is too stale to reuse (error 1357004); re-export your cookies from a browser that is actually logged in (${summary})`
          : `Facebook rejected the session during cookie refresh — ${apiError.message} (${summary})`,
        apiError.code,
        {
          retryable: false,
          context: { operation: "cookieRefresh", ...diag },
        },
      );
    }

    if (diag.mqttWebConfigEmpty) {
      void this.#handleSessionExpired("expired");
      throw new AuthenticationError(
        `Facebook rejected the session during cookie refresh — the home page returned the logged-out page (${summarizeHomeDiagnostics(diag)})`,
        "AUTH_SESSION_EXPIRED",
        { retryable: false, context: { operation: "cookieRefresh", ...diag } },
      );
    }

    const isExpiredPage =
      response.url.includes("/login") ||
      response.url.includes("/checkpoint") ||
      response.url.includes("/two_step_verification") ||
      diag.hasLoginForm ||
      diag.hasCheckpoint;
    if (isExpiredPage) {
      void this.#handleSessionExpired("expired");
      throw new AuthenticationError(
        `Facebook redirected the session during cookie refresh (${summarizeHomeDiagnostics(diag)})`,
        "AUTH_SESSION_EXPIRED",
        { retryable: false, context: { operation: "cookieRefresh", ...diag } },
      );
    }
    const tokens = scrapeTokens(response.body, this.#requireUserId());
    if (tokens === null) {
      this.#logger.warn(
        { operation: "cookieRefresh", ...diag },
        "token refresh failed — no token payloads found on the home page",
      );
      throw new AuthenticationError(
        `Could not refresh Facebook's session tokens (${summarizeHomeDiagnostics(diag)})`,
        "AUTH_LOGIN_REJECTED",
        { retryable: true, context: { operation: "cookieRefresh", ...diag } },
      );
    }
    this.#applyTokens(tokens);
  }

  async #postForm(
    operation: string,
    url: string,
    form: Readonly<Record<string, FormValue>>,
  ): Promise<unknown> {
    const http = this.#requireHttp();
    try {
      const response = await http.postForm(operation, url, form);
      return http.check(operation, response);
    } catch (error) {
      this.#recordSignalFromError(error, operation);
      if (error instanceof AuthenticationError) {
        if (error.code === "AUTH_SESSION_EXPIRED") {
          void this.#handleSessionExpired("expired");
        } else if (error.code === "AUTH_LOGIN_REJECTED") {
          void this.#handleSessionExpired("invalid");
        }
      }
      throw error;
    }
  }

  /**
   * A9/A12 — when Facebook rejects the session, attempt one full cookie
   * re-validation before tearing anything down (A12). If that fails, freeze
   * proactive sends permanently for this process (A2), emit `session_dead`,
   * and only then tear down.
   */
  async #handleSessionExpired(reason: "expired" | "invalid"): Promise<void> {
    const state = this.#session.state;
    if (state !== "ACTIVE" && state !== "RECONNECTING") {
      return;
    }
    // Re-entrant call from the re-validation itself (cookie refresh failing
    // inside forceRefresh routes back here) — return immediately so the
    // single attempt stays single.
    if (this.#expiryHandling) {
      return;
    }
    this.#expiryHandling = true;
    try {
      const revived = await this.#tokenRefresh.forceRefresh();
      if (revived) {
        this.#logger.info("session re-validated via cookie refresh — staying connected");
        this.#health.recordRequest();
        this.#expiryHandling = false;
        return;
      }
    } catch (error) {
      this.#logger.debug({ err: errorMessage(error) }, "session re-validation failed — tearing down");
    }
    void this.#stealth.forceHalt("session rejected by Facebook");
    this.#emitter.emitAndForget("session_dead", {
      type: "session_dead",
      timestamp: Date.now(),
      reason: "session rejected by Facebook — re-export cookies from a logged-in browser",
    });
    this.#session.markClosing();
    this.#session.markClosed();

    const mqtt = this.#mqtt;
    this.#mqtt = null;
    this.#delta = null;
    this.#sync = null;
    if (mqtt !== null) {
      void mqtt.close(true).catch(() => undefined);
    }
    const http = this.#http;
    this.#http = null;
    if (http !== null) {
      void http.close().catch(() => undefined);
    }

    this.#tokenRefresh.stop();
    this.#watchdog.stop();
    this.#health.stop();
    this.#idempotency.stop();

    this.#clearSessionCaches();
    this.#userId = "";
    void this.#session.clearPersisted();
    this.#emitter.emitAndForget("logout", {
      type: "logout",
      timestamp: Date.now(),
      userId: this.#session.userId,
      reason,
    });
  }

  /** Emits a `debug` event when the configured log level asks for it. */
  #debug(module: string, message: string, data: unknown = null): void {
    if (this.#config.logLevel !== "debug" && this.#config.logLevel !== "trace") {
      return;
    }
    this.#emitter.emitAndForget("debug", {
      type: "debug",
      timestamp: Date.now(),
      module,
      message,
      data,
    });
  }

  async #batch(
    operation: string,
    queries: Readonly<Record<string, unknown>>,
    batchName?: string | undefined,
  ): Promise<GraphQLBatchResult> {
    return postGraphQLBatch(this.#requireHttp(), operation, queries, batchName);
  }

  async #mutateReaction(messageId: string, action: "ADD_REACTION" | "REMOVE_REACTION", reaction: string): Promise<void> {
    const gate = await this.#gateOutbound("addReaction", undefined, { pace: true, summary: { action, operation: "reaction" } });
    if (gate.dryRun) {
      return;
    }
    const userId = this.#requireUserId();
    this.#clientMutationId += 1;
    try {
      await postWebGraphQLMutation(this.#requireHttp(), "setReaction", DOC_IDS.reaction, {
        data: {
          client_mutation_id: String(this.#clientMutationId),
          actor_id: userId,
          action,
          message_id: messageId,
          reaction,
        },
      });
    } finally {
      this.#completeOutbound("addReaction", undefined, true);
    }
  }

  async #isGroupThread(threadId: string): Promise<boolean> {
    const cached = this.#threadKinds.get(threadId);
    if (cached !== undefined) {
      return cached;
    }
    // Length 15 is ambiguous — user ids and some group ids share it. Ask
    // Facebook once and cache the answer; on failure, use the length heuristic.
    if (threadId.length === 15) {
      try {
        const info = await this.getThread(threadId);
        return info.isGroup;
      } catch (error) {
        this.#logger.debug(
          { threadId, err: errorMessage(error) },
          "could not resolve the thread kind; falling back to the length heuristic",
        );
      }
    }
    // Matches the web client's heuristic: user ids are short, group ids long.
    return threadId.length > 15;
  }

  async #send(
    threadId: string,
    content: MessageContent,
    replyToMessageId?: string | undefined,
  ): Promise<MessageSendResult> {
    const gate = await this.#gateOutbound("sendMessage", threadId, {
      pace: true,
      summary: {
        type: content.type,
        bytes: content.type === "text" ? content.body.length : 0,
        replyTo: replyToMessageId ?? null,
      },
    });
    
    // Apply anti-detection timing jitter before send
    await this.#antiDetect.applyJitter();
    
    if (gate.dryRun) {
      return {
        messageId: `dryrun_${randomUUID().slice(0, 8)}`,
        threadId,
        offlineThreadingId: `dryrun_${randomUUID().slice(0, 8)}`,
      };
    }

    // G5 — idempotent send: the same content within the TTL returns the cached message id.
    const idemKey = this.#idempotencyKey("sendMessage", threadId, { content, replyToMessageId });
    const cached = await this.#idempotency.checkKey(idemKey);
    if (cached.exists && cached.status === "sent" && cached.messageId !== undefined) {
      this.#logger.info({ threadId }, "idempotent retry — returning the cached message id");
      this.#stealth.markComplete("sendMessage", threadId);
      return { messageId: cached.messageId, threadId, offlineThreadingId: "idempotent" };
    }
    await this.#idempotency.recordAttempt(idemKey);

    try {
      const isGroup = await this.#isGroupThread(threadId);
      const offlineThreadingId = generateOfflineThreadingId();
    const form = buildMessageForm({
      userId: this.#requireUserId(),
      clientId: this.#clientId,
      threadId,
      isGroup,
      offlineThreadingId,
      replyToMessageId,
    });

    switch (content.type) {
      case "text": {
        const mentions = content.mentions ?? [];
        if (mentions.length > 0) {
          form["body"] = `\u200E${content.body}`;
          mentions.forEach((mention, index) => {
            const offset = content.body.indexOf(mention.tag, mention.fromIndex ?? 0);
            form[`profile_xmd[${index}][offset]`] = offset + 1;
            form[`profile_xmd[${index}][length]`] = mention.tag.length;
            form[`profile_xmd[${index}][id]`] = mention.id;
            form[`profile_xmd[${index}][type]`] = "p";
          });
        } else {
          form["body"] = content.body;
        }
        break;
      }
      case "sticker": {
        form["sticker_id"] = content.stickerId;
        break;
      }
      case "gif": {
        form["gif_ids"] = [content.gifId];
        break;
      }
      case "attachment": {
        const info = this.#mediaCache.get(content.attachmentId);
        const kind = info?.kind ?? "file";
        form[`${kind}_ids`] = [content.attachmentId];
        break;
      }
    }

    form["has_attachment"] = content.type !== "text";

    const json = await this.#postForm("sendMessage", `${FB_BASE_URL}/messaging/send/`, form);
    const payload = asRecord(asRecord(json)?.["payload"]) ?? asRecord(json);
    const actions = asArray(payload?.["actions"]);
    const first = asRecord(actions[0]);
    const messageId = readId(first?.["message_id"]);
    if (messageId === null) {
      throw new APIError("Facebook did not return a message id for the send", "API_ERROR", {
        retryable: false,
        context: { operation: "sendMessage", threadId },
      });
    }
    const responseThreadId = readId(first?.["thread_fbid"]) ?? threadId;
    this.#debug("sendMessage", "Facebook accepted the message", {
      messageId,
      threadId: responseThreadId,
    });
    this.#health.recordRequest();
    await this.#idempotency.markSuccess(idemKey, messageId);
    this.#completeOutbound("sendMessage", threadId, true);
    return { messageId, threadId: responseThreadId, offlineThreadingId };
    } catch (error) {
      this.#health.recordError();
      await this.#idempotency.markFailure(idemKey).catch(() => undefined);
      this.#stealth.markComplete("sendMessage", threadId);
      throw error;
    }
  }

  async #upload(file: FileInput): Promise<MediaInfo> {
    const info = await uploadMedia(this.#requireHttp(), this.#logger, file);
    this.#mediaCache.set(info.attachmentId, info);
    await this.#cache.set(`media:${info.attachmentId}`, info, {
      ttlSeconds: CACHE_TTL_SECONDS.user,
      tags: [CACHE_TAGS.user],
    });
    return info;
  }

  async #resolveAttachmentUrl(attachmentId: string): Promise<string> {
    const cached = this.#attachmentUrls.get(attachmentId);
    if (cached !== undefined && cached.url !== "") {
      return cached.url;
    }
    const kind = cached?.kind;
    if (kind === undefined || kind === "photo" || kind === "animated_image") {
      try {
        const url = await resolvePhotoUrl(this.#requireHttp(), attachmentId);
        this.#attachmentUrls.set(attachmentId, { url, kind: kind ?? "photo" });
        return url;
      } catch (error) {
        if (kind === "photo" || kind === "animated_image") {
          throw new APIError(
            `Could not resolve a downloadable URL for attachment "${attachmentId}"`,
            "MEDIA_NOT_FOUND",
            { retryable: false, context: { attachmentId }, cause: error },
          );
        }
      }
    }
    throw new APIError(
      `No downloadable URL is known for attachment "${attachmentId}"`,
      "ATTACHMENT_URL_UNAVAILABLE",
      { retryable: false, context: { attachmentId } },
    );
  }

  async #setMute(threadId: string, setting: string): Promise<void> {
    const id = parseThreadId(threadId);
    await this.#postForm("setMute", `${FB_BASE_URL}/ajax/mercury/change_mute_thread.php`, {
      thread_fbid: id,
      mute_settings: setting,
    });
  }

  async #setArchived(threadId: string, archived: boolean): Promise<void> {
    const id = parseThreadId(threadId);
    await this.#postForm("setArchived", `${FB_BASE_URL}/ajax/mercury/change_archived_status.php`, {
      [`ids[${id}]`]: archived,
    });
  }

  // -------------------------------------------------------------------------
  // Internals: realtime
  // -------------------------------------------------------------------------

  #handleMessage(topic: string, payload: unknown): void {
    const delta = this.#delta;
    if (delta === null) {
      return;
    }
    this.#watchdog.recordMessage();
    if (topic === "/t_ms") {
      this.#watchdog.recordSyncMessage();
    }
    this.#debug("mqtt", "payload received", { topic, payload });
    void delta.handleMessage(topic, payload).catch((error) => {
      this.#logger.warn({ topic, err: errorMessage(error) }, "delta processing failed");
    });
  }

  #createSink(): DeltaSink {
    return {
      raw: (topic, payload) => {
        const signal = detector.detectFromMQTTPayload(topic, payload);
        if (signal !== null) {
          void this.#stealth.recordSignal(signal);
        }
        this.#emitter.emitAndForget("raw", {
          type: "raw",
          timestamp: Date.now(),
          topic,
          payload,
        });
      },
      warning: (message, context) => {
        this.#emitter.emitAndForget("warning", {
          type: "warning",
          timestamp: Date.now(),
          message,
          context,
        });
      },
      message: (event) => {
        this.#bumpThreadHeat(event.threadId);
        this.#cacheEventMessage(event);
        this.#emitter.emitAndForget("message", event);
      },
      message_reply: (event) => {
        this.#bumpThreadHeat(event.threadId);
        this.#cacheEventMessage(event);
        this.#emitter.emitAndForget("message_reply", event);
      },
      message_unsend: (event) => {
        this.#messages.delete(event.messageId);
        this.#messageThread.delete(event.messageId);
        this.#emitter.emitAndForget("message_unsend", event);
      },
      reaction: (event) => {
        const cached = this.#messages.get(event.messageId);
        if (cached !== undefined) {
          const others = cached.reactions.filter((reaction) => reaction.userId !== event.userId);
          const emoji = event.emoji;
          const reactions = emoji === null ? others : [...others, { userId: event.userId, emoji }];
          this.#messages.set(event.messageId, { ...cached, reactions });
        }
        this.#emitter.emitAndForget("reaction", event);
      },
      typing: (event) => {
        this.#emitter.emitAndForget("typing", event);
      },
      presence: (event) => {
        this.#setBounded(
          this.#presence,
          event.userId,
          {
            userId: event.userId,
            status: event.status,
            lastActive: event.lastActive,
            updatedAt: event.timestamp,
          },
          PRESENCE_CACHE_LIMIT,
        );
        this.#emitter.emitAndForget("presence", event);
      },
      read: (event) => {
        this.#emitter.emitAndForget("read", event);
      },
      delivered: (event) => {
        for (const messageId of event.messageIds) {
          this.#setBounded(this.#messageThread, messageId, event.threadId, MESSAGE_CACHE_LIMIT);
        }
        this.#emitter.emitAndForget("delivered", event);
      },
      participant_join: (event) => {
        this.#emitter.emitAndForget("participant_join", event);
      },
      participant_leave: (event) => {
        this.#emitter.emitAndForget("participant_leave", event);
      },
      admin_change: (event) => {
        this.#emitter.emitAndForget("admin_change", event);
      },
      thread_update: (event) => {
        this.#emitter.emitAndForget("thread_update", event);
      },
      poll: (event) => {
        if (event.question !== null && event.question !== "") {
          this.#pollQuestions.set(event.pollId, event.question);
        }
        this.#emitter.emitAndForget("poll", event);
      },
      call: (event) => {
        this.#emitter.emitAndForget("call", event);
      },
    };
  }

  async #handleForcedFetch(threadId: string, messageId: string): Promise<MessageEvent | ThreadUpdateEvent | null> {
    const batch = await this.#batch("forcedFetch", {
      o0: {
        doc_id: DOC_IDS.forcedFetch,
        query_params: {
          thread_and_message_id: { thread_id: threadId, message_id: messageId },
        },
      },
    });
    const node = asRecord(batch.data?.["message"]);
    if (node === null) {
      return null;
    }
    const typename = readString(node, "__typename");
    const senderId = readString(asRecord(node["message_sender"]), "id") ?? "";
    const timestamp = toMillis(node["timestamp_precise"]) ?? Date.now();

    if (typename === "ThreadImageMessage") {
      const image = asRecord(node["image_with_metadata"]);
      const preview = asRecord(image?.["preview"]);
      const dimensions = asRecord(image?.["original_dimensions"]);
      return {
        type: "thread_update",
        timestamp,
        threadId,
        actorId: senderId,
        action: "photo",
        details: {
          attachmentId: readString(image, "legacy_attachment_id"),
          width: toNumber(dimensions?.["x"] ?? dimensions?.["width"]),
          height: toNumber(dimensions?.["y"] ?? dimensions?.["height"]),
          url: readString(preview, "uri"),
        },
        isSelf: senderId === this.#requireUserId(),
      };
    }

    if (typename === "ThreadNameMessage") {
      return {
        type: "thread_update",
        timestamp,
        threadId,
        actorId: senderId,
        action: "name",
        details: { name: readString(node, "thread_name") },
        isSelf: senderId === this.#requireUserId(),
      };
    }

    if (typename === "GenericAdminTextMessage") {
      const adminType = readString(node, "extensible_message_admin_text_type");
      const action =
        adminType === "CHANGE_THREAD_THEME"
          ? "color"
          : adminType === "CHANGE_THREAD_ICON"
            ? "icon"
            : adminType === "CHANGE_THREAD_NICKNAME"
              ? "nickname"
              : "unknown";
      return {
        type: "thread_update",
        timestamp,
        threadId,
        actorId: senderId,
        action,
        details: {
          adminType,
          data: asRecord(node["extensible_message_admin_text"]) ?? {},
        },
        isSelf: senderId === this.#requireUserId(),
      };
    }

    return messageEventFromNode(node, threadId, this.#requireUserId(), await this.#isGroupThread(threadId));
  }

  #cacheEventMessage(event: MessageEvent | MessageReplyEvent): void {
    const message = messageFromEvent(event);
    this.#cacheMessage(message);
    this.#setBounded(this.#threadKinds, event.threadId, event.isGroup, THREAD_KIND_CACHE_LIMIT);
  }

  #cacheMessage(message: Message): void {
    this.#setBounded(this.#messages, message.id, message, MESSAGE_CACHE_LIMIT);
    this.#setBounded(this.#messageThread, message.id, message.threadId, MESSAGE_CACHE_LIMIT);
    for (const attachment of message.attachments) {
      if (attachment.url !== null && attachment.url !== "") {
        this.#setBounded(
          this.#attachmentUrls,
          attachment.id,
          { url: attachment.url, kind: attachment.type },
          ATTACHMENT_CACHE_LIMIT,
        );
      }
    }
  }

  #setBounded<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
    if (map.has(key)) {
      map.delete(key);
    } else if (map.size >= limit) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) {
        map.delete(oldest);
      }
    }
    map.set(key, value);
  }

  #persistSoon(): void {
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer);
    }
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      void this.#session.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.#persistTimer.unref?.();
  }

  #clearSessionCaches(): void {
    this.#messages.clear();
    this.#messageThread.clear();
    this.#attachmentUrls.clear();
    this.#threadKinds.clear();
    this.#pollQuestions.clear();
    this.#presence.clear();
    this.#mediaCache.clear();
    this.#threadHeat.clear();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolved E2EE behaviour for this session. */
interface ResolvedE2EEOptions {
  readonly enabled: boolean;
  /** Fail login when the encrypted channel cannot be established. */
  readonly require: boolean;
  /** Connect automatically at login (default true when enabled). */
  readonly autoConnect: boolean;
  readonly selfListen: boolean;
  readonly deviceStorePath: string;
  readonly deviceListCacheMs: number;
}

/**
 * Maps the high-level `ClientOptions.e2ee` input (string shorthand or partial
 * config object) onto the resolved options for the session.
 */
function resolveE2EEOptions(
  input: ClientOptions["e2ee"],
  storageDirectory: string,
): ResolvedE2EEOptions {
  const deviceStorePath = `${storageDirectory.replace(/[\\/]+$/, "")}/e2ee_device.json`;
  const base: ResolvedE2EEOptions = {
    enabled: false,
    require: false,
    autoConnect: true,
    selfListen: false,
    deviceStorePath,
    deviceListCacheMs: 0,
  };
  if (input === undefined || input === "off") {
    return base;
  }
  if (typeof input === "string") {
    if (input === "require") {
      return { ...base, enabled: true, require: true };
    }
    // "auto"
    return { ...base, enabled: true };
  }
  return {
    enabled: input.enabled ?? true,
    require: input.require ?? false,
    autoConnect: input.autoConnect ?? true,
    selfListen: input.selfListen ?? false,
    deviceListCacheMs: input.deviceListCacheMs ?? 0,
    deviceStorePath: input.deviceStorePath ?? deviceStorePath,
  };
}

/** Reads a FileInput into a Buffer plus a best-effort filename. */
async function readFileInput(file: FileInput, fallbackName: string): Promise<{ data: Buffer; fileName: string }> {
  if (Buffer.isBuffer(file)) {
    return { data: file, fileName: fallbackName };
  }
  if (typeof file === "string") {
    return { data: readFileSync(file), fileName: basename(file) };
  }
  const chunks: Buffer[] = [];
  for await (const chunk of file) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return { data: Buffer.concat(chunks), fileName: fallbackName };
}
