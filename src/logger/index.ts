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

/** Log level type */
export type LogLevel = "silent" | "fatal" | "error" | "warn" | "info" | "success" | "debug" | "verbose" | "trace";

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
  /** Use the console logger instead of pino (default: false). */
  useConsoleLogger?: boolean;
}

// ============================================================================
// Console Logger
// ============================================================================

/** Modern color palette */
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",

  // Primary palette
  primary: "\x1b[38;5;39m",
  success: "\x1b[38;5;46m",
  warning: "\x1b[38;5;226m",
  error: "\x1b[38;5;196m",
  info: "\x1b[38;5;51m",

  // Accent colors
  purple: "\x1b[38;5;141m",
  pink: "\x1b[38;5;213m",
  orange: "\x1b[38;5;214m",
  lime: "\x1b[38;5;154m",

  // Gray scale
  gray: "\x1b[38;5;242m",
  darkGray: "\x1b[38;5;238m",
  lightGray: "\x1b[38;5;250m",

  // Backgrounds
  bgSuccess: "\x1b[48;5;46m",
  bgError: "\x1b[48;5;196m",
  bgWarning: "\x1b[48;5;226m",
  bgInfo: "\x1b[48;5;51m",
} as const;

/** Box drawing */
const box = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│",
  htl: "┏", htr: "┓", hbl: "┗", hbr: "┛", hh: "━", hv: "┃",
  dtl: "╔", dtr: "╗", dbl: "╚", dbr: "╝", dh: "═", dv: "║",
  cross: "┼", tee: "├", vl: "┤", th: "┬", bh: "┴",
} as const;

/** Icons */
const icons = {
  check: "✓", cross: "✗", arrow: "→", arrowLeft: "←", dot: "●", circle: "○",
  square: "■", star: "★", heart: "♥", info: "ℹ", warn: "⚠", error: "✖",
  success: "✔", rocket: "🚀", lock: "🔐",
} as const;

const spinners = {
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

function timestamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

/**
 * Console Logger — implements a compatible subset of `pino.Logger`.
 *
 * Notes for callers:
 * - `child({ module: "name" })` returns a new child with the module suffix —
 *   the module name is included in output (e.g. `panindigan-automate:session`).
 * - No secret redaction is applied here, ever. Use the default pino logger
 *   for production and aggregators.
 */
const LEVEL_VALUES: Record<LogLevel, number> = {
  silent: Number.POSITIVE_INFINITY,
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  success: 35,
  debug: 20,
  verbose: 15,
  trace: 10,
};

class ConsoleLogger {
  private readonly _level: LogLevel;
  private readonly name: string;
  level: string;
  levelVal: number;
  readonly levels = {
    values: LEVEL_VALUES,
    labels: {
      10: "trace",
      15: "verbose",
      20: "debug",
      30: "info",
      35: "success",
      40: "warn",
      50: "error",
      60: "fatal",
    },
  } as const;

  private can(level: LogLevel): boolean {
    return LEVEL_VALUES[level] >= LEVEL_VALUES[this._level];
  }

  constructor(name: string, level: LogLevel = "info") {
    this.name = name;
    this._level = level;
    this.level = level;
    this.levelVal = LEVEL_VALUES[level] ?? LEVEL_VALUES.info;
  }

  startupBanner(version: string): void {
    const w = 70;
    console.log(`\n${colors.primary}${box.dtl}${box.dh.repeat(w)}${box.dtr}${colors.reset}`);
    console.log(`${colors.primary}${box.dv}${colors.reset}${" ".repeat(w)}${colors.primary}${box.dv}${colors.reset}`);
    const title = "PANINDIGAN AUTOMATE", tp = Math.floor((w - title.length) / 2);
    console.log(`${colors.primary}${box.dv}${colors.reset}${" ".repeat(tp)}${colors.bold}${colors.success}${title}${colors.reset}${" ".repeat(w - tp - title.length)}${colors.primary}${box.dv}${colors.reset}`);
    const ver = `v${version}`, vp = Math.floor((w - ver.length) / 2);
    console.log(`${colors.primary}${box.dv}${colors.reset}${" ".repeat(vp)}${colors.dim}${ver}${colors.reset}${" ".repeat(w - vp - ver.length)}${colors.primary}${box.dv}${colors.reset}`);
    console.log(`${colors.primary}${box.dv}${colors.reset}${" ".repeat(w)}${colors.primary}${box.dv}${colors.reset}`);
    console.log(`${colors.primary}${box.dbl}${box.dh.repeat(w)}${box.dbr}${colors.reset}\n`);
  }

  features(items: Array<{ name: string; status: "enabled" | "disabled" | "ready" }>): void {
    this.section("FEATURES", colors.purple);
    items.forEach((i) => {
      const icon = (i.status === "enabled" || i.status === "ready")
        ? `${colors.success}${icons.check}${colors.reset}`
        : `${colors.gray}${icons.circle}${colors.reset}`;
      const sc = (i.status === "enabled" || i.status === "ready") ? colors.success : colors.gray;
      console.log(`  ${icon} ${colors.bold}${i.name.padEnd(30)}${colors.reset} ${sc}${i.status.toUpperCase()}${colors.reset}`);
    });
    console.log("");
  }

  section(title: string, color: string = colors.primary): void {
    console.log(`${color}${box.htl}${box.hh.repeat(68)}${box.htr}${colors.reset}`);
    console.log(`${color}${box.hv}${colors.reset} ${colors.bold}${title}${colors.reset}`);
    console.log(`${color}${box.hbl}${box.hh.repeat(68)}${box.hbr}${colors.reset}`);
  }

  progress(current: number, total: number, label: string): void {
    const p = total > 0 ? Math.floor((current / total) * 100) : 0;
    const f = Math.floor(p / 2), e = 50 - f;
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.info}${icons.arrow}${colors.reset} ${colors.success}${"█".repeat(f)}${colors.reset}${colors.darkGray}${"░".repeat(e)}${colors.reset} ${colors.bold}${p}%${colors.reset} ${colors.dim}${label}${colors.reset}`);
  }

  status(label: string, value: string, type: "success" | "error" | "warning" | "info" = "info"): void {
    const bc = {
      success: `${colors.bgSuccess}${colors.bold}\x1b[30m`,
      error: `${colors.bgError}${colors.bold}\x1b[30m`,
      warning: `${colors.bgWarning}${colors.bold}\x1b[30m`,
      info: `${colors.bgInfo}${colors.bold}\x1b[30m`,
    };
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.bold}${label}:${colors.reset} ${bc[type]} ${value} ${colors.reset}`);
  }

  metric(label: string, value: string | number, unit?: string): void {
    const dv = typeof value === "number" ? value.toLocaleString() : value;
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.primary}${icons.dot}${colors.reset} ${colors.dim}${label}:${colors.reset} ${colors.bold}${dv}${unit ? colors.dim + unit : ""}${colors.reset}`);
  }

  connecting(service: string, region?: string): void {
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.warning}${spinners.dots[0]}${colors.reset} ${colors.bold}Connecting to ${service}${colors.reset}${region ? colors.dim + " [" + region + "]" + colors.reset : ""}`);
  }

  connected(service: string, duration?: number): void {
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.success}${icons.check}${colors.reset} ${colors.bold}${service} connected${colors.reset}${duration ? colors.dim + " (" + formatDuration(duration) + ")" + colors.reset : ""}`);
  }

  messageIn(from: string, text: string, isGroup: boolean = false): void {
    const pfx = isGroup
      ? `${colors.purple}${icons.square}${colors.reset}`
      : `${colors.pink}${icons.heart}${colors.reset}`;
    const prv = text.length > 50 ? text.slice(0, 50) + "..." : text;
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.lime}${icons.arrowLeft}${colors.reset} ${pfx} ${colors.bold}${from}${colors.reset} ${colors.dim}${prv}${colors.reset}`);
  }

  messageOut(to: string, text: string): void {
    const prv = text.length > 50 ? text.slice(0, 50) + "..." : text;
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.primary}${icons.arrow}${colors.reset} ${colors.bold}${to}${colors.reset} ${colors.dim}${prv}${colors.reset}`);
  }

  silent(): void {}
  fatal(msg: string | Record<string, unknown>, message?: string): void {
    if (!this.can("fatal")) return;
    const txt = typeof msg === "string" ? msg : (message ?? "Fatal");
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.error}${icons.error} FATAL${colors.reset}   ${colors.bold}${txt}${colors.reset}`);
    if (typeof msg === "object") console.log(`${colors.dim}${JSON.stringify(msg, null, 2)}${colors.reset}`);
  }

  error(msg: string | Record<string, unknown>, message?: string): void {
    if (!this.can("error")) return;
    const txt = typeof msg === "string" ? msg : (message ?? "Error");
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.error}${icons.error} ERROR${colors.reset}   ${colors.bold}${txt}${colors.reset}`);
    if (typeof msg === "object") console.log(`${colors.dim}${JSON.stringify(msg, null, 2)}${colors.reset}`);
  }

  warn(msg: string | Record<string, unknown>, message?: string): void {
    if (!this.can("warn")) return;
    const txt = typeof msg === "string" ? msg : (message ?? "Warning");
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.warning}${icons.warn} WARN${colors.reset}    ${colors.bold}${txt}${colors.reset}`);
  }

  info(msg: string | Record<string, unknown>, message?: string): void {
    if (!this.can("info")) return;
    const txt = typeof msg === "string" ? msg : (message ?? "Info");
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.info}${icons.info} INFO${colors.reset}    ${txt}`);
  }

  success(msg: string | Record<string, unknown>, message?: string): void {
    if (!this.can("success")) return;
    const txt = typeof msg === "string" ? msg : (message ?? "Success");
    console.log(`${colors.gray}[${timestamp()}]${colors.reset} ${colors.success}${icons.success} SUCCESS${colors.reset} ${colors.bold}${txt}${colors.reset}`);
  }

  debug(msg: string | Record<string, unknown>, message?: string): void {
    if (!this.can("debug")) return;
    const txt = typeof msg === "string" ? msg : (message ?? "Debug");
    console.log(`${colors.darkGray}[${timestamp()}] ${icons.dot} DEBUG   ${txt}${colors.reset}`);
  }

  verbose(msg: string | Record<string, unknown>, message?: string): void {
    if (!this.can("verbose")) return;
    const txt = typeof msg === "string" ? msg : (message ?? "Verbose");
    console.log(`${colors.gray}[${timestamp()}] ${icons.arrow} VERBOSE ${txt}${colors.reset}`);
  }

  trace(msg: string | Record<string, unknown>, message?: string): void {
    if (!this.can("trace")) return;
    const txt = typeof msg === "string" ? msg : (message ?? "Trace");
    console.log(`${colors.dim}[${timestamp()}] » TRACE   ${txt}${colors.reset}`);
  }

  child(bindings?: Record<string, unknown>): ConsoleLogger {
    const module = typeof bindings?.["module"] === "string" ? bindings["module"] : undefined;
    const plugin = typeof bindings?.["plugin"] === "string" ? bindings["plugin"] : undefined;
    const suffix = module ?? plugin;
    return new ConsoleLogger(suffix ? `${this.name}:${suffix}` : this.name, this._level);
  }

  flush(): void {}
}

// ============================================================================
// Pino Logger
// ============================================================================

const REDACT_PATHS: readonly string[] = [
  "cookies", "appState", "appstate", "credentials", "credentialInput", "jar",
  "*.cookies", "*.appState", "*.appstate", "*.credentials", "*.credentialInput", "*.jar",
  "fb_dtsg", "*.fb_dtsg", "fbDtsg", "*.fbDtsg", "ttstamp", "*.ttstamp",
  "jazoest", "*.jazoest", "token", "*.token", "syncToken", "*.syncToken",
  "xs", "*.xs", "datr", "*.datr", "c_user", "*.c_user",
  "password", "*.password", "mqttUsername", "*.mqttUsername", "cookieHeader", "*.cookieHeader",
];

class MultiDestination {
  readonly #transports: readonly LogTransport[];
  constructor(transports: readonly LogTransport[]) { this.#transports = transports; }
  write(line: string): void {
    for (const t of this.#transports) {
      try { t.write(line); } catch {}
    }
  }
}

type PrettyStreamFactory = (options: { colorize: boolean; translateTime: string; ignore: string }) => { write: (line: string) => void };

function loadPrettyStream(): { write: (line: string) => void } | null {
  try {
    const require = createRequire(process.cwd() + "/package.json");
    const mod: unknown = require("pino-pretty");
    if (typeof mod !== "function") return null;
    return (mod as PrettyStreamFactory)({ colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" });
  } catch {
    return null;
  }
}

export function createRootLogger(options: LoggerOptions): Logger {
  // When the console logger is requested, `logFile` and `prettyPrint` are ignored —
  // the console logger always writes to stdout and keeps a small level gate internally.
  if (options.useConsoleLogger) {
    return new ConsoleLogger(LIBRARY_NAME, options.level as LogLevel) as unknown as Logger;
  }

  const dests: { write: (line: string) => void }[] = [];
  if (options.prettyPrint) {
    const p = loadPrettyStream();
    if (p) dests.push(p);
  }
  if (options.logFile) dests.push(pino.destination({ dest: options.logFile, append: true, mkdir: true }));
  if (dests.length === 0 && options.transports.length === 0) dests.push(pino.destination({ dest: 1, sync: false }));
  if (options.transports.length > 0) dests.push(new MultiDestination(options.transports));

  const dest = dests.length === 1 ? dests[0]! : new MultiDestination(options.transports);
  return pino({
    name: LIBRARY_NAME,
    level: options.level,
    redact: { paths: [...REDACT_PATHS], censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { library: LIBRARY_NAME },
  }, dest as pino.DestinationStream);
}
