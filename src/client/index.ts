/**
 * The public Messenger client.
 *
 * One instance owns one account session: configuration, logging, diagnostics,
 * the event emitter, middleware, plugins, the HTTP transport, the MQTT
 * realtime transport, and the delta processor. Methods validate their input
 * with Zod, translate Facebook's many payload shapes into the public models,
 * and throw the typed error hierarchy — background failures (connection
 * drops, parse warnings, reconnect exhaustion) surface as events instead.
 */

import { randomUUID } from "node:crypto";
import {
  BATCH_NAMES,
  CACHE_TAGS,
  CACHE_TTL_SECONDS,
  DOC_IDS,
  FB_BASE_URL,
  FB_LS_APP_ID,
  THREAD_COLORS,
  TOPIC_LS_REQ,
  TOPIC_MARK_THREAD,
} from "../constants.js";
import { DeltaProcessor, type DeltaSink } from "../delta/index.js";
import { asArray, asRecord, toMillis, toNumber } from "../delta/raw.js";
import { DiagnosticsCollector } from "../diagnostics/index.js";
import {
  APIError,
  AuthenticationError,
  LibraryError,
  MQTTError,
  SessionError,
  TimeoutError,
  ValidationError,
} from "../errors/index.js";
import { TypedEmitter } from "../events/index.js";
import { createRootLogger, type Logger } from "../logger/index.js";
import { MiddlewareManager } from "../middleware/index.js";
import { NamespacedCache, LruCache } from "../cache/index.js";
import { FileStorage, MemoryStorage, NamespacedStorage } from "../storage/index.js";
import { SyncEndpoint } from "../sync/index.js";
import { SessionManager } from "../session/index.js";
import {
  computeJazoest,
  HttpTransport,
  type DownloadResponse,
  type FormValue,
} from "../transport/http/index.js";
import { MqttTransport } from "../transport/mqtt/index.js";
import { PluginManager } from "../plugins/index.js";
import { generateOfflineThreadingId } from "../utils/index.js";
import { buildLogMessageForm, buildMessageForm } from "./forms.js";
import { postGraphQL, postGraphQLBatch, postWebGraphQLMutation, type GraphQLBatchResult } from "./graphql.js";
import { resolvePhotoUrl, uploadMedia } from "./media.js";
import {
  safeHomeDiagnostics,
  summarizeHomeDiagnostics,
} from "./home.js";
import {
  messageEventFromNode,
  messageFromEvent,
  normalizeLegacyThread,
  normalizeMessageNode,
  normalizePoll,
  normalizePollOptions,
  normalizeThread,
  normalizeUser,
  normalizeSearchUser,
} from "./models.js";
import {
  assertFileInput,
  parseBoolean,
  parseIdArray,
  parseMessageBody,
  parseMessageContent,
  parseMessageId,
  parseMessageListOptions,
  parseMessageSearchOptions,
  parsePollOptions,
  parseQuery,
  parseReaction,
  parseThreadId,
  parseThreadColor,
  parseThreadListOptions,
  parseThreadName,
  parseUserId,
  parseUserIds,
  resolveReactionEmoji,
} from "./validation.js";
import { resolveConfig, type ResolvedConfig } from "../config/index.js";
import type {
  AttachmentType,
  ClientOptions,
  Credentials,
  DiagnosticsHandle,
  EventListener,
  EventName,
  FileInput,
  LoginResult,
  MediaInfo,
  Message,
  MessageContent,
  MessageListOptions,
  MessageListResult,
  MessageSearchOptions,
  MessageSearchResult,
  MessageSendResult,
  MessageEvent,
  MessageReplyEvent,
  MiddlewareHook,
  MiddlewarePhase,
  MiddlewareRegistrationOptions,
  PollInfo,
  PresenceInfo,
  Reaction,
  SessionInfo,
  StorageAdapter,
  ThreadInfo,
  ThreadListOptions,
  ThreadListResult,
  ThreadUpdateEvent,
  UploadResult,
  UserInfo,
  UserSearchResult,
} from "../types/index.js";

/** How long `login()` waits for the first sync payload before failing. */
const LOGIN_SYNC_TIMEOUT_MS = 30_000;

/** Bounds for the in-memory caches the client keeps for cross-method lookups. */
const MESSAGE_CACHE_LIMIT = 500;
const ATTACHMENT_CACHE_LIMIT = 500;
const THREAD_KIND_CACHE_LIMIT = 500;
const PRESENCE_CACHE_LIMIT = 500;

/** Debounce for persisting the sync cursor. */
const PERSIST_DEBOUNCE_MS = 1_000;

const DEFAULT_THREAD_LIST_LIMIT = 20;
const DEFAULT_MESSAGE_LIST_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 20;

/** Lightweight-service task family versions (verified against live clients). */
const EDIT_TASK_LABEL = "742";
const EDIT_TASK_VERSION = "6903494529735864";
const EDIT_TASK_QUEUE = "edit_message";
const TYPING_TASK_VERSION = "5849951561777440";

/** GraphQL document ids not covered by `DOC_IDS`. */
const GROUP_CREATE_DOC_ID = "577041672419534";
const THREAD_COLOR_DOC_ID = "1727493033983591";

/** Tokens scraped from the authenticated home page. */
interface ScrapedTokens {
  readonly fbDtsg: string;
  readonly lsd: string;
  readonly revision: string | null;
  readonly clientId: string;
  readonly region: string | null;
  readonly irisSeqId: number | null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) {
    return null;
  }
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readId(value: unknown): string | null {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/** Reads a nested array path, returning `undefined` when any step is missing. */
function readNested(value: unknown, path: readonly number[]): unknown {
  let current: unknown = value;
  for (const index of path) {
    if (!Array.isArray(current)) {
      return undefined;
    }
    current = current[index];
  }
  return current;
}

function randomClientId(): string {
  return (Math.floor(Math.random() * 2_147_483_648) >>> 0).toString(16);
}

/** Extracts the MQTT edge region from any of the home page's boot payloads. */
function extractRegion(html: string): string | null {
  const endpoints: string[] = [];
  const oldMatch = html.match(/irisSeqID:"(.+?)",appID:219994525426954,endpoint:"(.+?)"/);
  if (oldMatch?.[2] !== undefined) {
    endpoints.push(oldMatch[2]);
  }
  const newMatch = html.match(/\{"app_id":"219994525426954","endpoint":"(.+?)","iris_seq_id":"(.+?)"\}/);
  if (newMatch?.[1] !== undefined) {
    endpoints.push(newMatch[1].replace(/\\\//g, "/"));
  }
  const legacyMatch = html.match(
    /\["MqttWebConfig",\[\],\{fbid:"(.+?)",appID:219994525426954,endpoint:"(.+?)"/,
  );
  if (legacyMatch?.[2] !== undefined) {
    endpoints.push(legacyMatch[2]);
  }
  for (const endpoint of endpoints) {
    const region = endpoint.match(/region=([a-z0-9]+)/i);
    if (region?.[1] !== undefined) {
      return region[1].toLowerCase();
    }
  }
  const direct = html.match(/"region":"([a-z0-9]{2,4})"/i);
  return direct?.[1]?.toLowerCase() ?? null;
}

/** Extracts the iris sequence id from the home page, when present. */
function extractIrisSeqId(html: string): number | null {
  const patterns = [
    /irisSeqID:"(.+?)",appID:219994525426954/,
    /\{"app_id":"219994525426954","endpoint":".+?","iris_seq_id":"(.+?)"\}/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const value = match?.[1];
    if (value !== undefined) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * Extracts `fb_dtsg` from any of the known boot-payload patterns Facebook
 * has used across different surface generations.
 *
 * Priority order (most-to-least current):
 *   1. `"DTSGInitialData",[],{"token":"…"}` — modern requireLazy SPA format
 *   2. `"DTSGInitData",[],{"token":"…"}`    — older variant (pre-2024)
 *   3. Relaxed scan: `DTSGInit*Data` near `"token"` within 160 chars
 *   4. `fb_dtsg" value="…"`                 — legacy server-rendered form field
 *   5. `"async_get_token":"…"`               — async-loaded variant
 */
function extractFbDtsg(html: string): string | undefined {
  // 1. Modern requireLazy: ["DTSGInitialData",[],"token":"…"}
  let m = html.match(/"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 2. Older key variant
  m = html.match(/"DTSGInitData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 3. Relaxed scan — key anywhere before "token" within 160 chars
  m = html.match(/DTSGInit(?:ial)?Data[^}]{0,160}?"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 4. Server-rendered hidden input (name before value and vice-versa)
  m = html.match(/name="fb_dtsg"\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\s+name="fb_dtsg"/);
  if (m?.[1]) return m[1];
  // 5. async_get_token variant
  m = html.match(/"async_get_token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  return undefined;
}

/**
 * Extracts the `lsd` token from the boot payload.
 * Facebook embeds this in the `requireLazy("LSD", …)` call.
 */
function extractLsd(html: string): string | undefined {
  // 1. requireLazy array — `["LSD",[],{"token":"…"},…]`
  let m = html.match(/\["LSD"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 2. Relaxed scan — "LSD" key near "token" within 80 chars
  m = html.match(/"LSD"[^}]{0,80}?"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 3. Server-rendered hidden input
  m = html.match(/name="lsd"\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\s+name="lsd"/);
  if (m?.[1]) return m[1];
  return undefined;
}

/** Scrapes the session tokens Facebook embeds in `home.php`. */
function scrapeTokens(html: string, userId: string): ScrapedTokens | null {
  const fbDtsg = extractFbDtsg(html);
  const lsd = extractLsd(html);
  if (fbDtsg === undefined || lsd === undefined) {
    return null;
  }
  const revisionMatch = html.match(/"revision":(\d+)/);
  const clientMatch = html.match(/"clientID":"(.*?)"/) ?? html.match(/"client_id":"(.*?)"/);
  return {
    fbDtsg,
    lsd,
    revision: revisionMatch?.[1] ?? null,
    clientId: clientMatch?.[1] !== undefined && clientMatch[1] !== "" ? clientMatch[1] : randomClientId(),
    region: extractRegion(html),
    irisSeqId: extractIrisSeqId(html),
  };
}

/**
 * The Messenger client.
 */
export class MessengerClient {
  readonly #config: ResolvedConfig;
  readonly #logger: Logger;
  readonly #diagnostics: DiagnosticsCollector;
  readonly #emitter: TypedEmitter;
  readonly #middleware: MiddlewareManager;
  readonly #cache: LruCache;
  readonly #storage: StorageAdapter;
  readonly #plugins: PluginManager;
  readonly #pluginsReady: Promise<void>;
  readonly #session: SessionManager;

  #http: HttpTransport | null = null;
  #mqtt: MqttTransport | null = null;
  #delta: DeltaProcessor | null = null;
  #sync: SyncEndpoint | null = null;

  #userId = "";
  #clientId = "";
  #clientMutationId = 0;

  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #persistTimer: ReturnType<typeof setTimeout> | null = null;

  readonly #messages = new Map<string, Message>();
  readonly #messageThread = new Map<string, string>();
  readonly #attachmentUrls = new Map<string, { url: string; kind: AttachmentType }>();
  readonly #threadKinds = new Map<string, boolean>();
  readonly #pollQuestions = new Map<string, string>();
  readonly #presence = new Map<string, PresenceInfo>();
  readonly #mediaCache = new Map<string, MediaInfo>();

  constructor(options: ClientOptions = {}) {
    this.#config = resolveConfig(options);
    this.#logger = createRootLogger({
      level: this.#config.logLevel,
      prettyPrint: this.#config.prettyPrint,
      logFile: this.#config.logFile,
      transports: this.#config.logTransports,
    });
    this.#diagnostics = new DiagnosticsCollector();
    this.#emitter = new TypedEmitter({
      onEmit: (event) => {
        this.#diagnostics.recordEvent(event);
      },
      onListenerError: (event, error) => {
        this.#handleListenerError(event, error);
      },
    });
    this.#middleware = new MiddlewareManager();
    this.#cache = new LruCache(this.#config.cacheMaxItems);
    this.#storage = this.#createStorage(this.#config);
    this.#plugins = new PluginManager({
      logger: this.#logger.child({ module: "plugins" }),
      emitter: this.#emitter,
      middleware: this.#middleware,
      cacheFactory: (name) => new NamespacedCache(this.#cache, `plugin:${name}`),
      storageFactory: (name) => new NamespacedStorage(this.#storage, `plugin:${name}`),
    });
    this.#session = new SessionManager({
      config: this.#config,
      storage: this.#storage,
      logger: this.#logger,
    });

    const registrations = options.plugins ?? [];
    const plugins = this.#plugins;
    this.#pluginsReady = (async () => {
      for (const registration of registrations) {
        await plugins.register(registration);
      }
    })();
    // The promise is awaited by login(); this branch only marks the rejection
    // as handled so constructing a client without logging in stays quiet.
    void this.#pluginsReady.catch(() => undefined);
  }

  /** Registers a middleware hook. */
  use(phase: MiddlewarePhase, hook: MiddlewareHook, options?: MiddlewareRegistrationOptions | undefined): void {
    this.#middleware.register(phase, hook, options ?? {}, "user", "user");
  }

  /** Registers a typed event listener; returns an unsubscribe function. */
  on<E extends EventName>(event: E, listener: EventListener<E>): () => void {
    return this.#emitter.on(event, listener);
  }

  /** Registers a one-shot listener; returns an unsubscribe function. */
  once<E extends EventName>(event: E, listener: EventListener<E>): () => void {
    return this.#emitter.once(event, listener);
  }

  /** Removes a previously registered listener. */
  off<E extends EventName>(event: E, listener: EventListener<E>): boolean {
    return this.#emitter.off(event, listener);
  }

  /** Removes every listener for one event, or all listeners when omitted. */
  removeAll(event?: EventName | undefined): void {
    this.#emitter.removeAll(event);
  }

  /** Number of listeners registered for an event. */
  listenerCount(event: EventName): number {
    return this.#emitter.listenerCount(event);
  }

  /** The diagnostics handle. */
  get diagnostics(): DiagnosticsHandle {
    return this.#diagnostics;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Authenticates with the given credentials, builds the transports, and
   * resolves once the realtime connection is up.
   */
  async login(credentials: Credentials): Promise<LoginResult> {
    await this.#pluginsReady;
    const state = this.#session.state;
    if (state === "AUTHENTICATING" || state === "ACTIVE" || state === "RECONNECTING" || state === "CLOSING") {
      throw new SessionError(`Cannot log in while the session is ${state}`, "SESSION_INVALID_STATE", {
        context: { state },
      });
    }

    const prepared = await this.#session.prepareLogin(credentials);
    this.#userId = prepared.userId;

    const http = new HttpTransport({
      config: this.#config,
      cookies: this.#session.cookies,
      middleware: this.#middleware,
      diagnostics: this.#diagnostics,
      logger: this.#logger,
    });
    this.#http = http;

    const tokens = await this.#scrapeTokens(http);
    this.#applyTokens(tokens);
    this.#debug("login", "session tokens scraped", { region: this.#session.region });
    if (this.#config.validateOnLogin) {
      await this.#validateSession(http);
    }
    await this.#reconnectPresence(http);

    this.#emitter.emitAndForget("login", {
      type: "login",
      timestamp: Date.now(),
      userId: prepared.userId,
    });

    const sync = new SyncEndpoint({ http, userId: prepared.userId, logger: this.#logger });
    this.#sync = sync;

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.#readyResolve = resolveReady;
    this.#readyReject = rejectReady;

    const timeout = setTimeout(() => {
      this.#readyReject?.(
        new TimeoutError("Timed out waiting for the Messenger realtime connection", {
          retryable: true,
          context: { operation: "login" },
        }),
      );
    }, LOGIN_SYNC_TIMEOUT_MS);
    timeout.unref?.();

    const mqtt = new MqttTransport({
      config: this.#config,
      cookies: this.#session.cookies,
      diagnostics: this.#diagnostics,
      logger: this.#logger,
      userID: prepared.userId,
      region: this.#session.region ?? undefined,
      chatOn: true,
      initialCursor: {
        lastSeqId: this.#session.lastSeqId,
        syncToken: this.#session.syncToken,
      },
      refetchLastSeqId: () => sync.fetchSequenceId(),
      callbacks: {
        onMessage: (topic, payload) => {
          this.#handleMessage(topic, payload);
        },
        onSyncEstablished: (info) => {
          this.#session.markConnectionEstablished();
          void this.#session.persist();
          if (info.reconnect) {
            this.#emitter.emitAndForget("reconnect", {
              type: "reconnect",
              timestamp: Date.now(),
              attempt: info.attempt,
              drained: info.drained,
            });
            return;
          }
          this.#readyResolve?.();
          this.#debug("login", "realtime connection ready", {});
          this.#emitter.emitAndForget("ready", {
            type: "ready",
            timestamp: Date.now(),
            userId: prepared.userId,
          });
        },
        onConnectionLost: (info) => {
          this.#session.markConnectionLost();
          this.#emitter.emitAndForget("warning", {
            type: "warning",
            timestamp: Date.now(),
            message: `realtime connection lost (${info.reason}); retrying`,
            context: { attempt: info.attempt, delayMs: info.delayMs },
          });
        },
        onReconnectExhausted: (info) => {
          this.#emitter.emitAndForget("disconnect", {
            type: "disconnect",
            timestamp: Date.now(),
            reason: info.reason,
            attempts: info.attempts,
          });
          this.#emitter.emitAndForget("warning", {
            type: "warning",
            timestamp: Date.now(),
            message: `realtime reconnection gave up: ${info.reason}`,
            context: { attempts: info.attempts },
          });
        },
        onSyncUpdate: (cursor) => {
          this.#session.setCursor(cursor);
          this.#persistSoon();
        },
        onWarning: (message, context) => {
          this.#emitter.emitAndForget("warning", {
            type: "warning",
            timestamp: Date.now(),
            message,
            context,
          });
        },
      },
    });
    this.#mqtt = mqtt;
    this.#delta = new DeltaProcessor({
      selfUserId: prepared.userId,
      logger: this.#logger,
      sink: this.#createSink(),
      forcedFetch: (threadId, messageId) => this.#handleForcedFetch(threadId, messageId),
    });

    try {
      await mqtt.connect();
      await ready;
    } finally {
      clearTimeout(timeout);
      this.#readyResolve = null;
      this.#readyReject = null;
    }

    await this.#session.persist();
    this.#session.startCookieRefresh(async () => {
      await this.#refreshCookies();
    });

    return { userId: prepared.userId, restored: prepared.restored };
  }

  /** Ends the session and closes both transports. */
  async logout(): Promise<void> {
    const userId = this.#session.userId;
    const state = this.#session.state;

    this.#readyReject?.(
      new SessionError("Logged out before the realtime connection was established", "SESSION_NOT_AUTHENTICATED"),
    );
    this.#readyResolve = null;
    this.#readyReject = null;

    if (state === "AUTHENTICATING") {
      this.#session.markClosed();
    } else if (state !== "UNINITIALIZED" && state !== "CLOSED") {
      this.#session.markClosing();
    }

    const mqtt = this.#mqtt;
    this.#mqtt = null;
    this.#delta = null;
    this.#sync = null;
    if (mqtt !== null) {
      try {
        await mqtt.close();
      } catch (error) {
        this.#logger.warn({ err: errorMessage(error) }, "MQTT close failed during logout");
      }
    }

    const http = this.#http;
    this.#http = null;
    if (http !== null) {
      try {
        await http.close();
      } catch (error) {
        this.#logger.warn({ err: errorMessage(error) }, "HTTP close failed during logout");
      }
    }

    if (state !== "UNINITIALIZED" && state !== "CLOSED") {
      this.#session.markClosed();
    }
    await this.#session.clearPersisted();
    this.#clearSessionCaches();
    this.#userId = "";

    this.#emitter.emitAndForget("logout", {
      type: "logout",
      timestamp: Date.now(),
      userId,
      reason: "user",
    });
  }

  /** Non-sensitive session metadata. */
  getSession(): SessionInfo {
    return this.#session.getInfo();
  }

  /** Whether the realtime connection is currently established. */
  isConnected(): boolean {
    return this.#session.connected;
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /** Sends text, a sticker, a GIF, or a previously uploaded attachment. */
  async sendMessage(threadId: string, content: MessageContent): Promise<MessageSendResult> {
    const targetThreadId = parseThreadId(threadId);
    const parsed = parseMessageContent(content);
    return this.#send(targetThreadId, parsed);
  }

  /** Replies to a specific message. */
  async sendReply(threadId: string, messageId: string, content: MessageContent): Promise<MessageSendResult> {
    const targetThreadId = parseThreadId(threadId);
    const replyToMessageId = parseMessageId(messageId);
    const parsed = parseMessageContent(content);
    return this.#send(targetThreadId, parsed, replyToMessageId);
  }

  /** Uploads a file and sends it as an attachment. */
  async sendAttachment(threadId: string, file: FileInput): Promise<MessageSendResult> {
    assertFileInput(file);
    const targetThreadId = parseThreadId(threadId);
    const info = await this.#upload(file);
    return this.#send(targetThreadId, { type: "attachment", attachmentId: info.attachmentId });
  }

  /** Sends a sticker by id. */
  async sendSticker(threadId: string, stickerId: string): Promise<MessageSendResult> {
    const targetThreadId = parseThreadId(threadId);
    const id = parseMessageId(stickerId);
    return this.#send(targetThreadId, { type: "sticker", stickerId: id });
  }

  /** Edits a message you sent, over the lightweight-service task channel. */
  async editMessage(messageId: string, newBody: string): Promise<void> {
    const id = parseMessageId(messageId);
    const body = parseMessageBody(newBody);
    const mqtt = this.#requireMqtt();
    const result = await mqtt.lsRequest({
      label: EDIT_TASK_LABEL,
      payload: { message_id: id, text: body },
      queueName: EDIT_TASK_QUEUE,
      versionId: EDIT_TASK_VERSION,
    });
    const errors = asArray(asRecord(result)?.["errors"]);
    if (errors.length > 0) {
      throw new APIError("Facebook rejected the message edit", "API_ERROR", {
        retryable: false,
        context: { messageId: id },
      });
    }
    // The task response echoes the edited text; a mismatch means Facebook
    // rejected the edit (too old, or the message is not yours).
    const replacement = readNested(asRecord(result)?.["step"], [1, 2, 2, 1, 4]);
    if (typeof replacement === "string" && replacement !== body) {
      throw new APIError(
        "Facebook rejected the message edit — the message may be too old or not sent by you",
        "API_ERROR",
        { retryable: false, context: { messageId: id, expected: body, received: replacement } },
      );
    }
  }

  /** Unsends (deletes) a message. */
  async unsendMessage(messageId: string): Promise<void> {
    const id = parseMessageId(messageId);
    await this.#postForm("unsendMessage", `${FB_BASE_URL}/messaging/unsend_message/`, { message_id: id });
    this.#messages.delete(id);
    this.#messageThread.delete(id);
  }

  /** Forwards every attachment of a cached message to another thread. */
  async forwardMessage(messageId: string, targetThreadId: string): Promise<void> {
    const id = parseMessageId(messageId);
    const target = parseThreadId(targetThreadId);
    const message = this.#messages.get(id);
    if (message === undefined) {
      throw new ValidationError(
        "forwardMessage needs the message in the local cache — call getMessages() first",
        { context: { messageId: id } },
      );
    }
    if (message.attachments.length === 0) {
      throw new ValidationError("the message has no attachments to forward", {
        context: { messageId: id },
      });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    for (const [index, attachment] of message.attachments.entries()) {
      const form: Record<string, FormValue> = { attachment_id: attachment.id };
      form[`recipient_map[${timestamp + index}]`] = target;
      const json = await this.#postForm("forwardMessage", `${FB_BASE_URL}/mercury/attachments/forward/`, form);
      const payload = asRecord(asRecord(json)?.["payload"]);
      if (payload !== null && payload["success"] === false) {
        throw new APIError("Facebook rejected the attachment forward", "API_ERROR", {
          retryable: false,
          context: { messageId: id, attachmentId: attachment.id },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  /** Adds a reaction to a message. */
  async addReaction(messageId: string, reaction: Reaction): Promise<void> {
    const id = parseMessageId(messageId);
    const emoji = resolveReactionEmoji(parseReaction(reaction));
    await this.#mutateReaction(id, "ADD_REACTION", emoji);
  }

  /** Removes your reaction from a message. */
  async removeReaction(messageId: string): Promise<void> {
    const id = parseMessageId(messageId);
    await this.#mutateReaction(id, "REMOVE_REACTION", "");
  }

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  /** Downloads an attachment into memory. */
  async downloadAttachment(attachmentId: string): Promise<Buffer> {
    const id = parseMessageId(attachmentId);
    const url = await this.#resolveAttachmentUrl(id);
    const response = await this.#requireHttp().stream("downloadAttachment", url);
    const chunks: Buffer[] = [];
    const iterable = response.stream as AsyncIterable<unknown>;
    for await (const chunk of iterable) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  /** Streams an attachment without buffering it. */
  async streamAttachment(attachmentId: string): Promise<DownloadResponse> {
    const id = parseMessageId(attachmentId);
    const url = await this.#resolveAttachmentUrl(id);
    return this.#requireHttp().stream("streamAttachment", url);
  }

  /** Uploads a file to Facebook's CDN. */
  async uploadMedia(file: FileInput): Promise<UploadResult> {
    assertFileInput(file);
    return this.#upload(file);
  }

  /** Returns metadata for a previously uploaded file. */
  async getMediaInfo(mediaId: string): Promise<MediaInfo> {
    const id = parseMessageId(mediaId);
    const cached = this.#mediaCache.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const stored = await this.#cache.get<MediaInfo>(`media:${id}`);
    if (stored !== null) {
      return stored;
    }
    throw new APIError(`No uploaded media metadata is stored for "${id}"`, "MEDIA_NOT_FOUND", {
      retryable: false,
      context: { mediaId: id },
    });
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  /** Fetches one thread's metadata. */
  async getThread(threadId: string): Promise<ThreadInfo> {
    const id = parseThreadId(threadId);
    const batch = await this.#batch("getThread", {
      o0: {
        doc_id: DOC_IDS.threadInfo,
        query_params: {
          id,
          message_limit: 0,
          load_messages: false,
          load_read_receipts: false,
          before: null,
        },
      },
    });
    const raw = asRecord(batch.data?.["message_thread"]) ?? batch.data;
    const info = normalizeThread(raw);
    if (info === null) {
      throw new APIError(`Facebook returned no thread metadata for "${id}"`, "API_ERROR", {
        retryable: false,
        context: { threadId: id },
      });
    }
    this.#threadKinds.set(info.id, info.isGroup);
    return info;
  }

  /** Lists inbox threads, newest first. */
  async getThreadList(options?: ThreadListOptions | undefined): Promise<ThreadListResult> {
    const opts = parseThreadListOptions(options);
    const limit = opts.limit ?? DEFAULT_THREAD_LIST_LIMIT;
    const tags = opts.tags ?? ["INBOX"];
    let before: number | null = null;
    if (opts.cursor !== undefined) {
      const parsed = Number(opts.cursor);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new ValidationError("cursor must be a non-negative epoch-milliseconds value", {
          context: { cursor: opts.cursor },
        });
      }
      before = parsed;
    }

    const batch = await this.#batch(
      "getThreadList",
      {
        o0: {
          doc_id: DOC_IDS.threadList,
          query_params: {
            limit: limit + (before !== null ? 2 : 1),
            before,
            tags,
            includeDeliveryReceipts: true,
            includeSeqID: false,
          },
        },
      },
      BATCH_NAMES.threadList,
    );

    const viewer = asRecord(batch.data?.["viewer"]);
    const connection = asRecord(viewer?.["message_threads"]);
    const rawNodes = [...asArray(connection?.["nodes"])];
    if (before !== null && rawNodes.length > 0) {
      rawNodes.shift();
    }
    const pageInfo = asRecord(connection?.["page_info"]);
    const hasMore = pageInfo?.["has_next_page"] === true || rawNodes.length > limit;
    const pageNodes = hasMore ? rawNodes.slice(0, limit) : rawNodes;

    const threads: ThreadInfo[] = [];
    for (const node of pageNodes) {
      const info = normalizeThread(node);
      if (info !== null) {
        threads.push(info);
        this.#threadKinds.set(info.id, info.isGroup);
      }
    }

    let cursor: string | null = null;
    const endCursor = readString(pageInfo, "end_cursor");
    if (endCursor !== null && /^\d+$/.test(endCursor)) {
      cursor = endCursor;
    } else if (hasMore && pageNodes.length > 0) {
      const lastRaw = asRecord(pageNodes[pageNodes.length - 1]);
      const updated = readId(lastRaw?.["updated_time_precise"]);
      cursor = updated;
    }

    return { threads, cursor, hasMore };
  }

  /** Fetches one page of message history, newest first. */
  async getMessages(threadId: string, options?: MessageListOptions | undefined): Promise<MessageListResult> {
    const id = parseThreadId(threadId);
    const opts = parseMessageListOptions(options);
    const limit = opts.limit ?? DEFAULT_MESSAGE_LIST_LIMIT;
    const before = opts.before ?? null;

    const batch = await this.#batch("getMessages", {
      o0: {
        doc_id: DOC_IDS.threadHistory,
        query_params: {
          id,
          message_limit: limit,
          load_messages: 1,
          load_read_receipts: false,
          before,
        },
      },
    });

    const thread = asRecord(batch.data?.["message_thread"]);
    if (thread === null) {
      throw new APIError(`Facebook returned no message thread for "${id}"`, "API_ERROR", {
        retryable: false,
        context: { threadId: id },
      });
    }
    const key = asRecord(thread["thread_key"]);
    const resolvedThreadId = readId(key?.["thread_fbid"]) ?? readId(key?.["other_user_id"]) ?? id;
    const connection = asRecord(thread["messages"]);
    const nodes = asArray(connection?.["nodes"]);
    const pageInfo = asRecord(connection?.["page_info"]);
    const hasMore = pageInfo?.["has_next_page"] === true || nodes.length >= limit;

    const messages: Message[] = [];
    for (const node of nodes) {
      const message = normalizeMessageNode(node, resolvedThreadId, this.#requireUserId());
      if (message !== null) {
        messages.push(message);
        this.#cacheMessage(message);
      }
    }
    if (key?.["thread_fbid"] !== undefined) {
      this.#threadKinds.set(resolvedThreadId, true);
    }

    return { messages, hasMore };
  }

  /** Mutes notifications for a thread. */
  async muteThread(threadId: string): Promise<void> {
    await this.#setMute(threadId, "-1");
  }

  /** Unmutes notifications for a thread. */
  async unmuteThread(threadId: string): Promise<void> {
    await this.#setMute(threadId, "0");
  }

  /** Archives a thread. */
  async archiveThread(threadId: string): Promise<void> {
    await this.#setArchived(threadId, true);
  }

  /** Unarchives a thread. */
  async unarchiveThread(threadId: string): Promise<void> {
    await this.#setArchived(threadId, false);
  }

  /** Deletes a thread. */
  async deleteThread(threadId: string): Promise<void> {
    const id = parseThreadId(threadId);
    await this.#postForm("deleteThread", `${FB_BASE_URL}/ajax/mercury/delete_thread.php`, {
      client: "mercury",
      "ids[0]": id,
    });
    this.#threadKinds.delete(id);
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  /** Creates a group thread with at least two other participants. */
  async createGroup(userIds: readonly string[], name?: string | undefined): Promise<string> {
    const ids = parseUserIds(userIds);
    const groupName = name === undefined ? null : parseThreadName(name);
    const userId = this.#requireUserId();
    const participants = ids.map((id) => ({ fbid: id }));
    participants.push({ fbid: userId });

    const json = await postGraphQL(this.#requireHttp(), "createGroup", {
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "MessengerGroupCreateMutation",
      doc_id: GROUP_CREATE_DOC_ID,
      variables: JSON.stringify({
        input: {
          entry_point: "jewel_new_group",
          actor_id: userId,
          participants,
          client_mutation_id: String(Math.round(Math.random() * 1024)),
          thread_settings: {
            name: groupName,
            joinable_mode: "PRIVATE",
            thread_image_fbid: null,
          },
        },
      }),
    });

    const data = asRecord(asRecord(json)?.["data"]);
    const created = asRecord(asRecord(asRecord(data?.["messenger_group_thread_create"])?.["thread"])?.["thread_key"]);
    const threadId = readId(created?.["thread_fbid"]);
    if (threadId === null) {
      throw new APIError("Facebook did not return the new group thread id", "API_ERROR", {
        retryable: false,
        context: { operation: "createGroup" },
      });
    }
    this.#threadKinds.set(threadId, true);
    return threadId;
  }

  /** Adds a participant to a group thread. */
  async addParticipant(threadId: string, userId: string): Promise<void> {
    const id = parseThreadId(threadId);
    const participantId = parseUserId(userId);
    const form = buildLogMessageForm({
      userId: this.#requireUserId(),
      clientId: this.#clientId,
      threadId: id,
      logMessageType: "log:subscribe",
      extra: { "log_message_data[added_participants][0]": `fbid:${participantId}` },
      threadIdField: "",
    });
    await this.#postForm("addParticipant", `${FB_BASE_URL}/messaging/send/`, form);
  }

  /** Removes a participant from a group thread. */
  async removeParticipant(threadId: string, userId: string): Promise<void> {
    const id = parseThreadId(threadId);
    const participantId = parseUserId(userId);
    await this.#postForm("removeParticipant", `${FB_BASE_URL}/chat/remove_participants`, {
      uid: participantId,
      tid: id,
    });
  }

  /** Renames a group thread. */
  async changeGroupName(threadId: string, name: string): Promise<void> {
    const id = parseThreadId(threadId);
    const parsed = parseThreadName(name);
    const form = buildLogMessageForm({
      userId: this.#requireUserId(),
      clientId: this.#clientId,
      threadId: id,
      logMessageType: "log:thread-name",
      extra: { thread_name: parsed, thread_id: id },
    });
    await this.#postForm("changeGroupName", `${FB_BASE_URL}/messaging/set_thread_name/`, form);
  }

  /** Changes a group thread's photo. */
  async changeGroupPhoto(threadId: string, file: FileInput): Promise<void> {
    assertFileInput(file);
    const id = parseThreadId(threadId);
    const info = await this.#upload(file);
    const form = buildLogMessageForm({
      userId: this.#requireUserId(),
      clientId: this.#clientId,
      threadId: id,
      logMessageType: "log:thread-image",
      extra: { thread_image_id: info.attachmentId, thread_id: id },
    });
    await this.#postForm("changeGroupPhoto", `${FB_BASE_URL}/messaging/set_thread_image/`, form);
  }

  /** Changes a group thread's emoji. */
  async changeGroupEmoji(threadId: string, emoji: string): Promise<void> {
    const id = parseThreadId(threadId);
    const value = parseQuery(emoji);
    await this.#postForm(
      "changeGroupEmoji",
      `${FB_BASE_URL}/messaging/save_thread_emoji/?source=thread_settings&__pc=EXP1%3Amessengerdotcom_pkg`,
      { emoji_choice: value, thread_or_other_fbid: id },
    );
  }

  /** Changes a group thread's color theme. */
  async changeGroupTheme(threadId: string, color: string): Promise<void> {
    const id = parseThreadId(threadId);
    const raw = parseThreadColor(color);
    const named =
      THREAD_COLORS[raw as keyof typeof THREAD_COLORS] ??
      Object.entries(THREAD_COLORS).find(([name]) => name.toLowerCase() === raw.toLowerCase())?.[1];
    let themeId: string;
    if (named !== undefined) {
      themeId = named;
    } else {
      const lowered = raw.toLowerCase();
      if (!/^[0-9a-f]{6}$/.test(lowered)) {
        throw new ValidationError("color must be a THREAD_COLORS name or a 6-digit hex value", {
          context: { color: raw },
        });
      }
      themeId = lowered;
    }

    await this.#batch("changeGroupTheme", {
      dpr: 1,
      queries: JSON.stringify({
        o0: {
          doc_id: THREAD_COLOR_DOC_ID,
          query_params: {
            data: {
              actor_id: this.#requireUserId(),
              client_mutation_id: "0",
              source: "SETTINGS",
              theme_id: themeId,
              thread_id: id,
            },
          },
        },
      }),
    });
  }

  /** Promotes or demotes a group admin. */
  async changeAdminStatus(threadId: string, userId: string, isAdmin: boolean): Promise<void> {
    const id = parseThreadId(threadId);
    const participantId = parseUserId(userId);
    const admin = parseBoolean(isAdmin, "isAdmin");
    await this.#postForm("changeAdminStatus", `${FB_BASE_URL}/messaging/save_admins/?dpr=1`, {
      thread_fbid: id,
      "admin_ids[0]": participantId,
      add: admin,
    });
  }

  /** Sets or clears a participant's nickname. */
  async changeNickname(threadId: string, userId: string, nickname: string): Promise<void> {
    const id = parseThreadId(threadId);
    const participantId = parseUserId(userId);
    if (typeof nickname !== "string" || nickname.length > 500) {
      throw new ValidationError("nickname must be a string of at most 500 characters", {
        context: { nicknameLength: typeof nickname === "string" ? nickname.length : 0 },
      });
    }
    await this.#postForm(
      "changeNickname",
      `${FB_BASE_URL}/messaging/save_thread_nickname/?source=thread_settings&dpr=1`,
      { nickname, participant_id: participantId, thread_or_other_fbid: id },
    );
  }

  // -------------------------------------------------------------------------
  // Users and search
  // -------------------------------------------------------------------------

  /** The authenticated account's profile. */
  async getMe(): Promise<UserInfo> {
    return this.getUser(this.#requireUserId());
  }

  /** Fetches one user's profile. */
  async getUser(userId: string): Promise<UserInfo> {
    const id = parseUserId(userId);
    const json = await this.#postForm("getUser", `${FB_BASE_URL}/chat/user_info/`, { "ids[0]": id });
    const payload = asRecord(json);
    const profiles = asRecord(asRecord(payload?.["payload"])?.["profiles"]);
    if (profiles === null) {
      throw new APIError("Facebook returned no profiles payload", "API_ERROR", {
        retryable: false,
        context: { userId: id },
      });
    }
    const raw = asRecord(profiles[id]);
    const info = normalizeUser(raw, id);
    if (info === null) {
      throw new APIError(`Facebook returned no profile for "${id}"`, "API_ERROR", {
        retryable: false,
        context: { userId: id },
      });
    }
    return info;
  }

  /** Searches contacts by name. */
  async searchUsers(query: string): Promise<readonly UserSearchResult[]> {
    const value = parseQuery(query);
    const userId = this.#requireUserId();
    const http = this.#requireHttp();
    const response = await http.get("searchUsers", `${FB_BASE_URL}/ajax/typeahead/search.php`, {
      query: {
        value: value.toLowerCase(),
        viewer: userId,
        rsp: "search",
        context: "search",
        path: "/home.php",
        request_id: randomUUID(),
      },
    });
    const json = http.check("searchUsers", response);
    const payload = asRecord(json);
    const entries = asArray(asRecord(payload?.["payload"])?.["entries"]);
    const results: UserSearchResult[] = [];
    for (const entry of entries) {
      const result = normalizeSearchUser(entry);
      if (result !== null) {
        results.push(result);
      }
    }
    return results;
  }

  /** Lists the authenticated account's friends. */
  async getFriendList(): Promise<readonly UserInfo[]> {
    const userId = this.#requireUserId();
    const http = this.#requireHttp();
    const response = await http.postForm("getFriendList", `${FB_BASE_URL}/chat/user_info_all`, {}, {
      query: { viewer: userId },
    });
    const json = http.check("getFriendList", response);
    const payload = asRecord(asRecord(json)?.["payload"]) ?? asRecord(json);
    if (payload === null) {
      throw new APIError("Facebook returned no friend list payload", "API_ERROR", {
        retryable: false,
        context: { operation: "getFriendList" },
      });
    }
    const friends: UserInfo[] = [];
    for (const [id, raw] of Object.entries(payload)) {
      const info = normalizeUser(raw, id);
      if (info !== null) {
        friends.push(info);
      }
    }
    return friends;
  }

  /** Searches threads by name. */
  async searchThreads(query: string): Promise<readonly ThreadInfo[]> {
    const value = parseQuery(query);
    const json = await this.#postForm("searchThreads", `${FB_BASE_URL}/ajax/mercury/search_threads.php`, {
      client: "web_messenger",
      query: value,
      offset: 0,
      limit: 21,
      index: "fbid",
    });
    const payload = asRecord(json);
    const mercury = asRecord(asRecord(payload?.["payload"])?.["mercury_payload"]);
    const threads = mercury?.["threads"];
    const results: ThreadInfo[] = [];
    for (const entry of asArray(threads)) {
      const info = normalizeLegacyThread(entry);
      if (info !== null) {
        results.push(info);
        this.#threadKinds.set(info.id, info.isGroup);
      }
    }
    return results;
  }

  /** Searches message snippets across threads. */
  async searchMessages(query: string, options?: MessageSearchOptions | undefined): Promise<readonly MessageSearchResult[]> {
    const value = parseQuery(query);
    const opts = parseMessageSearchOptions(options);
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;

    const json = await this.#postForm("searchMessages", `${FB_BASE_URL}/ajax/mercury/search_snippets.php?dpr=1`, {
      query: value,
      offset: 0,
      limit,
    });
    const payload = asRecord(asRecord(json)?.["payload"]) ?? asRecord(json);
    const threadNodes = asArray(asRecord(payload?.["graphql_payload"])?.["message_threads"]);

    const results: MessageSearchResult[] = [];
    for (const node of threadNodes) {
      if (results.length >= limit) {
        break;
      }
      const record = asRecord(node);
      const key = asRecord(record?.["thread_key"]);
      const threadId = readId(key?.["thread_fbid"]) ?? readId(key?.["other_user_id"]);
      if (threadId === null) {
        continue;
      }

      const perThread = await this.#postForm(
        "searchMessages",
        `${FB_BASE_URL}/ajax/mercury/search_snippets.php?dpr=1`,
        {
          query: value,
          snippetOffset: 0,
          snippetLimit: limit - results.length,
          identifier: "thread_fbid",
          thread_fbid: threadId,
        },
      );
      const perThreadPayload = asRecord(asRecord(perThread)?.["payload"]) ?? asRecord(perThread);
      const threadSnippets = asRecord(asRecord(perThreadPayload?.["search_snippets"])?.[value]);
      const list = asArray(asRecord(threadSnippets?.[threadId])?.["snippets"]);
      for (const entry of list) {
        if (results.length >= limit) {
          break;
        }
        const snippet = asRecord(entry);
        const messageId = readId(snippet?.["message_id"]);
        if (messageId === null) {
          continue;
        }
        const author = readString(snippet, "author") ?? "";
        results.push({
          messageId,
          threadId,
          senderId: author.startsWith("fbid:") ? author.slice("fbid:".length) : author,
          body: readString(snippet, "body"),
          timestamp: toMillis(snippet?.["timestamp"]) ?? Date.now(),
        });
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Polls
  // -------------------------------------------------------------------------

  /** Creates a poll in a thread. */
  async createPoll(threadId: string, question: string, options: readonly string[]): Promise<void> {
    const id = parseThreadId(threadId);
    const text = parseQuery(question);
    const parsed = parsePollOptions(options);
    const form: Record<string, FormValue> = {
      target_id: id,
      question_text: text,
    };
    parsed.forEach((option, index) => {
      form[`option_text_array[${index}]`] = option;
      form[`option_is_selected_array[${index}]`] = "0";
    });
    const json = await this.#postForm(
      "createPoll",
      `${FB_BASE_URL}/messaging/group_polling/create_poll/?dpr=1`,
      form,
    );
    const status = readString(asRecord(asRecord(json)?.["payload"]), "status");
    if (status !== "success") {
      throw new APIError("Facebook did not create the poll", "API_ERROR", {
        retryable: false,
        context: { threadId: id, question: text },
      });
    }
  }

  /** Votes for one or more poll options. */
  async votePoll(pollId: string, optionIds: readonly string[]): Promise<void> {
    const id = parseMessageId(pollId);
    const ids = parseIdArray(optionIds, "optionIds");
    const form: Record<string, FormValue> = { question_id: id };
    ids.forEach((optionId, index) => {
      form[`selected_options[${index}]`] = optionId;
    });
    const json = await this.#postForm(
      "votePoll",
      `${FB_BASE_URL}/messaging/group_polling/update_vote/?dpr=1`,
      form,
    );
    const status = readString(asRecord(asRecord(json)?.["payload"]), "status");
    if (status !== "success") {
      throw new APIError("Facebook did not record the poll vote", "API_ERROR", {
        retryable: false,
        context: { pollId: id },
      });
    }
  }

  /** Returns the current state of a poll. */
  async getPoll(pollId: string): Promise<PollInfo> {
    const id = parseMessageId(pollId);
    const json = await this.#postForm("getPoll", `${FB_BASE_URL}/ajax/mercury/get_poll_options`, {
      question_id: id,
    });
    const payload = asRecord(json)?.["payload"] ?? json;
    const options = normalizePollOptions(payload);
    return normalizePoll(id, options, this.#pollQuestions.get(id) ?? null);
  }

  // -------------------------------------------------------------------------
  // Presence and receipts
  // -------------------------------------------------------------------------

  /** Shows or hides the typing indicator in a thread. */
  async setTyping(threadId: string, isTyping: boolean): Promise<void> {
    const id = parseThreadId(threadId);
    const typing = parseBoolean(isTyping, "isTyping");
    const mqtt = this.#requireMqtt();
    const isGroup = await this.#isGroupThread(id);
    const content = {
      app_id: Number(FB_LS_APP_ID),
      payload: JSON.stringify({
        label: 3,
        payload: JSON.stringify({
          thread_key: id,
          is_group_thread: isGroup ? 1 : 0,
          is_typing: typing ? 1 : 0,
          attribution: 0,
        }),
        version: Number(TYPING_TASK_VERSION),
      }),
      request_id: 1,
      type: 4,
    };
    await mqtt.publish(TOPIC_LS_REQ, JSON.stringify(content), { qos: 1, retain: false });
  }

  /** Marks a thread as read over MQTT. */
  async markAsRead(threadId: string): Promise<void> {
    const id = parseThreadId(threadId);
    const mqtt = this.#requireMqtt();
    await mqtt.publish(
      TOPIC_MARK_THREAD,
      JSON.stringify({ threadID: id, mark: "read", state: true }),
      { qos: 1, retain: false },
    );
  }

  /** Marks a message as delivered. */
  async markAsDelivered(messageId: string): Promise<void> {
    const id = parseMessageId(messageId);
    const targetThreadId = this.#messageThread.get(id);
    if (targetThreadId === undefined) {
      throw new ValidationError(
        "markAsDelivered needs the message's thread — call getMessages() or wait for a live event first",
        { context: { messageId: id } },
      );
    }
    await this.#postForm("markAsDelivered", `${FB_BASE_URL}/ajax/mercury/delivery_receipts.php`, {
      "message_ids[0]": id,
      [`thread_ids[${targetThreadId}][0]`]: id,
    });
  }

  /** Returns a user's presence, or `unknown` when it has never been observed. */
  async getPresence(userId: string): Promise<PresenceInfo> {
    const id = parseUserId(userId);
    const cached = this.#presence.get(id);
    if (cached !== undefined) {
      return cached;
    }
    return { userId: id, status: "unknown", lastActive: null, updatedAt: Date.now() };
  }

  // -------------------------------------------------------------------------
  // Internals: transports and login
  // -------------------------------------------------------------------------

  #createStorage(config: ResolvedConfig): StorageAdapter {
    if (config.storageAdapter === "memory") {
      return new MemoryStorage();
    }
    if (config.storageAdapter === "file") {
      return new FileStorage(config.storageDirectory, this.#logger);
    }
    return config.storageAdapter;
  }

  #handleListenerError(event: string, error: unknown): void {
    const wrapped = LibraryError.wrap(error, "API_ERROR", `Listener for "${String(event)}" failed`);
    this.#logger.warn({ event: String(event), err: wrapped.message }, "event listener threw");
    if (event !== "error") {
      this.#emitter.emitAndForget("error", {
        type: "error",
        timestamp: Date.now(),
        error: wrapped,
      });
    }
  }

  #requireHttp(): HttpTransport {
    if (this.#http === null) {
      throw new SessionError("Not authenticated — call login() first", "SESSION_NOT_AUTHENTICATED");
    }
    return this.#http;
  }

  #requireMqtt(): MqttTransport {
    if (this.#mqtt === null) {
      throw new MQTTError("The realtime connection is not up — call login() first", "MQTT_NOT_CONNECTED", {
        retryable: true,
      });
    }
    return this.#mqtt;
  }

  #requireUserId(): string {
    if (this.#userId === "") {
      throw new SessionError("Not authenticated — call login() first", "SESSION_NOT_AUTHENTICATED");
    }
    return this.#userId;
  }

  async #scrapeTokens(http: HttpTransport): Promise<ScrapedTokens> {
    const response = await http.get("login", `${FB_BASE_URL}/home.php`);
    const diag = safeHomeDiagnostics(response.body, response.url, response.status);

    // The logged-out splash screen carries no tokens by design; detect it
    // precisely instead of trying to extract what isn't there.
    if (diag.mqttWebConfigEmpty) {
      const summary = summarizeHomeDiagnostics(diag);
      this.#logger.warn(
        { operation: "login", ...diag },
        "Facebook returned the logged-out splash screen for this session",
      );
      throw new AuthenticationError(
        `Facebook rejected the session — home.php returned the logged-out page (${summary}); re-export your cookies from a browser that is actually logged in`,
        "AUTH_SESSION_EXPIRED",
        { retryable: false, context: { operation: "login", ...diag } },
      );
    }

    const isLoginPage =
      response.url.includes("/login") ||
      response.url.includes("/checkpoint") ||
      response.url.includes("/two_step_verification") ||
      diag.hasLoginForm ||
      diag.hasCheckpoint;
    if (isLoginPage) {
      const isCheckpoint =
        response.url.includes("/checkpoint") ||
        response.url.includes("/two_step_verification") ||
        diag.hasCheckpoint;
      const summary = summarizeHomeDiagnostics(diag);
      throw new AuthenticationError(
        isCheckpoint
          ? `Facebook requires a security checkpoint — log in via a browser to clear it (${summary})`
          : `Facebook rejected the session and redirected to the login page (${summary})`,
        "AUTH_SESSION_EXPIRED",
        {
          retryable: false,
          context: {
            operation: "login",
            url: response.url,
            isCheckpoint,
            ...diag,
          },
        },
      );
    }
    const tokens = scrapeTokens(response.body, this.#requireUserId());
    if (tokens === null) {
      const summary = summarizeHomeDiagnostics(diag);
      this.#logger.warn(
        { operation: "login", ...diag },
        "token scrape failed — no token payloads found on the home page",
      );
      throw new AuthenticationError(
        `Could not read Facebook's session tokens from the home page (${summary})`,
        "AUTH_LOGIN_REJECTED",
        {
          retryable: false,
          context: { operation: "login", ...diag },
        },
      );
    }
    this.#logger.debug(
      { operation: "login", region: tokens.region, hasIrisSeqId: tokens.irisSeqId !== null },
      "session tokens scraped",
    );
    return tokens;
  }

  #applyTokens(tokens: ScrapedTokens): void {
    const http = this.#requireHttp();
    const region = this.#session.region ?? tokens.region;
    this.#session.setRegion(region);
    http.setTokens({
      userId: this.#requireUserId(),
      fbDtsg: tokens.fbDtsg,
      jazoest: computeJazoest(tokens.fbDtsg),
      lsd: tokens.lsd,
      revision: tokens.revision,
      region,
    });
    this.#clientId = tokens.clientId;
    if (tokens.irisSeqId !== null && this.#session.lastSeqId === null) {
      this.#session.setCursor({ lastSeqId: tokens.irisSeqId, syncToken: this.#session.syncToken });
    }
  }

  async #validateSession(http: HttpTransport): Promise<void> {
    const userId = this.#requireUserId();
    const json = await this.#postForm("validateLogin", `${FB_BASE_URL}/chat/user_info/`, { "ids[0]": userId });
    const payload = asRecord(json);
    const profiles = asRecord(asRecord(payload?.["payload"])?.["profiles"]);
    if (profiles === null || Object.keys(profiles).length === 0) {
      throw new AuthenticationError(
        "Facebook did not return a profile for the authenticated user",
        "AUTH_LOGIN_REJECTED",
        { retryable: false, context: { operation: "validateLogin" } },
      );
    }
  }

  /**
   * Re-establishes the web client's presence session after login. The web
   * client calls this endpoint with `reason=6`; failure is non-fatal because
   * presence still flows over `/orca_presence`, but a successful call keeps
   * the account's availability state consistent with the browser session.
   */
  async #reconnectPresence(http: HttpTransport): Promise<void> {
    try {
      await http.get("presenceReconnect", `${FB_BASE_URL}/ajax/presence/reconnect.php`, {
        query: { reason: 6 },
      });
      this.#debug("login", "presence reconnect accepted", {});
    } catch (error) {
      this.#logger.debug({ err: errorMessage(error) }, "presence reconnect failed");
    }
  }

  async #refreshCookies(): Promise<void> {
    const http = this.#requireHttp();
    const response = await http.get("cookieRefresh", `${FB_BASE_URL}/home.php`);
    const diag = safeHomeDiagnostics(response.body, response.url, response.status);

    if (diag.mqttWebConfigEmpty) {
      this.#handleSessionExpired("expired");
      throw new AuthenticationError(
        `Facebook rejected the session during cookie refresh — home.php returned the logged-out page (${summarizeHomeDiagnostics(diag)})`,
        "AUTH_SESSION_EXPIRED",
        { retryable: true, context: { operation: "cookieRefresh", ...diag } },
      );
    }

    const isExpiredPage =
      response.url.includes("/login") ||
      response.url.includes("/checkpoint") ||
      response.url.includes("/two_step_verification") ||
      diag.hasLoginForm ||
      diag.hasCheckpoint;
    if (isExpiredPage) {
      this.#handleSessionExpired("expired");
      throw new AuthenticationError(
        `Facebook redirected the session during cookie refresh (${summarizeHomeDiagnostics(diag)})`,
        "AUTH_SESSION_EXPIRED",
        { retryable: true, context: { operation: "cookieRefresh", ...diag } },
      );
    }
    const tokens = scrapeTokens(response.body, this.#requireUserId());
    if (tokens === null) {
      this.#logger.warn(
        { operation: "cookieRefresh", ...diag },
        "token refresh failed — no token payloads found on the home page",
      );
      throw new AuthenticationError(
        `Could not refresh Facebook's session tokens (${summarizeHomeDiagnostics(diag)})`,
        "AUTH_LOGIN_REJECTED",
        { retryable: true, context: { operation: "cookieRefresh", ...diag } },
      );
    }
    this.#applyTokens(tokens);
  }

  async #postForm(
    operation: string,
    url: string,
    form: Readonly<Record<string, FormValue>>,
  ): Promise<unknown> {
    const http = this.#requireHttp();
    try {
      const response = await http.postForm(operation, url, form);
      return http.check(operation, response);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        if (error.code === "AUTH_SESSION_EXPIRED") {
          this.#handleSessionExpired("expired");
        } else if (error.code === "AUTH_LOGIN_REJECTED") {
          this.#handleSessionExpired("invalid");
        }
      }
      throw error;
    }
  }

  /** Best-effort teardown and logout event when Facebook rejects the session. */
  #handleSessionExpired(reason: "expired" | "invalid"): void {
    const state = this.#session.state;
    if (state !== "ACTIVE" && state !== "RECONNECTING") {
      return;
    }
    this.#session.markClosing();
    this.#session.markClosed();

    const mqtt = this.#mqtt;
    this.#mqtt = null;
    this.#delta = null;
    this.#sync = null;
    if (mqtt !== null) {
      void mqtt.close(true).catch(() => undefined);
    }
    const http = this.#http;
    this.#http = null;
    if (http !== null) {
      void http.close().catch(() => undefined);
    }

    this.#clearSessionCaches();
    this.#userId = "";
    void this.#session.clearPersisted();
    this.#emitter.emitAndForget("logout", {
      type: "logout",
      timestamp: Date.now(),
      userId: this.#session.userId,
      reason,
    });
  }

  /** Emits a `debug` event when the configured log level asks for it. */
  #debug(module: string, message: string, data: unknown = null): void {
    if (this.#config.logLevel !== "debug" && this.#config.logLevel !== "trace") {
      return;
    }
    this.#emitter.emitAndForget("debug", {
      type: "debug",
      timestamp: Date.now(),
      module,
      message,
      data,
    });
  }

  async #batch(
    operation: string,
    queries: Readonly<Record<string, unknown>>,
    batchName?: string | undefined,
  ): Promise<GraphQLBatchResult> {
    return postGraphQLBatch(this.#requireHttp(), operation, queries, batchName);
  }

  async #mutateReaction(messageId: string, action: "ADD_REACTION" | "REMOVE_REACTION", reaction: string): Promise<void> {
    const userId = this.#requireUserId();
    this.#clientMutationId += 1;
    await postWebGraphQLMutation(this.#requireHttp(), "setReaction", DOC_IDS.reaction, {
      data: {
        client_mutation_id: String(this.#clientMutationId),
        actor_id: userId,
        action,
        message_id: messageId,
        reaction,
      },
    });
  }

  async #isGroupThread(threadId: string): Promise<boolean> {
    const cached = this.#threadKinds.get(threadId);
    if (cached !== undefined) {
      return cached;
    }
    // Length 15 is ambiguous — user ids and some group ids share it. Ask
    // Facebook once and cache the answer; on failure, use the length heuristic.
    if (threadId.length === 15) {
      try {
        const info = await this.getThread(threadId);
        return info.isGroup;
      } catch (error) {
        this.#logger.debug(
          { threadId, err: errorMessage(error) },
          "could not resolve the thread kind; falling back to the length heuristic",
        );
      }
    }
    // Matches the web client's heuristic: user ids are short, group ids long.
    return threadId.length > 15;
  }

  async #send(
    threadId: string,
    content: MessageContent,
    replyToMessageId?: string | undefined,
  ): Promise<MessageSendResult> {
    const isGroup = await this.#isGroupThread(threadId);
    const offlineThreadingId = generateOfflineThreadingId();
    const form = buildMessageForm({
      userId: this.#requireUserId(),
      clientId: this.#clientId,
      threadId,
      isGroup,
      offlineThreadingId,
      replyToMessageId,
    });

    switch (content.type) {
      case "text": {
        const mentions = content.mentions ?? [];
        if (mentions.length > 0) {
          form["body"] = `\u200E${content.body}`;
          mentions.forEach((mention, index) => {
            const offset = content.body.indexOf(mention.tag, mention.fromIndex ?? 0);
            form[`profile_xmd[${index}][offset]`] = offset + 1;
            form[`profile_xmd[${index}][length]`] = mention.tag.length;
            form[`profile_xmd[${index}][id]`] = mention.id;
            form[`profile_xmd[${index}][type]`] = "p";
          });
        } else {
          form["body"] = content.body;
        }
        break;
      }
      case "sticker": {
        form["sticker_id"] = content.stickerId;
        break;
      }
      case "gif": {
        form["gif_ids"] = [content.gifId];
        break;
      }
      case "attachment": {
        const info = this.#mediaCache.get(content.attachmentId);
        const kind = info?.kind ?? "file";
        form[`${kind}_ids`] = [content.attachmentId];
        break;
      }
    }

    form["has_attachment"] = content.type !== "text";

    const json = await this.#postForm("sendMessage", `${FB_BASE_URL}/messaging/send/`, form);
    const payload = asRecord(asRecord(json)?.["payload"]) ?? asRecord(json);
    const actions = asArray(payload?.["actions"]);
    const first = asRecord(actions[0]);
    const messageId = readId(first?.["message_id"]);
    if (messageId === null) {
      throw new APIError("Facebook did not return a message id for the send", "API_ERROR", {
        retryable: false,
        context: { operation: "sendMessage", threadId },
      });
    }
    const responseThreadId = readId(first?.["thread_fbid"]) ?? threadId;
    this.#debug("sendMessage", "Facebook accepted the message", {
      messageId,
      threadId: responseThreadId,
    });
    return { messageId, threadId: responseThreadId, offlineThreadingId };
  }

  async #upload(file: FileInput): Promise<MediaInfo> {
    const info = await uploadMedia(this.#requireHttp(), this.#logger, file);
    this.#mediaCache.set(info.attachmentId, info);
    await this.#cache.set(`media:${info.attachmentId}`, info, {
      ttlSeconds: CACHE_TTL_SECONDS.user,
      tags: [CACHE_TAGS.user],
    });
    return info;
  }

  async #resolveAttachmentUrl(attachmentId: string): Promise<string> {
    const cached = this.#attachmentUrls.get(attachmentId);
    if (cached !== undefined && cached.url !== "") {
      return cached.url;
    }
    const kind = cached?.kind;
    if (kind === undefined || kind === "photo" || kind === "animated_image") {
      try {
        const url = await resolvePhotoUrl(this.#requireHttp(), attachmentId);
        this.#attachmentUrls.set(attachmentId, { url, kind: kind ?? "photo" });
        return url;
      } catch (error) {
        if (kind === "photo" || kind === "animated_image") {
          throw new APIError(
            `Could not resolve a downloadable URL for attachment "${attachmentId}"`,
            "MEDIA_NOT_FOUND",
            { retryable: false, context: { attachmentId }, cause: error },
          );
        }
      }
    }
    throw new APIError(
      `No downloadable URL is known for attachment "${attachmentId}"`,
      "ATTACHMENT_URL_UNAVAILABLE",
      { retryable: false, context: { attachmentId } },
    );
  }

  async #setMute(threadId: string, setting: string): Promise<void> {
    const id = parseThreadId(threadId);
    await this.#postForm("setMute", `${FB_BASE_URL}/ajax/mercury/change_mute_thread.php`, {
      thread_fbid: id,
      mute_settings: setting,
    });
  }

  async #setArchived(threadId: string, archived: boolean): Promise<void> {
    const id = parseThreadId(threadId);
    await this.#postForm("setArchived", `${FB_BASE_URL}/ajax/mercury/change_archived_status.php`, {
      [`ids[${id}]`]: archived,
    });
  }

  // -------------------------------------------------------------------------
  // Internals: realtime
  // -------------------------------------------------------------------------

  #handleMessage(topic: string, payload: unknown): void {
    const delta = this.#delta;
    if (delta === null) {
      return;
    }
    this.#debug("mqtt", "payload received", { topic, payload });
    void delta.handleMessage(topic, payload).catch((error) => {
      this.#logger.warn({ topic, err: errorMessage(error) }, "delta processing failed");
    });
  }

  #createSink(): DeltaSink {
    return {
      raw: (topic, payload) => {
        this.#emitter.emitAndForget("raw", {
          type: "raw",
          timestamp: Date.now(),
          topic,
          payload,
        });
      },
      warning: (message, context) => {
        this.#emitter.emitAndForget("warning", {
          type: "warning",
          timestamp: Date.now(),
          message,
          context,
        });
      },
      message: (event) => {
        this.#cacheEventMessage(event);
        this.#emitter.emitAndForget("message", event);
      },
      message_reply: (event) => {
        this.#cacheEventMessage(event);
        this.#emitter.emitAndForget("message_reply", event);
      },
      message_unsend: (event) => {
        this.#messages.delete(event.messageId);
        this.#messageThread.delete(event.messageId);
        this.#emitter.emitAndForget("message_unsend", event);
      },
      reaction: (event) => {
        const cached = this.#messages.get(event.messageId);
        if (cached !== undefined) {
          const others = cached.reactions.filter((reaction) => reaction.userId !== event.userId);
          const emoji = event.emoji;
          const reactions = emoji === null ? others : [...others, { userId: event.userId, emoji }];
          this.#messages.set(event.messageId, { ...cached, reactions });
        }
        this.#emitter.emitAndForget("reaction", event);
      },
      typing: (event) => {
        this.#emitter.emitAndForget("typing", event);
      },
      presence: (event) => {
        this.#setBounded(
          this.#presence,
          event.userId,
          {
            userId: event.userId,
            status: event.status,
            lastActive: event.lastActive,
            updatedAt: event.timestamp,
          },
          PRESENCE_CACHE_LIMIT,
        );
        this.#emitter.emitAndForget("presence", event);
      },
      read: (event) => {
        this.#emitter.emitAndForget("read", event);
      },
      delivered: (event) => {
        for (const messageId of event.messageIds) {
          this.#setBounded(this.#messageThread, messageId, event.threadId, MESSAGE_CACHE_LIMIT);
        }
        this.#emitter.emitAndForget("delivered", event);
      },
      participant_join: (event) => {
        this.#emitter.emitAndForget("participant_join", event);
      },
      participant_leave: (event) => {
        this.#emitter.emitAndForget("participant_leave", event);
      },
      admin_change: (event) => {
        this.#emitter.emitAndForget("admin_change", event);
      },
      thread_update: (event) => {
        this.#emitter.emitAndForget("thread_update", event);
      },
      poll: (event) => {
        if (event.question !== null && event.question !== "") {
          this.#pollQuestions.set(event.pollId, event.question);
        }
        this.#emitter.emitAndForget("poll", event);
      },
      call: (event) => {
        this.#emitter.emitAndForget("call", event);
      },
    };
  }

  async #handleForcedFetch(threadId: string, messageId: string): Promise<MessageEvent | ThreadUpdateEvent | null> {
    const batch = await this.#batch("forcedFetch", {
      o0: {
        doc_id: DOC_IDS.forcedFetch,
        query_params: {
          thread_and_message_id: { thread_id: threadId, message_id: messageId },
        },
      },
    });
    const node = asRecord(batch.data?.["message"]);
    if (node === null) {
      return null;
    }
    const typename = readString(node, "__typename");
    const senderId = readString(asRecord(node["message_sender"]), "id") ?? "";
    const timestamp = toMillis(node["timestamp_precise"]) ?? Date.now();

    if (typename === "ThreadImageMessage") {
      const image = asRecord(node["image_with_metadata"]);
      const preview = asRecord(image?.["preview"]);
      const dimensions = asRecord(image?.["original_dimensions"]);
      return {
        type: "thread_update",
        timestamp,
        threadId,
        actorId: senderId,
        action: "photo",
        details: {
          attachmentId: readString(image, "legacy_attachment_id"),
          width: toNumber(dimensions?.["x"] ?? dimensions?.["width"]),
          height: toNumber(dimensions?.["y"] ?? dimensions?.["height"]),
          url: readString(preview, "uri"),
        },
        isSelf: senderId === this.#requireUserId(),
      };
    }

    if (typename === "ThreadNameMessage") {
      return {
        type: "thread_update",
        timestamp,
        threadId,
        actorId: senderId,
        action: "name",
        details: { name: readString(node, "thread_name") },
        isSelf: senderId === this.#requireUserId(),
      };
    }

    if (typename === "GenericAdminTextMessage") {
      const adminType = readString(node, "extensible_message_admin_text_type");
      const action =
        adminType === "CHANGE_THREAD_THEME"
          ? "color"
          : adminType === "CHANGE_THREAD_ICON"
            ? "icon"
            : adminType === "CHANGE_THREAD_NICKNAME"
              ? "nickname"
              : "unknown";
      return {
        type: "thread_update",
        timestamp,
        threadId,
        actorId: senderId,
        action,
        details: {
          adminType,
          data: asRecord(node["extensible_message_admin_text"]) ?? {},
        },
        isSelf: senderId === this.#requireUserId(),
      };
    }

    return messageEventFromNode(node, threadId, this.#requireUserId(), await this.#isGroupThread(threadId));
  }

  #cacheEventMessage(event: MessageEvent | MessageReplyEvent): void {
    const message = messageFromEvent(event);
    this.#cacheMessage(message);
    this.#setBounded(this.#threadKinds, event.threadId, event.isGroup, THREAD_KIND_CACHE_LIMIT);
  }

  #cacheMessage(message: Message): void {
    this.#setBounded(this.#messages, message.id, message, MESSAGE_CACHE_LIMIT);
    this.#setBounded(this.#messageThread, message.id, message.threadId, MESSAGE_CACHE_LIMIT);
    for (const attachment of message.attachments) {
      if (attachment.url !== null && attachment.url !== "") {
        this.#setBounded(
          this.#attachmentUrls,
          attachment.id,
          { url: attachment.url, kind: attachment.type },
          ATTACHMENT_CACHE_LIMIT,
        );
      }
    }
  }

  #setBounded<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
    if (map.has(key)) {
      map.delete(key);
    } else if (map.size >= limit) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) {
        map.delete(oldest);
      }
    }
    map.set(key, value);
  }

  #persistSoon(): void {
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer);
    }
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      void this.#session.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.#persistTimer.unref?.();
  }

  #clearSessionCaches(): void {
    this.#messages.clear();
    this.#messageThread.clear();
    this.#attachmentUrls.clear();
    this.#threadKinds.clear();
    this.#pollQuestions.clear();
    this.#presence.clear();
    this.#mediaCache.clear();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
