/**
 * Session lifecycle.
 *
 * Owns the state machine (`UNINITIALIZED` → `AUTHENTICATING` → `ACTIVE` ⇄
 * `RECONNECTING` → `CLOSING` → `CLOSED`), the authenticated cookie jar, the
 * MQTT sync cursor, scheduled cookie refresh, and persistence of both the jar
 * and the session metadata.
 *
 * Persisted state is written as one JSON document under `STORAGE_KEYS.session`
 * and validated with Zod when read back, so a corrupt or hand-edited file
 * fails with `SessionError` instead of poisoning the client.
 */

import { z } from "zod";
import type { SerializedCookieJar } from "tough-cookie";
import {
  COOKIE_REFRESH_CHECK_INTERVAL_MS,
  COOKIE_REFRESH_LEAD_TIME_MS,
  STORAGE_KEYS,
} from "../constants.js";
import { CookieStore, parseCredentials } from "../auth/index.js";
import type { NormalizedCookie } from "../auth/index.js";
import { SessionError } from "../errors/index.js";
import type { ResolvedConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import type {
  Credentials,
  SessionInfo,
  SessionState,
  StorageAdapter,
} from "../types/index.js";

/** Current format version of the persisted document. */
const PERSISTED_VERSION = 1;

/** Smallest delay the cookie-refresh scheduler will use, in ms. */
const MIN_REFRESH_DELAY_MS = 60_000;

/** Non-sensitive session metadata plus the serialized cookie jar. */
export interface PersistedSession {
  readonly version: typeof PERSISTED_VERSION;
  readonly userId: string;
  readonly loginTime: number;
  readonly savedAt: number;
  readonly lastSeqId: number | null;
  readonly syncToken: string | null;
  readonly region: string | null;
  readonly cookies: SerializedCookieJar;
}

/** The sync cursor fields the session manages. */
export interface SessionCursor {
  readonly lastSeqId: number | null;
  readonly syncToken: string | null;
}

const persistedSessionSchema = z
  .object({
    version: z.literal(PERSISTED_VERSION),
    userId: z.string().min(1),
    loginTime: z.number().int().nonnegative(),
    savedAt: z.number().int().nonnegative(),
    lastSeqId: z.number().int().nullable(),
    syncToken: z.string().nullable(),
    region: z.string().min(1).nullable(),
    cookies: z
      .object({
        version: z.string(),
        storeType: z.string(),
        rejectPublicSuffixes: z.boolean(),
        cookies: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

/** Result of preparing a login from credentials plus persisted state. */
export interface PreparedLogin {
  readonly userId: string;
  /** Whether cursor/region metadata was restored from storage. */
  readonly restored: boolean;
  /** The persisted document that was available, when compatible. */
  readonly persisted: PersistedSession | null;
}

/** Constructor dependencies. */
export interface SessionManagerDeps {
  readonly config: ResolvedConfig;
  readonly storage: StorageAdapter;
  readonly logger: Logger;
}

/** Allowed state transitions. `CLOSED` may re-enter `AUTHENTICATING` for a
 * fresh `login()`; every other backward transition is a programming error. */
const TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  UNINITIALIZED: ["AUTHENTICATING"],
  AUTHENTICATING: ["ACTIVE", "CLOSED"],
  ACTIVE: ["RECONNECTING", "CLOSING", "CLOSED"],
  RECONNECTING: ["ACTIVE", "CLOSING", "CLOSED"],
  CLOSING: ["CLOSED"],
  CLOSED: ["AUTHENTICATING"],
};

/** Observer notified after every state change. */
export type SessionStateListener = (state: SessionState, info: SessionInfo) => void;

/**
 * The session manager. One instance per `MessengerClient`.
 */
export class SessionManager {
  readonly #config: ResolvedConfig;
  readonly #storage: StorageAdapter;
  readonly #logger: Logger;

  #state: SessionState = "UNINITIALIZED";
  #userId = "";
  #loginTime = 0;
  #connected = false;
  #connectedSince: number | null = null;
  #lastSeqId: number | null = null;
  #syncToken: string | null = null;
  #region: string | null = null;
  #reconnects = 0;

  #cookies: CookieStore | null = null;

  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refresher: (() => Promise<void>) | null = null;
  #refreshing = false;
  #stopped = false;

  readonly #listeners = new Set<SessionStateListener>();

  constructor(deps: SessionManagerDeps) {
    this.#config = deps.config;
    this.#storage = deps.storage;
    this.#logger = deps.logger.child({ module: "session" });
  }

  /** Current state-machine state. */
  get state(): SessionState {
    return this.#state;
  }

  /** Facebook user id of the authenticated account (`""` before login). */
  get userId(): string {
    return this.#userId;
  }

  /** The authenticated cookie jar. Throws before `prepareLogin()`. */
  get cookies(): CookieStore {
    if (this.#cookies === null) {
      throw new SessionError(
        "No authenticated cookie jar is available yet — call login() first",
        "SESSION_NOT_AUTHENTICATED",
      );
    }
    return this.#cookies;
  }

  /** Whether a cookie jar has been attached. */
  get hasCookies(): boolean {
    return this.#cookies !== null;
  }

  /** The last processed sync sequence id. */
  get lastSeqId(): number | null {
    return this.#lastSeqId;
  }

  /** The server-issued sync token. */
  get syncToken(): string | null {
    return this.#syncToken;
  }

  /** The account's MQTT edge region, when known. */
  get region(): string | null {
    return this.#region;
  }

  /** Whether the MQTT connection is currently established. */
  get connected(): boolean {
    return this.#connected;
  }

  /** A typed, non-sensitive snapshot for `client.getSession()`. */
  getInfo(): SessionInfo {
    return {
      userId: this.#userId,
      state: this.#state,
      connected: this.#connected,
      connectedSince: this.#connectedSince,
      lastSeqId: this.#lastSeqId,
      syncToken: this.#syncToken,
      loginTime: this.#loginTime,
      reconnects: this.#reconnects,
    };
  }

  /** Subscribes to state changes. Returns an unsubscribe function. */
  onChange(listener: SessionStateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Login and persistence
  // -------------------------------------------------------------------------

  /**
   * Parses credentials, validates the required cookies, loads any persisted
   * session, and enters `AUTHENTICATING`.
   *
   * A persisted cookie jar is preferred over the supplied credentials when it
   * belongs to the same account and still passes validation — background
   * refreshes keep it newer than the file most callers pass in. The persisted
   * cursor and region are restored whenever the account matches.
   */
  async prepareLogin(credentials: Credentials): Promise<PreparedLogin> {
    const providedCookies = await parseCredentials(credentials);
    const providedStore = CookieStore.fromCookies(providedCookies);
    const userId = providedStore.requireAuthenticated();

    const persisted = await this.loadPersisted();
    const compatible = persisted !== null && persisted.userId === userId;

    let store = providedStore;
    if (compatible && persisted !== null) {
      const restored = this.#tryRestoreCookies(persisted.cookies, userId);
      if (restored !== null) {
        store = restored;
      }
    }

    this.#cookies = store;
    this.#userId = userId;
    this.#loginTime = compatible && persisted !== null ? persisted.loginTime : Date.now();
    this.#lastSeqId = compatible && persisted !== null ? persisted.lastSeqId : null;
    this.#syncToken = compatible && persisted !== null ? persisted.syncToken : null;
    this.#region = compatible && persisted !== null ? persisted.region : null;
    this.#reconnects = 0;
    this.#connected = false;
    this.#connectedSince = null;
    this.#stopped = false;
    this.#transition("AUTHENTICATING");

    this.#logger.info(
      { userId, restored: compatible, cookieSource: store === providedStore ? "credentials" : "storage" },
      "credentials validated",
    );
    return { userId, restored: compatible, persisted: compatible ? persisted : null };
  }

  /** Attempts to build a valid cookie store from a persisted serialization. */
  #tryRestoreCookies(serialized: SerializedCookieJar, userId: string): CookieStore | null {
    try {
      const store = CookieStore.fromSerialized(serialized);
      if (store.requireAuthenticated() !== userId) {
        return null;
      }
      return store;
    } catch (error) {
      this.#logger.debug(
        { err: error instanceof Error ? error.message : String(error) },
        "persisted cookies are no longer valid; using supplied credentials",
      );
      return null;
    }
  }

  /**
   * Reads the persisted session document. Returns `null` when persistence is
   * disabled or nothing has been saved. Throws `SessionError` when a saved
   * document is present but malformed.
   */
  async loadPersisted(): Promise<PersistedSession | null> {
    if (!this.#config.persistSession) {
      return null;
    }
    let raw: unknown;
    try {
      raw = await this.#storage.get<unknown>(STORAGE_KEYS.session);
    } catch (cause) {
      throw new SessionError("Could not read the persisted session from storage", "SESSION_CORRUPT", {
        cause,
        retryable: true,
      });
    }
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed = persistedSessionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SessionError(
        "The persisted session document is malformed — clear it and log in again",
        "SESSION_CORRUPT",
        { context: { issues: parsed.error.issues.map((issue) => issue.message) } },
      );
    }
    const data = parsed.data;
    return {
      version: PERSISTED_VERSION,
      userId: data.userId,
      loginTime: data.loginTime,
      savedAt: data.savedAt,
      lastSeqId: data.lastSeqId,
      syncToken: data.syncToken,
      region: data.region,
      // The shape was validated structurally; tough-cookie performs the
      // remaining field-level normalization when the jar is constructed.
      cookies: data.cookies as unknown as SerializedCookieJar,
    };
  }

  /** Writes the cookie jar plus current metadata. No-op before login. */
  async persist(): Promise<void> {
    if (!this.#config.persistSession || this.#cookies === null || this.#userId === "") {
      return;
    }
    const document: PersistedSession = {
      version: PERSISTED_VERSION,
      userId: this.#userId,
      loginTime: this.#loginTime,
      savedAt: Date.now(),
      lastSeqId: this.#lastSeqId,
      syncToken: this.#syncToken,
      region: this.#region,
      cookies: this.#cookies.toSerialized(),
    };
    try {
      await this.#storage.set(STORAGE_KEYS.session, document);
    } catch (error) {
      this.#logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to persist the session",
      );
    }
  }

  /** Deletes the persisted session document, if any. */
  async clearPersisted(): Promise<void> {
    try {
      await this.#storage.delete(STORAGE_KEYS.session);
    } catch (error) {
      this.#logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "failed to clear the persisted session",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Cursor and region
  // -------------------------------------------------------------------------

  /** Replaces the sync cursor and remembers it for persistence. */
  setCursor(cursor: SessionCursor): void {
    this.#lastSeqId = cursor.lastSeqId;
    this.#syncToken = cursor.syncToken;
  }

  /** Records the edge region learned from a successful connection. */
  setRegion(region: string | null): void {
    this.#region = region;
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  /** Enters `ACTIVE` on the first successful connection. */
  markConnectionEstablished(): void {
    this.#connected = true;
    this.#connectedSince = Date.now();
    if (this.#state === "AUTHENTICATING") {
      this.#transition("ACTIVE");
    } else if (this.#state === "RECONNECTING") {
      this.#reconnects += 1;
      this.#transition("ACTIVE");
    }
  }

  /** Records a drop and enters `RECONNECTING` from `ACTIVE`. */
  markConnectionLost(): void {
    this.#connected = false;
    this.#connectedSince = null;
    if (this.#state === "ACTIVE") {
      this.#transition("RECONNECTING");
    }
  }

  /** Begins a voluntary shutdown. */
  markClosing(): void {
    this.#connected = false;
    this.#connectedSince = null;
    if (this.#state !== "CLOSED" && this.#state !== "CLOSING") {
      this.#transition("CLOSING");
    }
  }

  /** Finalizes the session. Safe to call repeatedly. */
  markClosed(): void {
    this.#connected = false;
    this.#connectedSince = null;
    if (this.#state !== "CLOSED") {
      this.#transition("CLOSED");
    }
    this.stopCookieRefresh();
  }

  #transition(next: SessionState): void {
    if (this.#state === next) {
      return;
    }
    const allowed = TRANSITIONS[this.#state];
    if (!allowed.includes(next)) {
      throw new SessionError(
        `Invalid session transition ${this.#state} → ${next}`,
        "SESSION_INVALID_STATE",
        { context: { from: this.#state, to: next } },
      );
    }
    this.#state = next;
    const info = this.getInfo();
    for (const listener of [...this.#listeners]) {
      try {
        listener(next, info);
      } catch (error) {
        this.#logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "session state listener threw",
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cookie refresh
  // -------------------------------------------------------------------------

  /**
   * Schedules background cookie refresh. `refresh` must perform one
   * authenticated request so Facebook can rotate `xs`/`datr`; the session is
   * persisted after each successful refresh.
   *
   * Refresh runs only while the state is `ACTIVE`/`RECONNECTING`, at most once
   * per check window.
   */
  startCookieRefresh(refresh: () => Promise<void>): void {
    this.#refresher = refresh;
    this.#stopped = false;
    this.#scheduleRefreshCheck(0);
  }

  /** Cancels the refresh timer. */
  stopCookieRefresh(): void {
    this.#stopped = true;
    this.#refresher = null;
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
  }

  #scheduleRefreshCheck(delayMs: number): void {
    if (this.#stopped || this.#refresher === null) {
      return;
    }
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
    }
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.#runRefreshCheck();
    }, Math.max(0, delayMs));
    // Never keep the process alive just to check cookies.
    this.#refreshTimer.unref?.();
  }

  async #runRefreshCheck(): Promise<void> {
    if (this.#stopped || this.#refresher === null) {
      return;
    }
    const expiry = this.#earliestCookieExpiry();
    const now = Date.now();
    const due = expiry !== null && expiry - now <= COOKIE_REFRESH_LEAD_TIME_MS;

    if (due && !this.#refreshing && (this.#state === "ACTIVE" || this.#state === "RECONNECTING")) {
      this.#refreshing = true;
      const refresher = this.#refresher;
      try {
        await refresher();
        await this.persist();
        this.#logger.info({ expiresAt: expiry }, "refreshed session cookies");
      } catch (error) {
        this.#logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "background cookie refresh failed; will retry",
        );
      } finally {
        this.#refreshing = false;
      }
    }

    this.#scheduleRefreshCheck(this.#nextRefreshDelay());
  }

  /** Earliest expiry of the cookies the refresh targets. */
  #earliestCookieExpiry(): number | null {
    if (this.#cookies === null) {
      return null;
    }
    let earliest: number | null = null;
    for (const name of ["xs", "datr"] as const) {
      const expiry = this.#cookies.getCookieExpiry(name);
      if (expiry !== null && (earliest === null || expiry < earliest)) {
        earliest = expiry;
      }
    }
    return earliest;
  }

  /** Delay until the next periodic check, capped at the check interval. */
  #nextRefreshDelay(): number {
    const expiry = this.#earliestCookieExpiry();
    if (expiry === null) {
      return COOKIE_REFRESH_CHECK_INTERVAL_MS;
    }
    const untilLead = expiry - Date.now() - COOKIE_REFRESH_LEAD_TIME_MS;
    return Math.min(
      COOKIE_REFRESH_CHECK_INTERVAL_MS,
      Math.max(MIN_REFRESH_DELAY_MS, untilLead),
    );
  }
}

/** Re-exported for callers that build a store from normalized cookies. */
export type { NormalizedCookie };
