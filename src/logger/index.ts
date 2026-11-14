/**
 * Logging.
 *
 * Structured JSON on stdout by default, one child logger per module, and
 * secret redaction enabled at every level. Cookie values, tokens, and
 * credentials are censored before anything is written, so production logs
 * can be shipped to an aggregator unmodified.
 */

import { createRequire } from "node:module";
import pino from "pino";
import { LIBRARY_NAME } from "../constants.js";

/** Logger type used throughout the library. */
export type Logger = pino.Logger;

/**
 * A custom log transport. Implementations receive one complete JSON line
 * (including the trailing newline) per log record.
 */
export interface LogTransport {
  /** Write one serialized log record. */
  write(line: string): void;
}

export interface LoggerOptions {
  /** `trace` through `fatal`, or `silent`. */
  level: string;
  /** Pretty-print to stdout. Ignored unless `pino-pretty` is installed. */
  prettyPrint: boolean;
  /** File path to write logs to, appended, created if missing. */
  logFile: string | null;
  /** Additional custom transports receiving every record. */
  transports: readonly LogTransport[];
}

/**
 * pino redact paths. Applied at every level, in every module, before any
 * serializer runs.
 */
const REDACT_PATHS: readonly string[] = [
  // Whole objects that hold credentials.
  "cookies",
  "appState",
  "appstate",
  "credentials",
  "credentialInput",
  "jar",
  "*.cookies",
  "*.appState",
  "*.appstate",
  "*.credentials",
  "*.credentialInput",
  "*.jar",
  // Individual secret fields, any reasonable nesting depth.
  "fb_dtsg",
  "*.fb_dtsg",
  "fbDtsg",
  "*.fbDtsg",
  "ttstamp",
  "*.ttstamp",
  "jazoest",
  "*.jazoest",
  "token",
  "*.token",
  "syncToken",
  "*.syncToken",
  "xs",
  "*.xs",
  "datr",
  "*.datr",
  "c_user",
  "*.c_user",
  "password",
  "*.password",
  "mqttUsername",
  "*.mqttUsername",
  "cookieHeader",
  "*.cookieHeader",
];

interface MultiDestination {
  write(line: string): void;
}

/**
 * A destination that fans a log line out to several transports.
 */
class MultiDestination implements MultiDestination {
  readonly #transports: readonly LogTransport[];

  constructor(transports: readonly LogTransport[]) {
    this.#transports = transports;
  }

  write(line: string): void {
    for (const transport of this.#transports) {
      try {
        transport.write(line);
      } catch {
        // A broken custom transport must never take the library down.
      }
    }
  }
}

/**
 * Signature of `pino-pretty`'s default export, loaded dynamically. It is
 * only typed structurally here because it is an optional, user-installed
 * package.
 */
type PrettyStreamFactory = (options: {
  colorize: boolean;
  translateTime: string;
  ignore: string;
}) => { write: (line: string) => void };

/**
 * Loads pino-pretty from the application's dependencies. Returns `null`
 * when it is not installed.
 */
function loadPrettyStream(): { write: (line: string) => void } | null {
  try {
    const require = createRequire(process.cwd() + "/package.json");
    const mod: unknown = require("pino-pretty");
    if (typeof mod !== "function") {
      return null;
    }
    const factory = mod as PrettyStreamFactory;
    return factory({
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    });
  } catch {
    // Not installed — pretty printing is silently disabled.
    return null;
  }
}

/**
 * Creates the root logger. Module loggers are derived from it with
 * `logger.child({ module: "..." })`.
 */
export function createRootLogger(options: LoggerOptions): Logger {
  const destinations: { write: (line: string) => void }[] = [];

  if (options.prettyPrint) {
    const pretty = loadPrettyStream();
    if (pretty !== null) {
      destinations.push(pretty);
    }
  }

  if (options.logFile !== null) {
    destinations.push(pino.destination({ dest: options.logFile, append: true, mkdir: true }));
  }

  if (destinations.length === 0 && options.transports.length === 0) {
    destinations.push(pino.destination({ dest: 1, sync: false }));
  }

  if (options.transports.length > 0) {
    destinations.push(new MultiDestination(options.transports));
  }

  const destination: { write: (line: string) => void } =
    destinations.length === 1 ? destinations[0]! : new MultiDestination(destinations);

  return pino(
    {
      name: LIBRARY_NAME,
      level: options.level,
      redact: { paths: [...REDACT_PATHS], censor: "[REDACTED]" },
      timestamp: pino.stdTimeFunctions.isoTime,
      base: { library: LIBRARY_NAME },
    },
    destination as pino.DestinationStream,
  );
}
