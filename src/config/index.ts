/**
 * Configuration.
 *
 * Options come from three places, in increasing precedence: built-in
 * defaults, `PANINDIGAN_`-prefixed environment variables, and the
 * programmatic `ClientOptions` object. Everything is validated with Zod
 * before the client is constructed — bad values fail fast with a
 * `ValidationError` instead of surfacing as misbehavior later.
 */

import { z } from "zod";
import { ValidationError } from "../errors/index.js";
import { DEFAULT_STORAGE_DIRECTORY, DEFAULT_USER_AGENT } from "../constants.js";
import type { ClientOptions, PluginRegistration, StorageAdapter, LogTransport } from "../types/index.js";

/** Log levels accepted by the logger. */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;

/** Environment variable prefix. */
const ENV_PREFIX = "PANINDIGAN_";

/** Fully resolved configuration, all fields concrete. */
export interface ResolvedConfig {
  readonly logLevel: string;
  readonly prettyPrint: boolean;
  readonly logFile: string | null;
  readonly useConsoleLogger: boolean;
  readonly logTransports: readonly LogTransport[];
  readonly httpTimeout: number;
  readonly httpRetries: number;
  readonly httpMaxRedirects: number;
  readonly httpProxy: string | null;
  readonly userAgent: string;
  readonly heartbeatInterval: number;
  readonly heartbeatTimeout: number;
  readonly reconnectAttempts: number;
  readonly reconnectDelayMax: number;
  readonly mqttQueueMaxSize: number;
  readonly cacheMaxItems: number;
  readonly persistSession: boolean;
  readonly storageAdapter: "memory" | "file" | StorageAdapter;
  readonly storageDirectory: string;
  readonly validateOnLogin: boolean;
}

/** Defaults for every scalar option. */
const DEFAULTS = {
  logLevel: "info",
  // Professional colorized output is the default on EVERY host (local,
  // Render, Docker). Raw JSON is available by opting out with
  // `prettyPrint: false` for log aggregators that need machine parsing.
  prettyPrint: true,
  logFile: null,
  useConsoleLogger: false,
  httpTimeout: 30_000,
  httpRetries: 3,
  httpMaxRedirects: 5,
  httpProxy: null,
  userAgent: DEFAULT_USER_AGENT,
  heartbeatInterval: 60,
  heartbeatTimeout: 5,
  reconnectAttempts: Number.POSITIVE_INFINITY,
  reconnectDelayMax: 30_000,
  mqttQueueMaxSize: 500,
  cacheMaxItems: 5_000,
  persistSession: true,
  storageAdapter: "file" as const,
  storageDirectory: DEFAULT_STORAGE_DIRECTORY,
  validateOnLogin: true,
} as const;

/**
 * Schema for the scalar, serializable options. Non-serializable fields
 * (`logTransports`, `storageAdapter` instances, `plugins`) are validated
 * structurally instead — see `validateNonScalarOptions`.
 *
 * `httpProxy` uses `.transform()` so empty strings and whitespace-only
 * values are normalized to `null` before the proxy-URL check runs.
 * Without this, an empty `PANINDIGAN_HTTP_PROXY=""` environment variable
 * or an explicit `httpProxy: ""` in `ClientOptions` would pass the
 * `.nullish()` gate but fail the `isProxyUrl` refinement with the
 * confusing "httpProxy must be an http://…" error.
 */
const clientOptionsSchema = z
  .object({
    logLevel: z.enum(LOG_LEVELS).optional(),
    prettyPrint: z.boolean().optional(),
    logFile: z.string().min(1).nullish(),
    useConsoleLogger: z.boolean().optional(),
    httpTimeout: z.number().int().min(1_000).optional(),
    httpRetries: z.number().int().min(0).max(10).optional(),
    httpMaxRedirects: z.number().int().min(0).max(20).optional(),
    httpProxy: z
      .string()
      .nullish()
      .transform((value) => {
        if (value === undefined || value === null) return value;
        const trimmed = value.trim();
        return trimmed === "" ? null : trimmed;
      }),
    userAgent: z.string().min(16).optional(),
    heartbeatInterval: z.number().int().min(5).max(600).optional(),
    heartbeatTimeout: z.number().int().min(1).max(120).optional(),
    reconnectAttempts: z
      .union([z.number().int().min(0), z.literal(Number.POSITIVE_INFINITY)])
      .optional(),
    reconnectDelayMax: z.number().int().min(100).max(600_000).optional(),
    mqttQueueMaxSize: z.number().int().min(1).max(100_000).optional(),
    cacheMaxItems: z.number().int().min(1).max(1_000_000).optional(),
    persistSession: z.boolean().optional(),
    storageAdapter: z.enum(["memory", "file"]).optional(),
    storageDirectory: z.string().min(1).optional(),
    validateOnLogin: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.heartbeatTimeout !== undefined && value.heartbeatInterval !== undefined) {
      if (value.heartbeatTimeout >= value.heartbeatInterval) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["heartbeatTimeout"],
          message: "heartbeatTimeout must be smaller than heartbeatInterval",
        });
      }
    }
    if (value.httpProxy != null && !isProxyUrl(value.httpProxy)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["httpProxy"],
        message: 'httpProxy must be an http://, https://, or socks5:// URL',
      });
    }
  });

type ClientOptionsScalars = z.infer<typeof clientOptionsSchema>;

/** Accepts `http://`, `https://`, and `socks5://` proxy URLs. */
function isProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "socks5:";
  } catch {
    return false;
  }
}

/** Reads one string environment variable, when set and non-empty. */
function envString(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/** Reads one boolean environment variable (`true`/`false`). */
function envBoolean(name: string): boolean | undefined {
  const value = envString(name);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "true" && value !== "false") {
    throw new ValidationError(`${name} must be "true" or "false", got "${value}"`, {
      context: { variable: name, value },
    });
  }
  return value === "true";
}

/** Reads one integer environment variable. */
function envNumber(name: string): number | undefined {
  const value = envString(name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ValidationError(`${name} must be an integer, got "${value}"`, {
      context: { variable: name, value },
    });
  }
  return parsed;
}

/** Reads all `PANINDIGAN_` environment variables as an options object. */
function readEnvironment(): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const maybe = (key: string, value: unknown): void => {
    if (value !== undefined) {
      overrides[key] = value;
    }
  };
  maybe("logLevel", envString(`${ENV_PREFIX}LOG_LEVEL`));
  maybe("prettyPrint", envBoolean(`${ENV_PREFIX}PRETTY_PRINT`));
  maybe("logFile", envString(`${ENV_PREFIX}LOG_FILE`));
  maybe("useConsoleLogger", envBoolean(`${ENV_PREFIX}USE_CONSOLE_LOGGER`));
  maybe("httpTimeout", envNumber(`${ENV_PREFIX}HTTP_TIMEOUT`));
  maybe("httpRetries", envNumber(`${ENV_PREFIX}HTTP_RETRIES`));
  maybe("httpMaxRedirects", envNumber(`${ENV_PREFIX}HTTP_MAX_REDIRECTS`));
  maybe("httpProxy", envString(`${ENV_PREFIX}HTTP_PROXY`));
  maybe("userAgent", envString(`${ENV_PREFIX}USER_AGENT`));
  maybe("heartbeatInterval", envNumber(`${ENV_PREFIX}HEARTBEAT_INTERVAL`));
  maybe("heartbeatTimeout", envNumber(`${ENV_PREFIX}HEARTBEAT_TIMEOUT`));
  maybe("reconnectAttempts", envNumber(`${ENV_PREFIX}RECONNECT_ATTEMPTS`));
  maybe("reconnectDelayMax", envNumber(`${ENV_PREFIX}RECONNECT_DELAY_MAX`));
  maybe("mqttQueueMaxSize", envNumber(`${ENV_PREFIX}MQTT_QUEUE_MAX_SIZE`));
  maybe("cacheMaxItems", envNumber(`${ENV_PREFIX}CACHE_MAX_ITEMS`));
  maybe("persistSession", envBoolean(`${ENV_PREFIX}PERSIST_SESSION`));
  maybe("storageAdapter", envString(`${ENV_PREFIX}STORAGE_ADAPTER`));
  maybe("storageDirectory", envString(`${ENV_PREFIX}STORAGE_DIRECTORY`));
  maybe("validateOnLogin", envBoolean(`${ENV_PREFIX}VALIDATE_ON_LOGIN`));
  return overrides;
}

/** Structural validation for a custom storage adapter. */
function assertStorageAdapter(adapter: unknown): asserts adapter is StorageAdapter {
  if (typeof adapter !== "object" || adapter === null) {
    throw new ValidationError("storageAdapter must be \"memory\", \"file\", or a StorageAdapter object");
  }
  const candidate = adapter as Record<string, unknown>;
  for (const method of ["get", "set", "delete", "keys", "clear"] as const) {
    if (typeof candidate[method] !== "function") {
      throw new ValidationError(`storageAdapter is missing the "${method}()" method`, {
        context: { method },
      });
    }
  }
}

/** Structural validation for a custom log transport. */
function assertLogTransports(transports: readonly unknown[]): asserts transports is readonly LogTransport[] {
  for (const [index, transport] of transports.entries()) {
    if (typeof transport !== "object" || transport === null || typeof (transport as Record<string, unknown>)["write"] !== "function") {
      throw new ValidationError(`logTransports[${index}] must implement write(line: string)`, {
        context: { index },
      });
    }
  }
}

/** Structural validation for plugin registrations. */
function assertPlugins(plugins: readonly unknown[]): asserts plugins is readonly PluginRegistration[] {
  for (const [index, entry] of plugins.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw new ValidationError(`plugins[${index}] must be a PluginRegistration object`, {
        context: { index },
      });
    }
    const candidate = entry as Record<string, unknown>;
    const plugin = candidate["plugin"];
    if (typeof plugin !== "object" || plugin === null) {
      throw new ValidationError(`plugins[${index}].plugin must be a Plugin object`, {
        context: { index },
      });
    }
    const pluginRecord = plugin as Record<string, unknown>;
    if (typeof pluginRecord["name"] !== "string" || pluginRecord["name"] === "") {
      throw new ValidationError(`plugins[${index}].plugin.name must be a non-empty string`, {
        context: { index },
      });
    }
    if (typeof pluginRecord["version"] !== "string" || pluginRecord["version"] === "") {
      throw new ValidationError(`plugins[${index}].plugin.version must be a non-empty string`, {
        context: { index },
      });
    }
    for (const hook of ["onLoad", "onEnable", "onDisable", "onReload", "onDestroy"] as const) {
      if (pluginRecord[hook] !== undefined && typeof pluginRecord[hook] !== "function") {
        throw new ValidationError(`plugins[${index}].plugin.${hook} must be a function when present`, {
          context: { index, hook },
        });
      }
    }
    const options = candidate["options"];
    if (options !== undefined) {
      if (typeof options !== "object" || options === null) {
        throw new ValidationError(`plugins[${index}].options must be an object`, { context: { index } });
      }
      const enabled = (options as Record<string, unknown>)["enabled"];
      if (enabled !== undefined && typeof enabled !== "boolean") {
        throw new ValidationError(`plugins[${index}].options.enabled must be a boolean`, {
          context: { index },
        });
      }
    }
  }
}

/** Splits options into scalar fields (zod) and structural fields (manual). */
function splitOptions(options: ClientOptions): {
  scalar: Record<string, unknown>;
  logTransports: readonly LogTransport[];
  storageAdapter: "memory" | "file" | StorageAdapter | undefined;
  plugins: readonly PluginRegistration[];
} {
  const scalar: Record<string, unknown> = {};
  const {
    logTransports,
    storageAdapter,
    plugins,
    // Structured options consumed elsewhere (constructor/guard/E2EE/update).
    // They are not scalar config values; keeping them out of the zod scalar
    // schema so .strict() still catches typos in the keys it does own.
    stealth: _stealth,
    dryRun: _dryRun,
    e2ee: _e2ee,
    update: _update,
    ...rest
  } = options;
  void _stealth;
  void _dryRun;
  void _e2ee;
  void _update;

  const restRecord = rest as Record<string, unknown>;
  if (restRecord["logFile"] === "") {
    throw new ValidationError("logFile must not be an empty string");
  }

  const restClone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(restRecord)) {
    if (value !== undefined) {
      restClone[key] = value;
    }
  }
  Object.assign(scalar, restClone);

  const validatedTransports = logTransports ?? [];
  assertLogTransports(validatedTransports);

  let adapter: "memory" | "file" | StorageAdapter | undefined;
  if (typeof storageAdapter === "string") {
    adapter = storageAdapter;
  } else if (storageAdapter !== undefined) {
    assertStorageAdapter(storageAdapter);
    adapter = storageAdapter;
  }

  const validatedPlugins = plugins ?? [];
  assertPlugins(validatedPlugins);

  return { scalar, logTransports: validatedTransports, storageAdapter: adapter, plugins: validatedPlugins };
}

/**
 * Validates options and merges them over environment variables and
 * defaults, producing the fully resolved configuration.
 */
export function resolveConfig(options: ClientOptions = {}): ResolvedConfig {
  const { scalar, logTransports, storageAdapter, plugins: _plugins } = splitOptions(options);
  void _plugins; // Plugins are consumed by the plugin manager, not the config.

  const merged: Record<string, unknown> = {};
  Object.assign(merged, DEFAULTS);
  Object.assign(merged, readEnvironment());
  Object.assign(merged, scalar);

  // Custom adapter instances cannot pass the zod enum; keep them aside and
  // re-apply after the scalar validation.
  let customAdapter: StorageAdapter | undefined;
  if (storageAdapter !== undefined && typeof storageAdapter !== "string") {
    customAdapter = storageAdapter;
    delete merged["storageAdapter"];
  } else if (storageAdapter !== undefined) {
    merged["storageAdapter"] = storageAdapter;
  }

  const parseResult = clientOptionsSchema.safeParse(merged);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    const path = issue !== undefined ? issue.path.join(".") : "";
    throw new ValidationError(
      `Invalid option${path !== "" ? ` "${path}"` : ""}: ${issue?.message ?? "validation failed"}`,
      {
        context: {
          path,
          issues: parseResult.error.issues.map((entry) => ({
            path: entry.path.join("."),
            message: entry.message,
          })),
        },
      },
    );
  }

  const validated = parseResult.data as ClientOptionsScalars & Record<string, unknown>;

  return {
    logLevel: validated.logLevel ?? DEFAULTS.logLevel,
    prettyPrint: validated.prettyPrint ?? DEFAULTS.prettyPrint,
    logFile: (validated.logFile as string | null | undefined) ?? null,
    useConsoleLogger: validated.useConsoleLogger ?? DEFAULTS.useConsoleLogger,
    logTransports,
    httpTimeout: validated.httpTimeout ?? DEFAULTS.httpTimeout,
    httpRetries: validated.httpRetries ?? DEFAULTS.httpRetries,
    httpMaxRedirects: validated.httpMaxRedirects ?? DEFAULTS.httpMaxRedirects,
    httpProxy: validated.httpProxy ?? null,
    userAgent: validated.userAgent ?? DEFAULTS.userAgent,
    heartbeatInterval: validated.heartbeatInterval ?? DEFAULTS.heartbeatInterval,
    heartbeatTimeout: validated.heartbeatTimeout ?? DEFAULTS.heartbeatTimeout,
    reconnectAttempts: validated.reconnectAttempts ?? DEFAULTS.reconnectAttempts,
    reconnectDelayMax: validated.reconnectDelayMax ?? DEFAULTS.reconnectDelayMax,
    mqttQueueMaxSize: validated.mqttQueueMaxSize ?? DEFAULTS.mqttQueueMaxSize,
    cacheMaxItems: validated.cacheMaxItems ?? DEFAULTS.cacheMaxItems,
    persistSession: validated.persistSession ?? DEFAULTS.persistSession,
    storageAdapter: customAdapter ?? (validated.storageAdapter as "memory" | "file" | undefined) ?? DEFAULTS.storageAdapter,
    storageDirectory: validated.storageDirectory ?? DEFAULTS.storageDirectory,
    validateOnLogin: validated.validateOnLogin ?? DEFAULTS.validateOnLogin,
  };
}
