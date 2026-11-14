/**
 * Plugin lifecycle and sandboxing.
 *
 * A plugin gets: a child logger, a namespaced cache, a namespaced storage
 * scope, event listeners that are removed automatically when it is
 * disabled, and middleware scoped to its name. It never sees the cookie
 * jar, the transports, or another plugin's state.
 */

import { PluginError } from "../errors/index.js";
import type { Logger } from "../logger/index.js";
import type { TypedEmitter } from "../events/index.js";
import { NamespacedCache } from "../cache/index.js";
import { NamespacedStorage } from "../storage/index.js";
import type { MiddlewareManager } from "../middleware/index.js";
import type {
  EventListener,
  EventName,
  MiddlewareHook,
  MiddlewarePhase,
  MiddlewareRegistrationOptions,
  Plugin,
  PluginContext,
  PluginRegistration,
} from "../types/index.js";

/** Lifecycle state of a registered plugin. */
export type PluginState = "registered" | "enabled" | "disabled" | "destroyed";

interface ListenerRegistration {
  readonly event: EventName;
  readonly listener: EventListener<EventName>;
}

interface MiddlewareRecord {
  readonly phase: MiddlewarePhase;
  readonly hook: MiddlewareHook;
  readonly options: MiddlewareRegistrationOptions;
}

/** Dependencies the manager needs from its host client. */
export interface PluginManagerDeps {
  readonly logger: Logger;
  readonly emitter: TypedEmitter;
  readonly middleware: MiddlewareManager;
  readonly cache: NamespacedCache;
  readonly storage: NamespacedStorage;
}

/** Read-only view of a registered plugin. */
export interface PluginView {
  readonly name: string;
  readonly version: string;
  readonly state: PluginState;
}

/**
 * Owns plugin lifecycle: load, enable, disable, reload, destroy.
 */
export class PluginManager {
  readonly #logger: Logger;
  readonly #emitter: TypedEmitter;
  readonly #middleware: MiddlewareManager;
  readonly #cacheFactory: (name: string) => NamespacedCache;
  readonly #storageFactory: (name: string) => NamespacedStorage;
  readonly #records = new Map<string, PluginRecord>();

  constructor(deps: {
    readonly logger: Logger;
    readonly emitter: TypedEmitter;
    readonly middleware: MiddlewareManager;
    readonly cacheFactory: (name: string) => NamespacedCache;
    readonly storageFactory: (name: string) => NamespacedStorage;
  }) {
    this.#logger = deps.logger;
    this.#emitter = deps.emitter;
    this.#middleware = deps.middleware;
    this.#cacheFactory = deps.cacheFactory;
    this.#storageFactory = deps.storageFactory;
  }

  /** Registers a plugin and runs `onLoad`. Enabled unless opted out. */
  async register(registration: PluginRegistration): Promise<void> {
    const { plugin } = registration;
    if (this.#records.has(plugin.name)) {
      throw new PluginError(`Plugin "${plugin.name}" is already registered`, "PLUGIN_LOAD_FAILED", {
        context: { plugin: plugin.name },
      });
    }
    const record: PluginRecord = {
      plugin,
      state: "registered",
      loaded: false,
      context: null,
      listeners: [],
      middleware: [],
    };
    this.#records.set(plugin.name, record);

    try {
      await this.#load(record);
    } catch (error) {
      this.#records.delete(plugin.name);
      throw this.#wrapLoad(plugin.name, error);
    }

    if (registration.options?.enabled !== false) {
      await this.enable(plugin.name);
    }
  }

  /** Enables a registered or disabled plugin. */
  async enable(name: string): Promise<void> {
    const record = this.#require(name);
    if (record.state === "enabled") {
      return;
    }
    if (record.state === "destroyed") {
      throw new PluginError(`Plugin "${name}" is destroyed and cannot be re-enabled`, "PLUGIN_LIFECYCLE_FAILED", {
        context: { plugin: name },
      });
    }
    if (!record.loaded) {
      await this.#load(record);
    }
    this.#attach(record);
    record.state = "enabled";
    try {
      await record.plugin.onEnable?.();
    } catch (error) {
      throw this.#wrapLifecycle(name, "onEnable", error);
    }
    this.#logger.info({ plugin: name }, "plugin enabled");
  }

  /** Disables a plugin, detaching its listeners and middleware. */
  async disable(name: string): Promise<void> {
    const record = this.#require(name);
    if (record.state !== "enabled") {
      return;
    }
    this.#detach(record);
    record.state = "disabled";
    try {
      await record.plugin.onDisable?.();
    } catch (error) {
      throw this.#wrapLifecycle(name, "onDisable", error);
    }
    this.#logger.info({ plugin: name }, "plugin disabled");
  }

  /** Reloads a plugin: disable, `onLoad` again, enable, then `onReload`. */
  async reload(name: string): Promise<void> {
    const record = this.#require(name);
    if (record.state === "destroyed") {
      throw new PluginError(`Plugin "${name}" is destroyed and cannot be reloaded`, "PLUGIN_LIFECYCLE_FAILED", {
        context: { plugin: name },
      });
    }
    await this.disable(name);
    try {
      await this.#load(record);
    } catch (error) {
      throw this.#wrapLoad(name, error);
    }
    await this.enable(name);
    try {
      await record.plugin.onReload?.();
    } catch (error) {
      throw this.#wrapLifecycle(name, "onReload", error);
    }
  }

  /** Destroys a plugin permanently. */
  async destroy(name: string): Promise<void> {
    const record = this.#require(name);
    if (record.state === "enabled") {
      await this.disable(name);
    }
    record.state = "destroyed";
    try {
      await record.plugin.onDestroy?.();
    } catch (error) {
      throw this.#wrapLifecycle(name, "onDestroy", error);
    }
    if (record.context !== null) {
      await record.context.cache.clear();
    }
    this.#records.delete(name);
    this.#logger.info({ plugin: name }, "plugin destroyed");
  }

  /** Destroys every registered plugin, for client shutdown. */
  async destroyAll(): Promise<void> {
    for (const name of [...this.#records.keys()]) {
      await this.destroy(name);
    }
  }

  /** Snapshot of registered plugins. */
  list(): readonly PluginView[] {
    return [...this.#records.values()].map((record) => ({
      name: record.plugin.name,
      version: record.plugin.version,
      state: record.state,
    }));
  }

  async #load(record: PluginRecord): Promise<void> {
    const name = record.plugin.name;
    const context: PluginContext = {
      name,
      logger: this.#logger.child({ plugin: name }),
      cache: this.#cacheFactory(name),
      storage: this.#storageFactory(name),
      on: <E extends EventName>(event: E, listener: EventListener<E>) =>
        this.#addListener(record, event, listener),
      use: (phase: MiddlewarePhase, hook: MiddlewareHook, options?: MiddlewareRegistrationOptions) =>
        this.#addMiddleware(record, phase, hook, options),
    };
    record.context = context;
    record.listeners = [];
    record.middleware = [];
    await record.plugin.onLoad?.(context);
    record.loaded = true;
    if (record.state !== "enabled") {
      // Listeners registered during a load that did not end in enable
      // are held until the plugin is enabled.
      this.#detach(record);
    }
  }

  #addListener<E extends EventName>(
    record: PluginRecord,
    event: E,
    listener: EventListener<E>,
  ): () => void {
    const entry: ListenerRegistration = {
      event,
      listener: listener as EventListener<EventName>,
    };
    record.listeners.push(entry);
    if (record.state === "enabled") {
      return this.#emitter.on(event, listener);
    }
    return () => {
      const index = record.listeners.indexOf(entry);
      if (index !== -1) {
        record.listeners.splice(index, 1);
      }
    };
  }

  #addMiddleware(
    record: PluginRecord,
    phase: MiddlewarePhase,
    hook: MiddlewareHook,
    options: MiddlewareRegistrationOptions | undefined,
  ): void {
    const registrationOptions: MiddlewareRegistrationOptions =
      options === undefined ? {} : { operations: options.operations, name: options.name };
    const entry: MiddlewareRecord = { phase, hook, options: registrationOptions };
    record.middleware.push(entry);
    if (record.state === "enabled") {
      this.#middleware.register(
        phase,
        hook,
        registrationOptions,
        "plugin",
        `plugin:${record.plugin.name}`,
      );
    }
  }

  #attach(record: PluginRecord): void {
    for (const entry of record.listeners) {
      this.#emitter.on(entry.event, entry.listener);
    }
    for (const entry of record.middleware) {
      this.#middleware.register(entry.phase, entry.hook, entry.options, "plugin", `plugin:${record.plugin.name}`);
    }
  }

  #detach(record: PluginRecord): void {
    for (const entry of record.listeners) {
      this.#emitter.off(entry.event, entry.listener);
    }
    this.#middleware.unregisterOwner(`plugin:${record.plugin.name}`);
  }

  #require(name: string): PluginRecord {
    const record = this.#records.get(name);
    if (record === undefined) {
      throw new PluginError(`Plugin "${name}" is not registered`, "PLUGIN_LIFECYCLE_FAILED", {
        context: { plugin: name },
      });
    }
    return record;
  }

  #wrapLoad(name: string, error: unknown): PluginError {
    if (error instanceof PluginError) {
      return error;
    }
    return new PluginError(`Plugin "${name}" failed to load: ${describe(error)}`, "PLUGIN_LOAD_FAILED", {
      cause: error,
      context: { plugin: name },
    });
  }

  #wrapLifecycle(name: string, hook: string, error: unknown): PluginError {
    if (error instanceof PluginError) {
      return error;
    }
    return new PluginError(
      `Plugin "${name}" failed in ${hook}: ${describe(error)}`,
      "PLUGIN_LIFECYCLE_FAILED",
      { cause: error, context: { plugin: name, hook } },
    );
  }
}

interface PluginRecord {
  readonly plugin: Plugin;
  state: PluginState;
  loaded: boolean;
  context: PluginContext | null;
  listeners: ListenerRegistration[];
  middleware: MiddlewareRecord[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
