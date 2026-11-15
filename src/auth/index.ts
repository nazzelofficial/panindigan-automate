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
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "strict":
      return "strict";
    case "lax":
      return "lax";
    case "none":
    case "no_restriction":
    case "no_restriction_unspecified":
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
  if (typeof entry.expires === "number") {
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

/** Maps a cookie domain to the URL it is stored under. */
function urlForCookie(cookie: NormalizedCookie): string {
  if (cookie.hostOnly && cookie.domain !== FB_COOKIE_DOMAIN) {
    return `https://${cookie.domain.replace(/^\./, "")}/`;
  }
  return cookie.domain.includes("messenger") ? MESSENGER_URL : FACEBOOK_URL;
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

  private constructor(jar: CookieJar) {
    this.#jar = jar;
  }

  /** Builds a store from normalized cookies. */
  static fromCookies(cookies: readonly NormalizedCookie[]): CookieStore {
    const jar = new CookieJar();
    const store = new CookieStore(jar);
    store.setCookies(cookies);
    return store;
  }

  /** Restores a store from its serialized form. */
  static fromSerialized(serialized: SerializedCookieJar): CookieStore {
    return new CookieStore(CookieJar.fromJSON(JSON.stringify(serialized)));
  }

  /** Stores normalized cookies, replacing same-named entries. */
  setCookies(cookies: readonly NormalizedCookie[]): void {
    for (const cookie of cookies) {
      this.#jar.setCookieSync(toToughCookie(cookie), urlForCookie(cookie));
    }
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
   */
  requireAuthenticated(): string {
    const cookies = new Map(this.#jar.getCookiesSync(FACEBOOK_URL).map((c) => [c.key, c]));
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
