/**
 * Public entry point.
 *
 * The root export is the stable surface described in the README: the client,
 * the typed error hierarchy, the public types and constants, and the
 * transport/session building blocks advanced integrations may need.
 */

export { MessengerClient } from "./client/index.js";

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
export { TypedEmitter } from "./events/index.js";
export { DiagnosticsCollector } from "./diagnostics/index.js";
export { SyncEndpoint } from "./sync/index.js";
