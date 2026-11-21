/**
 * Authentication.
 *
 * Parses credentials in the six supported input formats, normalizes them
 * into an RFC 6265-compliant cookie jar, validates the three required
 * session cookies (`c_user`, `xs`, `datr`) before any network request is
 * made, and serializes the jar back for persistence.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Cookie, CookieJar } from "tough-cookie";
import type { SerializedCookieJar } from "tough-cookie";
import { z } from "zod";
import { CookieError } from "../errors/index.js";
import type { Logger } from "../logger/index.js";
import {
  FB_COOKIE_DOMAIN,
  REQUIRED_COOKIES,
} from "../constants.js";
import type {
  AppStateCookie,
  Credentials,
} from "../types/index.js";

/** URL used when (re)storing a cookie, derived from its domain. */
const FACEBOOK_URL = "https://www.facebook.com";
const MESSENGER_URL = "https://www.messenger.com";

/** A cookie normalized from any input format. */
export interface NormalizedCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  /** Epoch ms of expiry, or `null` for a session cookie. */
  readonly expiresAtMs: number | null;
  readonly hostOnly: boolean;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "strict" | "lax" | "none" | undefined;
}

const appStateEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1).optional(),
  path: z.string().optional(),
  expires: z.string().optional(),
  expirationDate: z.number().optional(),
  hostOnly: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.string().optional(),
});

const cookieEntrySchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1).optional(),
  path: z.string().optional(),
  expires: z.union([z.string(), z.number()]).optional(),
  /** Mobile exports commonly use Puppeteer-style seconds since epoch. */
  expirationDate: z.number().optional(),
  hostOnly: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.string().optional(),
});

/**
 * Some export tools emit httpOnly/hostOnly as strings.
 */
const booleanish = z.union([z.boolean(), z.enum(["true", "false"])]).transform((v) =>
  typeof v === "boolean" ? v : v === "true",
);

const appStateObjectEntrySchema = z.object({
  value: z.string(),
  domain: z.string().min(1).optional(),
  path: z.string().optional(),
  expires: z.string().optional(),
  expirationDate: z.number().optional(),
  hostOnly: booleanish.optional(),
  httpOnly: booleanish.optional(),
  secure: z.boolean().optional(),
  sameSite: z.string().optional(),
});

const appStateObjectSchema = z.record(
  z.string().min(1),
  z.union([z.string(), appStateObjectEntrySchema]),
);

/** Normalizes a `sameSite` string to the RFC value tough-cookie expects. */
function normalizeSameSite(value: string | undefined): "strict" | "lax" | "none" | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "strict":
      return "strict";
    case "lax":
      return "lax";
    case "none":
    case "no_restriction":
    case "no_restriction_unspecified":
    case "unspecified":
      return "none";
    default:
      return undefined;
  }
}

/** Parses an expiry into epoch ms, or `null` for session cookies. */
function normalizeExpiry(
  expires: string | undefined,
  expirationDate: number | undefined,
): number | null {
  if (expirationDate !== undefined) {
    // Puppeteer-style expirationDate is in seconds; unusually large values
    // are already milliseconds.
    return expirationDate < 1e12 ? expirationDate * 1000 : expirationDate;
  }
  if (expires === undefined) {
    return null;
  }
  const trimmed = expires.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "infinity") {
    return null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Builds a normalized cookie from an AppState-style entry. */
function fromAppStateEntry(entry: z.infer<typeof appStateEntrySchema>): NormalizedCookie {
  return {
    name: entry.key,
    value: entry.value,
    domain: entry.domain ?? FB_COOKIE_DOMAIN,
    path: entry.path ?? "/",
    expiresAtMs: normalizeExpiry(entry.expires, entry.expirationDate),
    hostOnly: entry.hostOnly ?? false,
    httpOnly: entry.httpOnly ?? false,
    secure: entry.secure ?? true,
    sameSite: normalizeSameSite(entry.sameSite),
  };
}

/** Builds a normalized cookie from a cookie-array entry. */
function fromCookieEntry(entry: z.infer<typeof cookieEntrySchema>): NormalizedCookie {
  let expiresAtMs: number | null = null;
  if (entry.expirationDate !== undefined) {
    expiresAtMs = entry.expirationDate < 1e12 ? entry.expirationDate * 1000 : entry.expirationDate;
  } else if (typeof entry.expires === "number") {
    expiresAtMs = entry.expires < 1e12 ? entry.expires * 1000 : entry.expires;
  } else if (entry.expires !== undefined) {
    expiresAtMs = normalizeExpiry(entry.expires, undefined);
  }
  return {
    name: entry.name,
    value: entry.value,
    domain: entry.domain ?? FB_COOKIE_DOMAIN,
    path: entry.path ?? "/",
    expiresAtMs,
    hostOnly: false,
    httpOnly: entry.httpOnly ?? false,
    secure: entry.secure ?? true,
    sameSite: normalizeSameSite(entry.sameSite),
  };
}

/** Parses a raw cookie header string, e.g. `"c_user=…; xs=…"`. */
function parseCookieHeaderString(header: string): readonly NormalizedCookie[] {
  const cookies: NormalizedCookie[] = [];
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    if (trimmed === "") {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      throw new CookieError(
        `Malformed cookie header segment "${segment.trim()}" — expected "name=value" pairs`,
        "COOKIE_MALFORMED",
        { context: { segment: segment.trim().slice(0, 16) } },
      );
    }
    cookies.push({
      name: trimmed.slice(0, separator).trim(),
      value: trimmed.slice(separator + 1).trim(),
      domain: FB_COOKIE_DOMAIN,
      path: "/",
      expiresAtMs: null,
      hostOnly: false,
      httpOnly: false,
      secure: true,
      sameSite: undefined,
    });
  }
  if (cookies.length === 0) {
    throw new CookieError("Cookie header string contained no cookies", "COOKIE_MALFORMED");
  }
  return cookies;
}

/** Parses parsed-JSON content that may be any of the structured formats. */
function parseStructured(value: unknown, sourceDescription: string): readonly NormalizedCookie[] {
  if (Array.isArray(value)) {
    const cookies: NormalizedCookie[] = [];
    for (const [index, entry] of value.entries()) {
      const asAppState = appStateEntrySchema.safeParse(entry);
      if (asAppState.success) {
        cookies.push(fromAppStateEntry(asAppState.data));
        continue;
      }
      const asEntry = cookieEntrySchema.safeParse(entry);
      if (asEntry.success) {
        cookies.push(fromCookieEntry(asEntry.data));
        continue;
      }
      throw new CookieError(
        `Entry ${index} of ${sourceDescription} is neither an AppState cookie (needs "key" and "value") nor a cookie entry (needs "name" and "value")`,
        "COOKIE_MALFORMED",
        { context: { index, source: sourceDescription } },
      );
    }
    if (cookies.length === 0) {
      throw new CookieError(`${sourceDescription} contained no cookies`, "COOKIE_MALFORMED");
    }
    return cookies;
  }

  if (typeof value === "object" && value !== null) {
    const parsed = appStateObjectSchema.safeParse(value);
    if (parsed.success) {
      const cookies: NormalizedCookie[] = [];
      for (const [name, rawEntry] of Object.entries(parsed.data)) {
        if (typeof rawEntry === "string") {
          cookies.push({
            name,
            value: rawEntry,
            domain: FB_COOKIE_DOMAIN,
            path: "/",
            expiresAtMs: null,
            hostOnly: false,
            httpOnly: false,
            secure: true,
            sameSite: undefined,
          });
          continue;
        }
        cookies.push({
          name,
          value: rawEntry.value,
          domain: rawEntry.domain ?? FB_COOKIE_DOMAIN,
          path: rawEntry.path ?? "/",
          expiresAtMs: normalizeExpiry(rawEntry.expires, rawEntry.expirationDate),
          hostOnly: rawEntry.hostOnly ?? false,
          httpOnly: rawEntry.httpOnly ?? false,
          secure: rawEntry.secure ?? true,
          sameSite: normalizeSameSite(rawEntry.sameSite),
        });
      }
      if (cookies.length === 0) {
        throw new CookieError(`${sourceDescription} contained no cookies`, "COOKIE_MALFORMED");
      }
      return cookies;
    }
    throw new CookieError(
      `${sourceDescription} is not a recognized credential object — expected cookie names mapping to { value, … } entries`,
      "COOKIE_MALFORMED",
      { context: { source: sourceDescription } },
    );
  }

  throw new CookieError(
    `${sourceDescription} must contain a cookie array or object, received ${typeof value}`,
    "COOKIE_MALFORMED",
    { context: { source: sourceDescription } },
  );
}

/** Reads a JSON credential file and parses its contents. */
async function parseFile(path: string): Promise<readonly NormalizedCookie[]> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    throw new CookieError(`Could not read credential file "${path}"`, "COOKIE_MALFORMED", {
      cause,
      context: { path },
    });
  }
  const trimmed = contents.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      throw new CookieError(`Credential file "${path}" contains invalid JSON`, "COOKIE_MALFORMED", {
        cause,
        context: { path },
      });
    }
    return parseStructured(parsed, `file "${path}"`);
  }
  return parseCookieHeaderString(trimmed);
}

/** Environment variable names: uppercase letters, digits, underscores. */
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Parses credentials in any of the six supported formats into normalized
 * cookies. Detection order for strings: file path, then environment
 * variable name, then raw cookie header.
 */
export async function parseCredentials(input: Credentials): Promise<readonly NormalizedCookie[]> {
  if (typeof input === "string") {
    if (existsSync(input)) {
      return parseFile(input);
    }
    if (ENV_NAME_PATTERN.test(input) && process.env[input] !== undefined) {
      const raw = process.env[input]!;
      const trimmed = raw.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch (cause) {
          throw new CookieError(
            `Environment variable "${input}" contains invalid JSON`,
            "COOKIE_MALFORMED",
            { cause, context: { variable: input } },
          );
        }
        return parseStructured(parsed, `environment variable "${input}"`);
      }
      return parseCookieHeaderString(trimmed);
    }
    if (input.includes("=")) {
      return parseCookieHeaderString(input);
    }
    throw new CookieError(
      `Credential string "${input}" is neither an existing file, a defined PANINDIGAN-style environment variable name, nor a "name=value; …" cookie header`,
      "COOKIE_MALFORMED",
      { context: { input: input.slice(0, 32) } },
    );
  }
  return parseStructured(input, "credential input");
}


/**
 * Maps a cookie to the URL it is stored under.
 *
 * A host-only cookie must be stored under its EXACT host. tough-cookie keeps
 * a `facebook.com` host-only cookie when it is set through
 * `https://www.facebook.com/`, but `getCookiesSync()` never returns it — it
 * looks identical to a rejection. This is why a `dbln` host-only cookie was
 * reported as "1 of 10 cookies rejected". The old condition skipped the exact
 * canonical domain (`facebook.com`), which is precisely the case that needs
 * the strict host URL.
 */
function urlForCookie(cookie: NormalizedCookie): string {
  const domain = cookie.domain.replace(/^\./, "");
  if (cookie.hostOnly) {
    return `https://${domain}/`;
  }
  return domain.includes("messenger") ? MESSENGER_URL : FACEBOOK_URL;
}

/** Builds a tough-cookie `Cookie` from the normalized form. */
function toToughCookie(cookie: NormalizedCookie): Cookie {
  return new Cookie({
    key: cookie.name,
    value: cookie.value,
    // tough-cookie expects the canonical domain (no leading dot). AppState
    // exports carry ".facebook.com" which tough-cookie rejects silently.
    domain: cookie.domain.replace(/^\.+/, ""),
    path: cookie.path,
    expires: cookie.expiresAtMs === null ? null : new Date(cookie.expiresAtMs),
    hostOnly: cookie.hostOnly,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  });
}

/**
 * A cookie jar scoped to Facebook's domains. Wraps tough-cookie and adds
 * the validation and serialization the session layer needs.
 */
export class CookieStore {
  readonly #jar: CookieJar;
  readonly #logger: Logger | null;

  private constructor(jar: CookieJar, logger: Logger | null = null) {
    this.#jar = jar;
    this.#logger = logger;
  }

  /** Builds a store from normalized cookies. */
  static fromCookies(cookies: readonly NormalizedCookie[], logger: Logger | null = null): CookieStore {
    const jar = new CookieJar();
    const store = new CookieStore(jar, logger);
    store.setCookies(cookies);
    return store;
  }

  /** Restores a store from its serialized form. */
  static fromSerialized(serialized: SerializedCookieJar, logger: Logger | null = null): CookieStore {
    return new CookieStore(CookieJar.fromJSON(JSON.stringify(serialized)), logger);
  }

  /** Stores normalized cookies, replacing same-named entries. */
  setCookies(cookies: readonly NormalizedCookie[]): void {
    const landed = (cookie: NormalizedCookie): boolean =>
      this.#jar.getCookiesSync(urlForCookie(cookie)).some((stored) => stored.key === cookie.name);
    const isExpired = (cookie: NormalizedCookie): boolean =>
      cookie.expiresAtMs !== null && cookie.expiresAtMs <= Date.now();

    const thrown: Array<{ name: string; reason: string }> = [];
    for (const cookie of cookies) {
      const toughCookie = toToughCookie(cookie);
      const url = urlForCookie(cookie);
      try {
        this.#jar.setCookieSync(toughCookie, url);
      } catch (err) {
        // Explicit rejection (e.g., invalid domain, path). Cookie names and
        // domains are safe; values are never logged.
        const reason = err instanceof Error ? err.message : String(err);
        thrown.push({ name: cookie.name, reason });
        this.#logger?.warn(
          { cookie: cookie.name, domain: cookie.domain, err: reason },
          "Cookie rejected by the cookie jar",
        );
      }
    }

    // Distinguish EXPIRED cookies from genuinely rejected ones. tough-cookie
    // stores an expired cookie but filters it out of getCookiesSync(), so an
    // expired cookie looks identical to a rejection to a naive counter.
    const missing = cookies.filter((cookie) => !landed(cookie));
    const expiredNames = missing.filter(isExpired).map((cookie) => cookie.name);
    const rejectedNames = missing.filter((cookie) => !isExpired(cookie)).map((cookie) => cookie.name);

    if (expiredNames.length > 0) {
      this.#logger?.warn(
        { count: expiredNames.length, total: cookies.length, names: expiredNames },
        `${expiredNames.length} of ${cookies.length} cookies in this export are already expired`,
      );
    }

    if (rejectedNames.length > 0) {
      // Capture the ACTUAL shape so the next deployment can identify the
      // cause. Cookie values are never included — only attributes.
      const details = rejectedNames.map((name) => {
        const cookie = cookies.find((candidate) => candidate.name === name)!;
        const explicit = thrown.find((entry) => entry.name === name);
        return {
          name,
          domain: cookie.domain,
          path: cookie.path,
          hostOnly: cookie.hostOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite ?? "none",
          storedUnder: urlForCookie(cookie),
          ...(explicit !== undefined ? { error: explicit.reason } : {}),
        };
      });
      this.#logger?.warn(
        { count: rejectedNames.length, total: cookies.length, names: rejectedNames, details },
        `${rejectedNames.length} of ${cookies.length} cookies were rejected by the cookie jar`,
      );
    }
  }

  /** The value of a named cookie, or `null` when absent. Internal use only — never logged. */
  getCookieValue(name: string): string | null {
    for (const cookie of this.#jar.getCookiesSync(FACEBOOK_URL)) {
      if (cookie.key === name) {
        return cookie.value;
      }
    }
    return null;
  }

  /** The value of the `c_user` cookie, or `null` when absent. */
  getUserId(): string | null {
    for (const cookie of this.#jar.getCookiesSync(FACEBOOK_URL)) {
      if (cookie.key === "c_user") {
        return cookie.value;
      }
    }
    return null;
  }

  /** The `Cookie` header value for a URL. */
  headerFor(url: string): string {
    return this.#jar.getCookieStringSync(url);
  }

  /** Applies `Set-Cookie` header values received from a response. */
  applySetCookies(setCookieValues: readonly string[], url: string): void {
    for (const value of setCookieValues) {
      try {
        this.#jar.setCookieSync(value, url);
      } catch {
        // Facebook occasionally sends cookies tough-cookie refuses
        // (odd domains, malformed attributes). Skipping one must not
        // kill the request cycle.
      }
    }
  }

  /**
   * Validates that `c_user`, `xs`, and `datr` are present and unexpired,
   * returning the user id. Throws `CookieError` otherwise — before any
   * network request is made.
   * 
   * Note: This validates cookie *format* only. A session can pass local
   * validation but still be rejected by Facebook (error 1357004) when:
   * - Account logged out elsewhere
   * - Session revoked server-side
   * - Cookies too old (even if not technically expired)
   * 
   * If you get AUTH_REFRESH_REQUIRED after this passes, you must export
   * fresh cookies from an active browser session.
   */
  requireAuthenticated(): string {
    const cookies = new Map(this.#jar.getCookiesSync(FACEBOOK_URL).map((c) => [c.key, c]));
    
    // Check all required cookies present
    for (const required of REQUIRED_COOKIES) {
      const cookie = cookies.get(required);
      if (cookie === undefined) {
        throw new CookieError(
          `Required cookie "${required}" is missing from the credentials`,
          "COOKIE_MISSING",
          { context: { cookie: required, present: [...cookies.keys()] } },
        );
      }
      if (cookie.expires instanceof Date && cookie.expires.getTime() <= Date.now()) {
        throw new CookieError(
          `Required cookie "${required}" expired at ${cookie.expires.toISOString()} — export a fresh session from your browser`,
          "COOKIE_EXPIRED",
          { context: { cookie: required, expiredAt: cookie.expires.toISOString() } },
        );
      }
    }
    
    const userId = cookies.get("c_user")!.value;
    if (userId === "") {
      throw new CookieError('The "c_user" cookie is empty', "COOKIE_MISSING", {
        context: { cookie: "c_user" },
      });
    }
    
    // Warn about cookies nearing expiry (within 7 days)
    const sevenDaysFromNow = Date.now() + (7 * 24 * 60 * 60 * 1000);
    for (const required of REQUIRED_COOKIES) {
      const cookie = cookies.get(required)!;
      if (cookie.expires instanceof Date) {
        const expiryTime = cookie.expires.getTime();
        if (expiryTime > Date.now() && expiryTime < sevenDaysFromNow) {
          const daysLeft = Math.floor((expiryTime - Date.now()) / (24 * 60 * 60 * 1000));
          // This is logged by session manager, not thrown
        }
      }
    }
    
    return userId;
  }

  /** Expiry (epoch ms) of a named cookie, `null` when it never expires. */
  getCookieExpiry(name: string): number | null {
    for (const cookie of this.#jar.getCookiesSync(FACEBOOK_URL)) {
      if (cookie.key === name) {
        if (cookie.expires instanceof Date) {
          return cookie.expires.getTime();
        }
        return null;
      }
    }
    return null;
  }

  /** Serialized form, suitable for the storage adapter. */
  toSerialized(): SerializedCookieJar {
    const serialized = this.#jar.toJSON();
    if (serialized === undefined) {
      // An empty jar serializes to `undefined`; normalize to the canonical
      // empty form so consumers always receive a stable structure.
      return { version: "tough-cookie", storeType: "MemoryCookieStore", rejectPublicSuffixes: true, cookies: [] };
    }
    return serialized;
  }

  /** AppState array form, preserving attributes. */
  toAppState(): readonly AppStateCookie[] {
    const cookies: AppStateCookie[] = [];
    for (const url of [FACEBOOK_URL, MESSENGER_URL]) {
      for (const cookie of this.#jar.getCookiesSync(url)) {
        cookies.push({
          key: cookie.key,
          value: cookie.value,
          domain: cookie.domain ?? undefined,
          path: cookie.path ?? undefined,
          expires:
            cookie.expires instanceof Date
              ? cookie.expires.toISOString()
              : cookie.expires === "Infinity"
                ? "Infinity"
                : undefined,
          expirationDate:
            cookie.expires instanceof Date ? Math.floor(cookie.expires.getTime() / 1000) : undefined,
          hostOnly: cookie.hostOnly ?? undefined,
          httpOnly: cookie.httpOnly ?? undefined,
          secure: cookie.secure ?? undefined,
          sameSite: cookie.sameSite ?? undefined,
        });
      }
    }
    return cookies;
  }
}
