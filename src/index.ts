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
export { FileStorage, MemoryStorage, NamespacedStorage } from "./storage/index.js";
export { SessionManager } from "./session/index.js";
export { HttpTransport } from "./transport/http/index.js";
export { MqttTransport } from "./transport/mqtt/index.js";
export { DeltaProcessor } from "./delta/index.js";
export { MiddlewareManager } from "./middleware/index.js";
export { PluginManager } from "./plugins/index.js";
export { TypedEmitter } from "./events/index.js";
export { DiagnosticsCollector } from "./diagnostics/index.js";
export { SyncEndpoint } from "./sync/index.js";
