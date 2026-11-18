/**
 * Public entry point.
 *
 * The root export is the stable surface described in the README: the client,
 * the typed error hierarchy, the public types and constants, and the
 * transport/session building blocks advanced integrations may need.
 *
 * `login()` is also the package's default export: `require("panindigan-automate")`
 * is callable like the classic fca-style entry, and `import login from ...`
 * does the same in ESM.
 */

export { MessengerClient } from "./client/index.js";
export { login } from "./login.js";
export type { LoginCallback } from "./login.js";

export * from "./constants.js";
export * from "./errors/index.js";
export * from "./types/index.js";

export { LruCache, NamespacedCache } from "./cache/index.js";
export type { CacheAdapterStats } from "./cache/index.js";
export { FileStorage, MemoryStorage, NamespacedStorage } from "./storage/index.js";
export { SessionManager } from "./session/index.js";
export type { PersistedSession, PreparedLogin, SessionCursor, SessionStateListener } from "./session/index.js";
export { HttpTransport } from "./transport/http/index.js";
export type {
  DownloadResponse,
  FormValue,
  HttpResponse,
  RequestOptions,
  RequestTokens,
  UploadFile,
} from "./transport/http/index.js";
export { MqttTransport } from "./transport/mqtt/index.js";
export type {
  ConnectionLostInfo,
  LsTaskSpec,
  MqttTransportCallbacks,
  MqttTransportDeps,
  PublishOptions,
  ReconnectExhaustedInfo,
  SyncCursor,
  SyncEstablishedInfo,
} from "./transport/mqtt/index.js";
export { DeltaProcessor } from "./delta/index.js";
export type { DeltaEvent, DeltaSink, ForcedFetchHandler, ParserContext } from "./delta/index.js";
export { MiddlewareManager } from "./middleware/index.js";
export type { MiddlewareSource } from "./middleware/index.js";
export { PluginManager } from "./plugins/index.js";
export type { PluginState, PluginView } from "./plugins/index.js";

// Logger — pino JSON by default; opt-in console logger (LogTransport re-exported via types)
export { createRootLogger } from "./logger/index.js";
export type { Logger, LogLevel, LoggerOptions } from "./logger/index.js";
export { TypedEmitter } from "./events/index.js";
export { DiagnosticsCollector } from "./diagnostics/index.js";
export { SyncEndpoint } from "./sync/index.js";

// Stealth Guard (A1–A12, F2, G1, G3, G4, G5, G8)
export { StealthGuard, DEFAULT_STEALTH_CONFIG } from "./stealth/index.js";
export type {
  CircuitState,
  GuardDecisionResult,
  StealthCaps,
  StealthConfig,
  StealthGuardCallbacks,
  StealthState,
  SuspensionSeverity,
  SuspensionSignal,
} from "./stealth/index.js";
export { SuspensionDetector, detector } from "./stealth/detector.js";
export { GuardAuditLog } from "./stealth/audit-log.js";
export type { GuardAuditEntry, GuardDecision } from "./stealth/audit-log.js";
export { MessageChunker, DEFAULT_CHUNKING_CONFIG } from "./stealth/chunking.js";
export type { ChunkingConfig, MessageChunk } from "./stealth/chunking.js";
export { IdempotencyManager, DEFAULT_IDEMPOTENCY_CONFIG } from "./stealth/idempotency.js";
export type { IdempotencyConfig } from "./stealth/idempotency.js";
export { HealthScoreCalculator, DEFAULT_HEALTH_SCORE_CONFIG } from "./stealth/health-score.js";
export type { HealthScoreConfig, HealthScoreCallbacks, HealthFactors } from "./stealth/health-score.js";
export { TokenRefreshManager, DEFAULT_TOKEN_REFRESH_CONFIG } from "./stealth/token-refresh.js";
export type { TokenRefreshConfig } from "./stealth/token-refresh.js";
export { MQTTWatchdog, DEFAULT_WATCHDOG_CONFIG } from "./stealth/watchdog.js";
export type { WatchdogConfig, WatchdogCallbacks } from "./stealth/watchdog.js";
export { SlidingWindowCap, TokenBucket } from "./stealth/rate-limiter.js";
export type { OperationLimits, RateLimitConfig, WindowState, CapLevel } from "./stealth/rate-limiter.js";

// Anti-Detection Protection (NEW in v0.2.0)
export {
  AntiDetectionManager,
  DEFAULT_ANTI_DETECTION_CONFIG,
  generateHardwareDeviceId,
  generateUserAgent,
  generateClientHints,
  applyTimingJitter,
  humanLikeDelay,
  calculateAdaptiveDelay,
} from "./stealth/index.js";
export type { AntiDetectionConfig, DeviceFingerprint } from "./stealth/index.js";

// Update checker — automatic and on by default since 0.2.0 (backup + rollback; restart required);
// opt out with `update: { enabled: false }` or `autoInstall: false`.
export { UpdateChecker, isOlder, DEFAULT_UPDATE_CONFIG } from "./update/index.js";
export type {
  UpdateCheckerOptions,
  UpdateInfo,
  UpdateCheckResult,
  UpdateHistory,
  UpdateStatus,
  InstallationStatus,
  PackageManager,
  PackageManagerInfo,
} from "./update/index.js";

// E2EE — 1:1 Messenger E2EE (faithful port of bhhoang/fbapi-unofficial, MIT)
export {
  E2EEClient,
  normalizeThreadJid,
  DeviceStore,
  parseJid,
  addressKey,
} from "./e2ee/index.js";
export type {
  E2EEClientDeps,
  E2EEIncomingEvent,
  E2EETextMessageEvent,
  E2EEReactionEvent,
  E2EEEditEvent,
  E2EEUnsendEvent,
  E2EEHistoryMessage,
  PreKeyBundle,
} from "./e2ee/index.js";

// The update checker block (with the rest of the 0.2.0 surface) lives above.

// Default export: the same login() function (ESM ergonomics; the CJS build re-exports it as the callable module itself).
export { login as default } from "./login.js";
