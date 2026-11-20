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
  message: "\x1b[38;5;189m", // soft lavender — log message text
  link: "\x1b[38;5;45m", // cyan — URLs in panels

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

/** JSON.stringify that never throws on circular or exotic context values. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (item !== null && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A framed status block attached to a log record through the `panel` field.
 * JSON transports still receive the ordinary record; only the colorized
 * destination renders it as a box.
 */
export interface LogPanel {
  readonly title: string;
  readonly tone?: "success" | "info" | "warning" | "danger";
  readonly rows: ReadonlyArray<readonly [string, string | number | boolean | null]>;
  readonly footer?: string;
}

/** Semantic coloring so values read at a glance (green = good, yellow = number). */
function colorValue(value: unknown): string {
  if (typeof value === "boolean") return value ? colors.success : colors.error;
  if (typeof value === "number") return colors.warning;
  const text = String(value ?? "—");
  if (/^(true|enabled|connected|ready|active|ok|yes|closed)$/i.test(text)) return colors.success;
  if (/^(false|disabled|halted|down|no)$/i.test(text)) return colors.error;
  if (/^(https?:\/\/|github\.com\/)/i.test(text)) return colors.link;
  return colors.pink;
}

const LEVEL_STYLE: Record<number, { icon: string; iconColor: string; label: string; labelColor: string }> = {
  60: { icon: "✖", iconColor: colors.error, label: "FATAL", labelColor: colors.error },
  50: { icon: "✖", iconColor: colors.error, label: "ERROR", labelColor: colors.error },
  40: { icon: "⚠", iconColor: colors.warning, label: "WARN", labelColor: colors.warning },
  35: { icon: "✓", iconColor: colors.success, label: "OK", labelColor: colors.success },
  30: { icon: "ℹ", iconColor: colors.info, label: "INFO", labelColor: colors.info },
  20: { icon: "●", iconColor: colors.purple, label: "DEBUG", labelColor: colors.gray },
  10: { icon: "›", iconColor: colors.darkGray, label: "TRACE", labelColor: colors.darkGray },
};

/**
 * Built-in colorized destination for pino's JSON lines.
 *
 * This is the DEFAULT stdout destination on every host — no external
 * dependency, no TTY requirement, no pino-pretty needed. pino still applies
 * redaction BEFORE handing us the line, so secrets never reach the formatter.
 * Set `prettyPrint: false` for machine-parsed JSON (log aggregators).
 */
export class ColorizedDestination {
  write(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      process.stdout.write(line);
      return;
    }

    const level = typeof record["level"] === "number" ? record["level"] : 30;
    const style = LEVEL_STYLE[level] ?? { icon: "•", iconColor: colors.info, label: "LOG", labelColor: colors.info };

    // pino's isoTime emits a STRING; numeric timestamps are also accepted.
    const rawTime = record["time"];
    const time = typeof rawTime === "number"
      ? new Date(rawTime).toISOString().slice(11, 23)
      : typeof rawTime === "string"
        ? (rawTime.includes("T") ? rawTime.slice(11, 23) : rawTime.slice(0, 12))
        : "";

    const panel = record["panel"];
    if (panel !== null && typeof panel === "object" && typeof (panel as LogPanel).title === "string") {
      process.stdout.write(this.#renderPanel(panel as LogPanel));
      return;
    }

    const module = typeof record["module"] === "string" ? record["module"] : undefined;
    const msg = typeof record["msg"] === "string" ? record["msg"] : "";
    const reserved = new Set([
      "level", "time", "msg", "name", "library", "pid", "hostname", "module", "panel",
    ]);
    const context = Object.entries(record).filter(([key]) => !reserved.has(key));

    const parts = [
      `${colors.darkGray}${time}${colors.reset}`,
      `${style.iconColor}${style.icon}${colors.reset} ${colors.bold}${style.labelColor}${style.label}${colors.reset}`,
      module ? `${colors.purple}[${module}]${colors.reset}` : "",
      msg === "" ? "" : `${colors.message}${msg}${colors.reset}`,
    ].filter((part): part is string => part !== "");

    let out = parts.join("  ");
    if (context.length > 0) {
      const details = context
        .map(([key, value]) => {
          if (key === "err" && value !== null && typeof value === "object") {
            const err = value as Record<string, unknown>;
            const text = typeof err["message"] === "string" ? err["message"] : String(value);
            const code = typeof err["code"] === "string" ? ` (${err["code"]})` : "";
            return `${colors.dim}err${colors.reset}=${colors.error}${text}${code}${colors.reset}`;
          }
          const text = typeof value === "string" ? value : safeStringify(value);
          const short = text.length > 200 ? `${text.slice(0, 197)}...` : text;
          return `${colors.dim}${key}${colors.reset}=${colorValue(value)}${short}${colors.reset}`;
        })
        .join(`${colors.darkGray} · ${colors.reset}`);
      out += `  ${colors.darkGray}${details}${colors.reset}`;
    }
    process.stdout.write(`${out}\n`);
  }

  /** Renders a framed panel with a cyan border and semantically colored values. */
  #renderPanel(panel: LogPanel): string {
    const tones = {
      success: { icon: "✓", color: colors.success },
      info: { icon: "ℹ", color: colors.info },
      warning: { icon: "⚠", color: colors.warning },
      danger: { icon: "✖", color: colors.error },
    } as const;
    const tone = tones[panel.tone ?? "info"];
    const rows = Array.isArray(panel.rows) ? panel.rows : [];
    const labelWidth = Math.max(12, ...rows.map(([label]) => String(label).length));
    const width = 58;

    const edge = (left: string, fill: string, right: string): string =>
      `${colors.link}${left}${fill.repeat(width - 2)}${right}${colors.reset}\n`;
    const bordered = (content: string): string =>
      `${colors.link}║${colors.reset}${content}${" ".repeat(Math.max(0, width - 2 - visibleLength(content)))}${colors.link}║${colors.reset}\n`;

    let out = edge("╔", "═", "╗");
    const heading = `  ${tone.icon} ${panel.title}`;
    out += bordered(`${tone.color}${colors.bold}${heading}${colors.reset}`);
    out += edge("╠", "═", "╣");
    for (const [label, value] of rows) {
      const key = String(label);
      const text = value === null ? "—" : String(value);
      out += bordered(
        `  ${colors.lightGray}${key.padEnd(labelWidth)}${colors.reset}  ${colorValue(value)}${text}${colors.reset}`,
      );
    }
    if (typeof panel.footer === "string" && panel.footer !== "") {
      out += edge("╠", "═", "╣");
      out += bordered(`  ${colors.link}${panel.footer}${colors.reset}`);
    }
    out += edge("╚", "═", "╝");
    return out;
  }
}

/** Visible length of a string containing ANSI escape codes. */
function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function loadPrettyStream(): { write: (line: string) => void } | null {
  // pino-pretty, when installed, is the canonical formatter for local use.
  try {
    const require = createRequire(process.cwd() + "/package.json");
    const mod: unknown = require("pino-pretty");
    if (typeof mod !== "function") return null;
    return (mod as PrettyStreamFactory)({ colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" });
  } catch {
    // Fall back to the built-in colorizer below — never a silent no-op.
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
    // Local development: always colorized. Prefer pino-pretty if present,
    // otherwise the built-in colorizer — either way it is never a no-op.
    dests.push(loadPrettyStream() ?? new ColorizedDestination());
  }
  if (options.logFile) dests.push(pino.destination({ dest: options.logFile, append: true, mkdir: true }));
  if (dests.length === 0 && options.transports.length === 0) dests.push(pino.destination({ dest: 1, sync: false }));
  if (options.transports.length > 0) dests.push(new MultiDestination(options.transports));

  // FIX: fan out to ALL destinations, not just the custom transports.
  // Previously `new MultiDestination(options.transports)` dropped the
  // pretty/file destinations whenever more than one was configured.
  const dest = dests.length === 1 ? dests[0]! : new MultiDestination(dests);
  return pino({
    name: LIBRARY_NAME,
    level: options.level,
    redact: { paths: [...REDACT_PATHS], censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { library: LIBRARY_NAME },
  }, dest as pino.DestinationStream);
}
