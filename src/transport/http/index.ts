/**
 * HTTP transport.
 *
 * One undici dispatcher per client, wrapped in Facebook's web-client request
 * conventions: cookies from the session jar, the rotating `__req` counter,
 * `fb_dtsg`/`jazoest`/`lsd` form defaults, `for (;;);`-prefixed JSON
 * responses, manual redirect handling with a configurable limit, retries
 * with jittered exponential backoff on network errors, 429s, and 5xxs, and
 * the middleware chain around every operation.
 *
 * HTTP and HTTPS proxies go through undici's `ProxyAgent`; SOCKS5 proxies
 * through its `Socks5ProxyAgent`. All three share one connection pool.
 */

import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import {
  Agent,
  FormData,
  ProxyAgent,
  Socks5ProxyAgent,
  request,
  type Dispatcher,
} from "undici";
import {
  APIError,
  AuthenticationError,
  LibraryError,
  NetworkError,
  PermissionError,
  TimeoutError,
  TransportError,
} from "../../errors/index.js";
import type { CookieStore, NormalizedCookie } from "../../auth/index.js";
import type { ResolvedConfig } from "../../config/index.js";
import type { DiagnosticsCollector } from "../../diagnostics/index.js";
import { HeaderMap, MiddlewareContextImpl } from "../../middleware/index.js";
import type { MiddlewareManager } from "../../middleware/index.js";
import type { Logger } from "../../logger/index.js";

// ---------------------------------------------------------------------------
// Tokens and responses
// ---------------------------------------------------------------------------

/**
 * Session-scoped request tokens merged into every Facebook request, in the
 * same shape the web client sends them. Updated by the session manager after
 * the login HTML is scraped, and refreshed from `jsmods` carried by ordinary
 * responses.
 */
export interface RequestTokens {
  /** Authenticated account id (`av` / `__user`). */
  readonly userId: string;
  /** CSRF token scraped from the login page, rotated by Facebook over time. */
  readonly fbDtsg: string | null;
  /** Anti-CSRF checksum derived from `fb_dtsg`. */
  readonly jazoest: string | null;
  /** The `lsd` token, sent as `x-fb-lsd` and in forms. */
  readonly lsd: string | null;
  /** Site revision, sent as `__rev`. */
  readonly revision: string | null;
  /** The account's MQTT region, sent as `x-msgr-region`. */
  readonly region: string | null;
}

/** A completed HTTP response, after redirects, with its parsed payload. */
export interface HttpResponse {
  readonly status: number;
  /** Final URL after redirects. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Response body as text. */
  readonly body: string;
  /** Body parsed as JSON (`for (;;);` prefixes stripped), or `null`. */
  readonly json: unknown | null;
}

/** A streaming download: headers received, body still flowing. */
export interface DownloadResponse {
  readonly status: number;
  readonly url: string;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly stream: Readable;
}

/** Per-request options shared by the request methods. */
export interface RequestOptions {
  /** Query-string parameters, appended to the URL. */
  readonly query?: Readonly<Record<string, FormValue>> | undefined;
  /** Merge `fb_dtsg` & co. defaults into the form. Default `true`. */
  readonly withDefaults?: boolean | undefined;
  /** Overrides `httpTimeout` for this request, in ms. */
  readonly timeoutMs?: number | undefined;
  /** Extra headers layered over the built-ins. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** One field value in a form or query string. */
export type FormValue = string | number | boolean | object | null | undefined;

/** One file in a multipart upload. */
export interface UploadFile {
  /** Form field name; Facebook expects `upload_1024`. */
  readonly field: string;
  readonly filename: string;
  readonly content: Buffer;
  readonly contentType?: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Backoff cap for HTTP retries, in ms. */
const RETRY_BACKOFF_CAP_MS = 8_000;

/** Base delay for the first HTTP retry, in ms. */
const RETRY_BACKOFF_BASE_MS = 500;

/** Cap applied to a server-provided `Retry-After`, in ms. */
const RETRY_AFTER_CAP_MS = 60_000;

/**
 * Computes `jazoest` from `fb_dtsg`: the literal `"2"` followed by the sum
 * of the token's character codes. This is the formula Facebook's bootstrap
 * uses; responses often carry the current value to re-derive it from.
 */
export function computeJazoest(fbDtsg: string): string {
  let sum = 0;
  for (let i = 0; i < fbDtsg.length; i += 1) {
    sum += fbDtsg.charCodeAt(i);
  }
  return `2${sum}`;
}

/**
 * Splits a string holding several concatenated JSON documents into their
 * parsed values. Facebook's `graphqlbatch` endpoint replies with one object per
 * batch entry followed by a summary object, with no array wrapper or
 * separator, so a plain `JSON.parse` only ever sees the first document.
 *
 * Returns `null` as soon as any document fails to parse; the caller treats
 * that exactly like any other malformed body.
 */
function parseConcatenatedJson(text: string): readonly unknown[] | null {
  const values: unknown[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text[index];
    if (start === undefined) {
      break;
    }
    if (start === " " || start === "\n" || start === "\r" || start === "\t") {
      index += 1;
      continue;
    }

    // Scan one JSON value, tracking string state so braces inside strings do
    // not affect the nesting depth.
    const valueStart = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let complete = false;
    for (; index < text.length; index += 1) {
      const char = text[index]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        depth += 1;
        continue;
      }
      if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          complete = true;
          break;
        }
        if (depth < 0) {
          return null;
        }
      }
    }
    if (!complete) {
      return null;
    }
    try {
      values.push(JSON.parse(text.slice(valueStart, index)) as unknown);
    } catch {
      return null;
    }
  }
  return values;
}

/**
 * Strips Facebook's `for (;;);` / `while(1);` payload prefixes and parses the
 * body. A body containing several concatenated documents — as returned by
 * `/api/graphqlbatch/` — parses to an array of those documents; a body with a
 * single document parses to that document; an empty or malformed body parses
 * to `null`.
 */
export function parseFacebookJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  const stripped = trimmed
    .replace(/^for\s*\(\s*;;\s*\)\s*;?/, "")
    .replace(/^while\s*\(\s*1\s*\)\s*;?/, "")
    .trim();
  if (stripped === "") {
    return null;
  }
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    // Not a single document; fall through to concatenated decoding.
  }
  const documents = parseConcatenatedJson(stripped);
  if (documents === null || documents.length === 0) {
    return null;
  }
  return documents.length === 1 ? documents[0] : documents;
}

/** Flattens a header into its string form. */
function headerAsString(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return value.join(", ");
}

/** Extracts the `set-cookie` values from a response header record. */
function setCookieValues(headers: Readonly<Record<string, unknown>>): readonly string[] {
  const raw = headers["set-cookie"];
  if (raw === undefined) {
    return [];
  }
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/** Whether a status code is one of the redirect statuses. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Redirect targets that mean Facebook refused the session, not a transient hop. */
export function isLoginRedirect(url: string): boolean {
  try {
    return /\/login|\/checkpoint|checkpoint\.php/i.test(new URL(url).pathname);
  } catch {
    return /\/login|\/checkpoint/i.test(url);
  }
}

/**
 * Builds a precise failure for an exhausted redirect chain.
 * A chain that passed through a login/checkpoint URL is a session problem —
 * reporting "Redirect limit exceeded" there sent users chasing a network bug.
 */
export function redirectFailure(
  operation: string,
  limit: number,
  finalUrl: string,
  sawLogin: boolean,
  streaming: boolean,
): LibraryError {
  if (sawLogin) {
    return new AuthenticationError(
      `Session is no longer valid — "${operation}" was redirected to Facebook's login page after ${limit} redirects. ` +
        `Re-export cookies from a browser that is currently logged in.`,
      "AUTH_SESSION_EXPIRED",
      {
        retryable: false,
        context: { operation, finalUrl, redirectLimit: limit, ...(streaming ? { streaming: true } : {}) },
      },
    );
  }
  return new TransportError(
    `Redirect limit (${limit}) exceeded ${streaming ? "while streaming" : "during"} "${operation}"`,
    "TRANSPORT_ERROR",
    { context: { operation, finalUrl, redirectLimit: limit } },
  );
}

/** Whether a status code merits an automatic retry. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Reads `Retry-After` (seconds) into a delay in ms, when present. */
function retryAfterMs(headers: Readonly<Record<string, string | readonly string[]>>): number | null {
  const value = headerAsString(headers["retry-after"]);
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.min(Math.round(seconds * 1000), RETRY_AFTER_CAP_MS);
}

/** Jittered exponential backoff for HTTP retries. */
function backoffDelayMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null) {
    return retryAfter;
  }
  const base = Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  const jitter = 0.5 + Math.random();
  return Math.round(base * jitter);
}

/** Waits for a delay, resolving early if the abort signal fires. */
function sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish);
  });
}

/** Stringifies one form value the way Facebook's endpoints expect. */
function encodeFormValue(value: FormValue): string {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value) as string;
  }
  return String(value);
}

/** Encodes a form/query record into a URL-encoded string. */
function encodeForm(form: Readonly<Record<string, FormValue>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined || value === null) {
      continue;
    }
    params.append(key, encodeFormValue(value));
  }
  return params.toString();
}

/** Appends a query record to a URL. */
function withQuery(url: string, query: Readonly<Record<string, FormValue>> | undefined): string {
  if (query === undefined) {
    return url;
  }
  const encoded = encodeForm(query);
  if (encoded === "") {
    return url;
  }
  return `${url}${url.includes("?") ? "&" : "?"}${encoded}`;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Dependencies the transport needs from its host client. */
export interface HttpTransportDeps {
  readonly config: ResolvedConfig;
  readonly cookies: CookieStore;
  readonly middleware: MiddlewareManager;
  readonly diagnostics: DiagnosticsCollector;
  readonly logger: Logger;
}

/**
 * Facebook's HTTP endpoints, driven with the web client's conventions.
 */
export class HttpTransport {
  readonly #config: ResolvedConfig;
  readonly #cookies: CookieStore;
  readonly #middleware: MiddlewareManager;
  readonly #diagnostics: DiagnosticsCollector;
  readonly #logger: Logger;
  readonly #dispatcher: Dispatcher;
  #reqCounter = 1;
  #tokens: RequestTokens;

  constructor(deps: HttpTransportDeps) {
    this.#config = deps.config;
    this.#cookies = deps.cookies;
    this.#middleware = deps.middleware;
    this.#diagnostics = deps.diagnostics;
    this.#logger = deps.logger;
    this.#dispatcher = buildDispatcher(deps.config);
    this.#tokens = {
      userId: "",
      fbDtsg: null,
      jazoest: null,
      lsd: null,
      revision: null,
      region: null,
    };
  }

  /** Replaces session tokens (partial patches merge). */
  setTokens(patch: Partial<RequestTokens>): void {
    this.#tokens = { ...this.#tokens, ...patch };
  }

  /** The current session tokens. */
  get tokens(): Readonly<RequestTokens> {
    return this.#tokens;
  }

  /**
   * GET request. Query parameters are merged with the session defaults when
   * `withDefaults` is not disabled. For the home-page scrape pass
   * `withDefaults: false` — Facebook serves the boot page (and its
   * `fb_dtsg`/`lsd` payloads) to a plain cookie-only GET exactly like the
   * real FCA login flow does.
   */
  async get(
    operation: string,
    url: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    const query =
      options.withDefaults === false
        ? (options.query ?? {})
        : this.#mergeDefaults(options.query ?? {});
    return this.#execute(operation, "GET", withQuery(url, query), {
      body: null,
      contentType: null,
      timeoutMs: options.timeoutMs ?? this.#config.httpTimeout,
      extraHeaders: options.headers,
    });
  }

  /**
   * POST with a URL-encoded form body, merged with the session defaults
   * unless `withDefaults` is disabled.
   */
  async postForm(
    operation: string,
    url: string,
    form: Readonly<Record<string, FormValue>>,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    const merged = options.withDefaults === false ? form : this.#mergeDefaults(form);
    const body = encodeForm(merged);
    const target = withQuery(url, options.query);
    return this.#execute(operation, "POST", target, {
      body,
      contentType: "application/x-www-form-urlencoded",
      timeoutMs: options.timeoutMs ?? this.#config.httpTimeout,
      extraHeaders: options.headers,
    });
  }

  /**
   * POST a raw JSON body. No form defaults are merged — used by the few
   * endpoints that take a plain JSON document.
   */
  async postJson(
    operation: string,
    url: string,
    payload: unknown,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    return this.#execute(operation, "POST", withQuery(url, options.query), {
      body: JSON.stringify(payload),
      contentType: "application/json",
      timeoutMs: options.timeoutMs ?? this.#config.httpTimeout,
      extraHeaders: options.headers,
    });
  }

  /**
   * POST a multipart form with one file, merged with the session defaults.
   * Facebook's upload endpoint expects the file under the `upload_1024`
   * field with `voice_clip=true` for audio.
   */
  async postMultipart(
    operation: string,
    url: string,
    fields: Readonly<Record<string, FormValue>>,
    file: UploadFile | null,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    const form = new FormData();
    const merged = options.withDefaults === false ? fields : this.#mergeDefaults(fields);
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined || value === null) {
        continue;
      }
      form.append(key, encodeFormValue(value));
    }
    if (file !== null) {
      const blob = new Blob([new Uint8Array(file.content)], {
        type: file.contentType ?? "application/octet-stream",
      });
      form.append(file.field, blob, file.filename);
    }
    return this.#execute(operation, "POST", withQuery(url, options.query), {
      body: form,
      contentType: null,
      timeoutMs: options.timeoutMs ?? this.#config.httpTimeout,
      extraHeaders: options.headers,
    });
  }

  /**
   * Starts a streaming GET download. The body is returned as a Node stream
   * without buffering; redirects are followed, cookies are attached, but no
   * form defaults are merged and no JSON parsing is attempted.
   */
  async stream(
    operation: string,
    url: string,
    options: RequestOptions = {},
  ): Promise<DownloadResponse> {
    const target = withQuery(url, options.query);
    const headers = this.#buildHeaders(new URL(target), options.headers);
    const context = new MiddlewareContextImpl(operation, target, "GET", headers);
    if (!(await this.#middleware.runBefore(context))) {
      const error = new TransportError(
        `Request for "${operation}" was cancelled by middleware`,
        "TRANSPORT_ERROR",
        { context: { operation } },
      );
      context.error = error;
      await this.#middleware.runError(context);
      throw error;
    }

    const timeoutMs = options.timeoutMs ?? this.#config.httpTimeout;
    let currentUrl = target;
    let redirectsLeft = this.#config.httpMaxRedirects;
    let sawLogin = false;
    for (;;) {
      const requestHeaders: Record<string, string> = {
        ...context.mutatedHeaders(),
        cookie: this.#cookies.headerFor(currentUrl),
      };
      const started = Date.now();
      let response;
      try {
        response = await request(currentUrl, {
          dispatcher: this.#dispatcher,
          method: "GET",
          headers: requestHeaders,
          headersTimeout: timeoutMs,
          bodyTimeout: 0,
        });
      } catch (cause) {
        const error = this.#classifyTransportError(operation, cause);
        context.error = error;
        await this.#middleware.runError(context);
        throw error;
      }
      const latency = Date.now() - started;
      this.#applyCookies(response.headers as Record<string, unknown>, currentUrl);
      const location = headerAsString(response.headers["location"]);
      if (isRedirectStatus(response.statusCode) && location !== null) {
        await response.body.dump().catch(() => undefined);
        const nextUrl = new URL(location, currentUrl).toString();
        if (isLoginRedirect(nextUrl)) sawLogin = true;
        if (redirectsLeft <= 0) {
          const error = redirectFailure(operation, this.#config.httpMaxRedirects, nextUrl, sawLogin, true);
          context.error = error;
          await this.#middleware.runError(context);
          throw error;
        }
        redirectsLeft -= 1;
        currentUrl = nextUrl;
        continue;
      }
      this.#diagnostics.recordHttpRequest({ succeeded: response.statusCode === 200, latencyMs: latency });
      const headers = response.headers as Record<string, string | readonly string[]>;
      context.response = {
        status: response.statusCode,
        headers: new HeaderMap(flattenHeaders(headers)),
        body: null,
      };
      await this.#middleware.runAfter(context);
      const contentType = headerAsString(headers["content-type"]);
      const contentLength = headerAsString(headers["content-length"]);
      return {
        status: response.statusCode,
        url: currentUrl,
        contentType,
        contentLength: contentLength === null ? null : Number(contentLength),
        stream: response.body as unknown as Readable,
      };
    }
  }

  /**
   * Interprets a response for an API operation: throws the mapped
   * `LibraryError` for login redirects, non-200 statuses, and Facebook error
   * payloads; returns the parsed JSON payload otherwise. `allowNon200`
   * accepts a non-200 response whose body still parses (Facebook's upload
   * endpoint does this).
   */
  check(operation: string, response: HttpResponse, options?: { readonly allowNon200?: boolean | undefined }): unknown {
    if (response.url.includes("/login")) {
      throw new AuthenticationError(
        `Session is no longer valid — "${operation}" was redirected to the login page`,
        "AUTH_SESSION_EXPIRED",
        { context: { operation, url: response.url }, retryable: false },
      );
    }
    if (response.status !== 200 && options?.allowNon200 !== true) {
      throw this.#apiErrorFromStatus(operation, response);
    }
    if (response.json === null) {
      throw new APIError(
        `"${operation}" returned a non-JSON response (status ${response.status})`,
        "API_ERROR",
        { context: { operation, status: response.status, contentType: headerAsString(response.headers["content-type"]) } },
      );
    }
    const error = interpretFacebookError(operation, response.json);
    if (error !== null) {
      throw error;
    }
    return response.json;
  }

  /** Closes the connection pool. The transport cannot be reused afterwards. */
  async close(): Promise<void> {
    await this.#dispatcher.close();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Merges the rotating session defaults into a form or query record. */
  #mergeDefaults(form: Readonly<Record<string, FormValue>>): Record<string, FormValue> {
    const merged: Record<string, FormValue> = { ...form };
    const tokens = this.#tokens;
    if (tokens.userId !== "") {
      merged["av"] = tokens.userId;
      merged["__user"] = tokens.userId;
    }
    merged["__req"] = (this.#reqCounter++).toString(36);
    merged["__a"] = 1;
    if (tokens.fbDtsg !== null) {
      merged["fb_dtsg"] = tokens.fbDtsg;
    }
    if (tokens.jazoest !== null) {
      merged["jazoest"] = tokens.jazoest;
    }
    if (tokens.lsd !== null) {
      merged["lsd"] = tokens.lsd;
    }
    if (tokens.revision !== null) {
      merged["__rev"] = tokens.revision;
    }
    return merged;
  }

  /**
   * Builds the base headers for a request.
   *
   * The shape leans toward browser navigation rather than raw XHR: it
   * accepts `text/html` first and carries the usual Chrome navigation
   * client hints. Actively maintained FCA clients send a compatible set
   * and are able to read the boot page from a plain root-page GET.
   *
   * NOTE — the `Accept` header is NOT what decides between the boot page
   * and the `{"error":1357004}` envelope. Our own production deployment
   * received the envelope while sending `Accept: text/html,…` (0.1.8 log).
   * The decisive factor is the session itself: a rejected session gets the
   * envelope on every shape of request, and no header set can revive it.
   */
  #buildHeaders(
    url: URL,
    extra?: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
      "accept-language": "en-US,en;q=0.9",
      origin: "https://www.facebook.com",
      referer: "https://www.facebook.com/",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "upgrade-insecure-requests": "1",
      "user-agent": this.#config.userAgent,
      "x-asbd-id": "359341",
      "sec-ch-ua": '"Chromium";v="149", "Not;A=Brand";v="24", "Google Chrome";v="149"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    };
    if (this.#tokens.region !== null) {
      headers["x-msgr-region"] = this.#tokens.region;
    }
    if (this.#tokens.lsd !== null) {
      headers["x-fb-lsd"] = this.#tokens.lsd;
    }
    if (extra !== undefined) {
      Object.assign(headers, extra);
    }
    return headers;
  }

  /** Runs middleware and the retry loop around a single logical request. */
  async #execute(
    operation: string,
    method: "GET" | "POST",
    url: string,
    spec: {
      readonly body: string | FormData | null;
      readonly contentType: string | null;
      readonly timeoutMs: number;
      readonly extraHeaders?: Readonly<Record<string, string>> | undefined;
    },
  ): Promise<HttpResponse> {
    const headers = this.#buildHeaders(new URL(url), spec.extraHeaders);
    if (spec.contentType !== null) {
      headers["content-type"] = spec.contentType;
    }
    const context = new MiddlewareContextImpl(operation, url, method, headers);
    if (!(await this.#middleware.runBefore(context))) {
      const cancelled = new TransportError(
        `Request for "${operation}" was cancelled by middleware`,
        "TRANSPORT_ERROR",
        { context: { operation } },
      );
      context.error = cancelled;
      await this.#middleware.runError(context);
      throw cancelled;
    }
    const finalHeaders = context.mutatedHeaders();
    const bytesSent =
      typeof spec.body === "string" ? Buffer.byteLength(spec.body) : null;

    let attempt = 0;
    for (;;) {
      let response: HttpResponse | null = null;
      let failure: LibraryError | null = null;
      try {
        response = await this.#attempt(operation, method, url, finalHeaders, spec, bytesSent);
        if (response !== null && isRetryableStatus(response.status)) {
          const retryAfter = retryAfterMs(response.headers);
          if (attempt >= this.#config.httpRetries) {
            failure = this.#apiErrorFromStatus(operation, response);
            response = null;
          } else {
            attempt += 1;
            this.#diagnostics.recordHttpRetry();
            await this.#sleep(backoffDelayMs(attempt, retryAfter));
            response = null;
            continue;
          }
        }
      } catch (cause) {
        const classified = this.#classifyTransportError(operation, cause);
        if (classified.retryable && attempt < this.#config.httpRetries) {
          attempt += 1;
          this.#diagnostics.recordHttpRetry();
          await this.#sleep(backoffDelayMs(attempt, null));
          continue;
        }
        failure = classified;
      }

      if (failure !== null) {
        context.error = failure;
        await this.#middleware.runError(context);
        throw failure;
      }
      // Non-null by construction: every path either returns, continues, or
      // sets `failure`.
      const finalResponse = response as HttpResponse;
      context.response = {
        status: finalResponse.status,
        headers: new HeaderMap(finalResponse.headers),
        body: finalResponse.body,
      };
      await this.#middleware.runAfter(context);
      return finalResponse;
    }
  }

  /** One full request, following redirects, without retries or middleware. */
  async #attempt(
    operation: string,
    method: "GET" | "POST",
    url: string,
    headers: Readonly<Record<string, string>>,
    spec: {
      readonly body: string | FormData | null;
      readonly contentType: string | null;
      readonly timeoutMs: number;
    },
    bytesSent: number | null,
  ): Promise<HttpResponse> {
    let currentUrl = url;
    let currentMethod = method;
    let currentBody: string | FormData | null = spec.body;
    let currentHeaders: Readonly<Record<string, string>> = headers;
    let redirectsLeft = this.#config.httpMaxRedirects;
    let sawLogin = false;

    for (;;) {
      const requestHeaders: Record<string, string> = {
        ...currentHeaders,
        cookie: this.#cookies.headerFor(currentUrl),
      };
      const started = Date.now();
      let response;
      try {
        response = await request(currentUrl, {
          dispatcher: this.#dispatcher,
          method: currentMethod,
          headers: requestHeaders,
          body: currentBody,
          headersTimeout: spec.timeoutMs,
          bodyTimeout: spec.timeoutMs,
        });
      } catch (cause) {
        throw this.#classifyTransportError(operation, cause);
      }
      const latency = Date.now() - started;
      this.#applyCookies(response.headers as Record<string, unknown>, currentUrl);
      const location = headerAsString(response.headers["location"]);
      if (isRedirectStatus(response.statusCode) && location !== null) {
        await response.body.dump().catch(() => undefined);
        const nextUrl = new URL(location, currentUrl).toString();
        if (isLoginRedirect(nextUrl)) sawLogin = true;
        if (redirectsLeft <= 0) {
          throw redirectFailure(operation, this.#config.httpMaxRedirects, nextUrl, sawLogin, false);
        }
        redirectsLeft -= 1;
        if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && currentMethod === "POST")) {
          currentMethod = "GET";
          currentBody = null;
          // Body headers must not follow a POST -> GET redirect; some servers
          // reject the request (or bounce again) when they see content-length.
          const { "content-type": _ct, "content-length": _cl, "transfer-encoding": _te, ...getHeaders } = currentHeaders;
          currentHeaders = getHeaders;
        }
        currentUrl = nextUrl;
        continue;
      }

      const body = await response.body.text();
      this.#diagnostics.recordHttpRequest({
        succeeded: response.statusCode >= 200 && response.statusCode < 300,
        latencyMs: latency,
        bytesIn: Buffer.byteLength(body),
        bytesSent: bytesSent ?? undefined,
      });
      const json = parseFacebookJson(body);
      if (json !== null) {
        this.#absorbJsmods(json);
      }
      return {
        status: response.statusCode,
        url: currentUrl,
        headers: flattenHeaders(response.headers as Record<string, string | readonly string[]>),
        body,
        json,
      };
    }
  }

  /** Applies `Set-Cookie` values from a response to the session jar. */
  #applyCookies(headers: Readonly<Record<string, unknown>>, url: string): void {
    const values = setCookieValues(headers);
    if (values.length === 0) {
      return;
    }
    this.#cookies.applySetCookies(values, url);
  }

  /** Maps undici/network failures to the library's transport errors. */
  #classifyTransportError(operation: string, cause: unknown): LibraryError {
    const message = cause instanceof Error ? cause.message : String(cause);
    const name = cause instanceof Error ? cause.name : "";
    if (/timeout/i.test(message) || /timeout/i.test(name)) {
      return new TimeoutError(`"${operation}" timed out: ${message}`, {
        cause,
        context: { operation },
      });
    }
    if (/redirect/i.test(message)) {
      return new TransportError(`"${operation}" failed: ${message}`, "TRANSPORT_ERROR", {
        cause,
        context: { operation },
      });
    }
    return new NetworkError(`"${operation}" failed at the network level: ${message}`, {
      cause,
      context: { operation },
    });
  }

  /** Builds the API error for a non-retryable (or exhausted) HTTP status. */
  #apiErrorFromStatus(operation: string, response: HttpResponse): LibraryError {
    if (response.status === 429) {
      return new APIError(`"${operation}" was rate-limited (HTTP 429)`, "API_RATE_LIMIT", {
        retryable: true,
        context: { operation, status: response.status },
      });
    }
    const detail = interpretFacebookError(operation, response.json);
    if (detail !== null) {
      return detail;
    }
    return new APIError(
      `"${operation}" returned HTTP ${response.status}`,
      "API_ERROR",
      { retryable: isRetryableStatus(response.status), context: { operation, status: response.status } },
    );
  }

  /** Sleep helper, isolated for readability. */
  async #sleep(ms: number): Promise<void> {
    await sleep(ms);
  }

  /**
   * Absorbs session state Facebook pushes through `jsmods` in ordinary
   * responses: rotated `fb_dtsg` tokens (re-deriving `jazoest`) and cookie
   * updates (mirroring the web client's `Cookie` require entries).
   */
  #absorbJsmods(json: unknown): void {
    if (typeof json !== "object" || json === null) {
      return;
    }
    const jsmods = (json as { jsmods?: unknown }).jsmods;
    if (typeof jsmods !== "object" || jsmods === null) {
      return;
    }
    const require = (jsmods as { require?: unknown }).require;
    if (!Array.isArray(require)) {
      return;
    }
    let newFbDtsg: string | null = null;
    const cookieUpdates: NormalizedCookie[] = [];
    for (const entry of require) {
      if (!Array.isArray(entry)) {
        continue;
      }
      const kind = entry[0];
      const args = entry[3];
      if (kind === "DTSG" && Array.isArray(args) && typeof args[0] === "string") {
        newFbDtsg = args[0];
      } else if (kind === "Cookie" && Array.isArray(args) && Array.isArray(args[0])) {
        const [rawName, value, , path] = args[0] as unknown[];
        if (typeof rawName === "string" && typeof value === "string") {
          const name = rawName.replace(/^_js_/, "");
          cookieUpdates.push({
            name,
            value,
            domain: ".facebook.com",
            path: typeof path === "string" ? path : "/",
            expiresAtMs: null,
            hostOnly: false,
            httpOnly: false,
            secure: true,
            sameSite: undefined,
          });
        }
      }
    }
    if (newFbDtsg !== null && newFbDtsg !== this.#tokens.fbDtsg) {
      this.setTokens({ fbDtsg: newFbDtsg, jazoest: computeJazoest(newFbDtsg) });
      this.#logger.debug("refreshed fb_dtsg from response jsmods");
    }
    if (cookieUpdates.length > 0) {
      this.#cookies.setCookies(cookieUpdates);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Normalizes undici's header record into a flat, string-valued record. */
function flattenHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    flat[key.toLowerCase()] = typeof value === "string" ? value : value.join(", ");
  }
  return flat;
}

/**
 * Maps Facebook's structured error payloads to typed library errors, or
 * returns `null` when the payload carries no error.
 */
export function interpretFacebookError(operation: string, json: unknown): LibraryError | null {
  if (Array.isArray(json)) {
    // GraphQL batch responses are a sequence of per-entry objects plus a
    // summary. Any entry may carry the failure, so check every document.
    for (const entry of json) {
      const error = interpretFacebookError(operation, entry);
      if (error !== null) {
        return error;
      }
    }
    return null;
  }
  if (typeof json !== "object" || json === null) {
    return null;
  }
  const record = json as Record<string, unknown>;
  const error = record["error"];

  if (typeof error === "number") {
    switch (error) {
      case 1357001:
        return new AuthenticationError(`"Not logged in" while calling "${operation}"`, "AUTH_LOGIN_REJECTED", {
          context: { operation, code: error },
        });
      case 1357004:
        // "Session too stale — fb_dtsg must be refreshed". The client's
        // login/cookie-refresh flows attempt an in-flight recovery
        // (mobile-surface token rotation); the interpreter only classifies.
        return new AuthenticationError(
          `"Session needs refresh" while calling "${operation}" (error 1357004)`,
          "AUTH_REFRESH_REQUIRED",
          { context: { operation, code: error } },
        );
      case 1357031:
        return new PermissionError(
          `Cannot perform "${operation}": Facebook rejected it (code 1357031)`,
          "PERMISSION_BLOCKED",
          { context: { operation, code: error } },
        );
      case 1545003:
        return new PermissionError(
          `Cannot perform "${operation}": this is only available in group threads`,
          "PERMISSION_DENIED",
          { context: { operation, code: error } },
        );
      case 1545012:
      case 1545014:
        return new PermissionError(
          `Cannot perform "${operation}": not part of the conversation`,
          "PERMISSION_NOT_PARTICIPANT",
          { context: { operation, code: error } },
        );
      case 1976004:
        return new PermissionError(
          `Cannot perform "${operation}": you are not an admin of this thread`,
          "PERMISSION_NOT_ADMIN",
          { context: { operation, code: error } },
        );
      default:
        return new APIError(`"${operation}" was rejected by Facebook (error ${error})`, "API_ERROR", {
          context: { operation, code: error },
        });
    }
  }

  if (typeof error === "string") {
    if (/not logged in/i.test(error)) {
      return new AuthenticationError(`"Not logged in" while calling "${operation}"`, "AUTH_LOGIN_REJECTED", {
        context: { operation },
      });
    }
    return new APIError(`"${operation}" was rejected by Facebook: ${error}`, "API_ERROR", {
      context: { operation, message: error },
    });
  }

  const summary = record["errorSummary"];
  if (typeof summary === "string") {
    return new APIError(`"${operation}" was rejected by Facebook: ${summary}`, "API_ERROR", {
      context: { operation, summary },
    });
  }

  const errors = record["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    const message =
      typeof first === "object" && first !== null && typeof (first as Record<string, unknown>)["message"] === "string"
        ? ((first as Record<string, unknown>)["message"] as string)
        : "unknown GraphQL error";
    return new APIError(`"${operation}" was rejected by Facebook: ${message}`, "API_ERROR", {
      context: { operation },
    });
  }

  const errorResults = record["error_results"];
  if (typeof errorResults === "number" && errorResults > 0) {
    return new APIError(
      `"${operation}" failed inside a GraphQL batch (${errorResults} error result(s))`,
      "API_ERROR",
      { context: { operation, errorResults } },
    );
  }

  return null;
}

/** Builds the undici dispatcher for the configured proxy, or a plain agent. */
function buildDispatcher(config: ResolvedConfig): Dispatcher {
  if (config.httpProxy !== null) {
    const proxyUrl = new URL(config.httpProxy);
    if (proxyUrl.protocol === "socks5:" || proxyUrl.protocol === "socks5h:") {
      const agent = new Socks5ProxyAgent(proxyUrl, {
        username: decodeURIComponent(proxyUrl.username),
        password: decodeURIComponent(proxyUrl.password),
      });
      return agent;
    }
    return new ProxyAgent({ uri: config.httpProxy });
  }
  return new Agent({
    connect: { timeout: config.httpTimeout },
    headersTimeout: config.httpTimeout,
    bodyTimeout: config.httpTimeout,
  });
}
