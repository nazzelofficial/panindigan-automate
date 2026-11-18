/**
 * MQTT-over-WebSocket transport for Messenger realtime events.
 *
 * Owns the complete realtime lifecycle: dialing with region fallback,
 * authenticating with the session cookie in the WebSocket handshake,
 * maintaining the messenger sync queue across reconnects, heartbeat
 * round-trip measurement, jittered-backoff reconnection, a bounded FIFO
 * queue for publishes made while offline, and lightweight-service
 * (`/ls_req`) request/response correlation.
 *
 * Deltas are not interpreted here. Every JSON-parsed message — including
 * `/t_ms` and `/ls_resp` — is forwarded to the owning layer through the
 * callbacks; the transport only consumes what it needs for sync bookkeeping.
 */

import { randomUUID } from "node:crypto";

import { connect } from "mqtt";
import type { IClientOptions, MqttClient, Packet } from "mqtt";
import { z } from "zod";

import { CookieStore } from "../../auth/index.js";
import {
  FB_BASE_URL,
  FB_CHAT_APP_ID,
  FB_LS_APP_ID,
  LS_REQUEST_TIMEOUT_MS,
  MQTT_CONNECT_TIMEOUT_MS,
  MQTT_FALLBACK_REGIONS,
  MQTT_TOPICS,
  MQTT_WS_URL,
  SYNC_API_VERSION,
  SYNC_DELTA_BATCH_SIZE,
  SYNC_MAX_DELTAS,
  TMS_TIMEOUT_MS,
  TOPIC_BROWSER_CLOSE,
  TOPIC_CLIENT_SETTINGS,
  TOPIC_FOREGROUND_STATE,
  TOPIC_LS_REQ,
  TOPIC_LS_RESP,
  TOPIC_MS,
  TOPIC_SYNC_CREATE_QUEUE,
  TOPIC_SYNC_GET_DIFFS,
} from "../../constants.js";
import { DiagnosticsCollector } from "../../diagnostics/index.js";
import { MQTTError, TimeoutError, ValidationError } from "../../errors/index.js";
import type { ResolvedConfig } from "../../config/index.js";
import type { Logger } from "../../logger/index.js";
import { generateOfflineThreadingId } from "../../utils/index.js";
import { createWsProxyAgent } from "./proxy-agent.js";
import {
  MqttObfuscationManager,
  PublishRateTracker,
  applyObfuscationDelay,
  type MqttObfuscationConfig,
} from "./obfuscation.js";

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/**
 * The `/t_ms` envelope. Every field is optional because payloads vary by
 * purpose: queue confirmations carry `firstDeltaSeqId` + `syncToken`, diff
 * batches carry `lastIssuedSeqId` + `deltas`, and failures carry
 * `errorCode`. Unknown fields pass through untouched.
 */
const TmsEnvelopeSchema = z
  .object({
    firstDeltaSeqId: z.union([z.number(), z.string()]).optional(),
    lastIssuedSeqId: z.union([z.number(), z.string()]).optional(),
    syncToken: z.string().optional(),
    errorCode: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

/**
 * The `/ls_resp` envelope. `request_id` correlates a response with its
 * request; the `payload` is a JSON-encoded string when present.
 */
const LsRespEnvelopeSchema = z
  .object({
    request_id: z.union([z.number(), z.string()]),
    payload: z.string().optional(),
  })
  .passthrough();

/**
 * Named `/t_ms` error codes that mean the server-side sync queue is unusable
 * and must be recreated: deleted after too much time passed, or a sequence
 * id too old for the retained deltas.
 */
const QUEUE_LOST_ERROR_CODES = new Set(["ERROR_QUEUE_NOT_FOUND", "ERROR_QUEUE_OVERFLOW"]);

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** The sync cursor, persisted across restarts and reconnects. */
export interface SyncCursor {
  /** Last known sequence id, `null` before the first sync completes. */
  readonly lastSeqId: number | null;
  /** The server-issued sync token, `null` until a queue is confirmed. */
  readonly syncToken: string | null;
}

/** Fired once the sync channel is up: the first `/t_ms` arrived. */
export interface SyncEstablishedInfo {
  /** Whether this is a re-establishment after a drop. */
  readonly reconnect: boolean;
  /** Which reconnect attempt succeeded; `0` on the initial connection. */
  readonly attempt: number;
  /** Packets flushed from the offline queue on this connection. */
  readonly drained: number;
}

/** Fired when a connection is lost and a retry has been scheduled. */
export interface ConnectionLostInfo {
  readonly reason: string;
  readonly attempt: number;
  readonly delayMs: number;
}

/** Fired when reconnect attempts ran out and the transport gave up. */
export interface ReconnectExhaustedInfo {
  readonly reason: string;
  readonly attempts: number;
}

/** Events the owning layer observes from the transport. */
export interface MqttTransportCallbacks {
  /** Every JSON-parsed MQTT message, in arrival order. */
  onMessage(topic: string, payload: unknown): void;
  /** The sync channel came up on this connection. */
  onSyncEstablished(info: SyncEstablishedInfo): void;
  /** The connection was lost; a retry is scheduled. */
  onConnectionLost(info: ConnectionLostInfo): void;
  /** Reconnect attempts were exhausted. */
  onReconnectExhausted(info: ReconnectExhaustedInfo): void;
  /** The sync cursor changed and should be persisted. */
  onSyncUpdate(cursor: SyncCursor): void;
  /** A non-fatal issue occurred. */
  onWarning(message: string, context: Readonly<Record<string, unknown>>): void;
  /** A PINGREQ left the socket. Optional; the watchdog uses it when present. */
  onPingSent?(): void;
  /** A PINGRESP arrived. Optional; the watchdog uses it when present. */
  onPongReceived?(): void;
}

/** A lightweight-service task submitted through {@link MqttTransport.lsRequest}. */
export interface LsTaskSpec {
  /** The numeric task label, e.g. `"430"` for pinning a message. */
  readonly label: string;
  /** The task payload; serialized to JSON inside the request. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The server-side queue the task runs in, e.g. `pin_msg_v2_<threadId>`. */
  readonly queueName: string;
  /** The task family's version id, e.g. `"25095469420099952"`. */
  readonly versionId: string;
  /** Response timeout override in milliseconds. */
  readonly timeoutMs?: number | undefined;
}

/** Options for {@link MqttTransport.publish}. */
export interface PublishOptions {
  readonly qos?: 0 | 1 | undefined;
  readonly retain?: boolean | undefined;
}

/** Constructor dependencies. */
export interface MqttTransportDeps {
  readonly config: ResolvedConfig;
  readonly cookies: CookieStore;
  readonly diagnostics: DiagnosticsCollector;
  readonly logger: Logger;
  readonly callbacks: MqttTransportCallbacks;
  /** The authenticated user's id. */
  readonly userID: string;
  /** A custom MQTT endpoint; overrides region fallback entirely. */
  readonly mqttEndpoint?: string | undefined;
  /** The account's preferred edge region, when known from login. */
  readonly region?: string | undefined;
  /** Whether the account appears available while listening. */
  readonly chatOn: boolean;
  /**
   * Fetches a fresh sync sequence id over GraphQL, used when a queue must
   * be created and no usable id is held.
   */
  readonly refetchLastSeqId?: (() => Promise<number>) | undefined;
  /** Restored sync cursor from a previous session, when available. */
  readonly initialCursor?: Readonly<Partial<SyncCursor>> | undefined;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A publish held while disconnected. */
interface QueuedPublish {
  readonly topic: string;
  readonly payload: string;
  readonly qos: 0 | 1;
  readonly retain: boolean;
}

/** A `/ls_req` awaiting its `/ls_resp`. */
interface PendingLsRequest {
  readonly finish: (error: Error | null, value: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** The deferred behind `connect()`. */
interface ConnectDeferred {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly promise: Promise<void>;
}

/** Largest safe integer, the upper bound for session ids (2^53 - 1). */
const MAX_SESSION_ID = 9_007_199_254_740_991;

/** Topics unsubscribed just before a graceful close. */
const CLOSE_UNSUBSCRIBE_TOPICS = ["/webrtc", "/rtc_multi", "/onevc"] as const;

/** Tick interval of the heartbeat watchdog. */
const HEARTBEAT_WATCHDOG_INTERVAL_MS = 1_000;

/** Converts a sequence id that may arrive as string or number. */
function toSeqId(value: number | string): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Extracts a message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * The MQTT transport. One instance owns one listening session; it survives
 * drops and region failovers internally. Not constructed directly by users
 * — the session manager wires it up.
 */
export class MqttTransport {
  readonly #deps: MqttTransportDeps;
  readonly #logger: Logger;
  readonly #cid: string;
  readonly #obfuscation: MqttObfuscationManager;
  readonly #publishRateTracker: PublishRateTracker;

  #closed = false;
  #cycleRunning = false;
  #connectDeferred: ConnectDeferred | null = null;
  #client: MqttClient | null = null;
  /** Bumped on every dial; stale handlers compare against it. */
  #generation = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  #attempt = 0;
  #attemptAtConnect = 0;
  #everConnected = false;
  #everSyncEstablished = false;
  /** Whether the first `/t_ms` has arrived on the current connection. */
  #syncEstablishedOnConnection = false;
  #preferredRegion: string | null;
  #chatOn: boolean;

  #lastSeqId: number | null = null;
  #syncToken: string | null = null;

  #queue: QueuedPublish[] = [];
  #lsRequests = new Map<string, PendingLsRequest>();
  #lsRequestId = 0;
  #taskId = 0;

  #tmsTimer: ReturnType<typeof setTimeout> | null = null;
  #watchdogTimer: ReturnType<typeof setInterval> | null = null;
  #pendingPingAt: number | null = null;
  #lastInboundAt = 0;
  #drainedThisConnection = 0;

  constructor(deps: MqttTransportDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ module: "mqtt" });
    this.#cid = randomUUID();
    this.#obfuscation = new MqttObfuscationManager({
      enabled: true,
      randomizeSubscriptionOrder: true,
      varyPresencePattern: true,
    });
    this.#publishRateTracker = new PublishRateTracker();
    this.#preferredRegion = deps.region ?? null;
    this.#chatOn = deps.chatOn;
    if (deps.initialCursor !== undefined) {
      this.#lastSeqId = deps.initialCursor.lastSeqId ?? null;
      this.#syncToken = deps.initialCursor.syncToken ?? null;
    }
  }

  /** Whether an MQTT connection is currently established. */
  get connected(): boolean {
    return this.#client !== null;
  }

  /** Whether the sync channel is up on the current connection. */
  get syncEstablished(): boolean {
    return this.#syncEstablishedOnConnection;
  }

  /** Packets currently waiting for a connection. */
  get queueDepth(): number {
    return this.#queue.length;
  }

  /** The current sync cursor, for persistence. */
  getCursor(): SyncCursor {
    return { lastSeqId: this.#lastSeqId, syncToken: this.#syncToken };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connects, resolving on the first CONNACK. Region sweep, retries, and
   * reconnection continue in the background; watch
   * {@link MqttTransportCallbacks.onSyncEstablished} for sync readiness.
   */
  connect(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(
        new MQTTError("cannot connect a closed MQTT transport", "MQTT_NOT_CONNECTED", {
          retryable: false,
        }),
      );
    }
    if (this.#client !== null) return Promise.resolve();
    if (this.#connectDeferred !== null) return this.#connectDeferred.promise;

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#connectDeferred = { resolve, reject, promise };
    if (!this.#cycleRunning && this.#reconnectTimer === null) void this.#cycle();
    return promise;
  }

  /**
   * Closes gracefully: unsubscribes call topics, publishes
   * `/browser_close`, then ends the connection. After this the transport is
   * unusable. `force` skips the graceful steps and destroys the socket.
   */
  async close(force = false): Promise<void> {
    if (this.#closed && this.#client === null) return;
    this.#closed = true;

    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#rejectPendingLsRequests(
      new MQTTError(
        "transport closed while awaiting a lightweight-service response",
        "MQTT_NOT_CONNECTED",
        { retryable: false },
      ),
    );
    this.#rejectConnect(
      new MQTTError("transport closed before the MQTT connection was established", "MQTT_NOT_CONNECTED", {
        retryable: false,
      }),
    );

    const client = this.#client;
    if (client === null) return;

    // Invalidate this client's handlers first so the close event no-ops.
    this.#generation += 1;
    this.#teardownConnection();
    this.#deps.diagnostics.recordDisconnect();

    if (!force) {
      try {
        for (const topic of CLOSE_UNSUBSCRIBE_TOPICS) client.unsubscribe(topic);
        client.publish(TOPIC_BROWSER_CLOSE, "{}");
      } catch {
        // The connection may already be dying; the end below finishes it.
      }
    }
    await new Promise<void>((resolve) => {
      try {
        client.end(force, () => resolve());
      } catch {
        resolve();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * Publishes a message. While disconnected the packet is held in the FIFO
   * offline queue (bounded by `mqttQueueMaxSize`) and flushed on the next
   * connection; a full queue throws `MQTT_QUEUE_OVERFLOW`.
   * Applies publish rate tracking and spacing obfuscation.
   */
  async publish(topic: string, payload: string, options: PublishOptions = {}): Promise<void> {
    const qos = options.qos ?? 1;
    const retain = options.retain ?? false;

    if (this.#closed) {
      throw new MQTTError("cannot publish on a closed MQTT transport", "MQTT_NOT_CONNECTED", {
        retryable: false,
        context: { topic },
      });
    }

    const client = this.#client;
    if (client === null) {
      const maxSize = this.#config.mqttQueueMaxSize;
      if (this.#queue.length >= maxSize) {
        this.#deps.diagnostics.recordQueueDrop();
        this.#deps.diagnostics.setQueueDepth(this.#queue.length);
        throw new MQTTError(
          `outgoing MQTT queue is full (${this.#queue.length}/${maxSize}); dropping publish to "${topic}"`,
          "MQTT_QUEUE_OVERFLOW",
          { context: { topic, queueDepth: this.#queue.length, maxSize } },
        );
      }
      this.#queue.push({ topic, payload, qos, retain });
      this.#deps.diagnostics.setQueueDepth(this.#queue.length);
      return;
    }
    
    // Apply publish spacing obfuscation to avoid burst patterns
    this.#publishRateTracker.recordPublish();
    const recentCount = this.#publishRateTracker.getRecentCount();
    const spacingDelay = this.#obfuscation.getPublishSpacingDelay(recentCount);
    
    if (spacingDelay > 0) {
      await applyObfuscationDelay(spacingDelay);
    }
    
    await this.#publishNow(client, topic, payload, qos, retain, MQTT_CONNECT_TIMEOUT_MS);
  }

  /**
   * Runs a lightweight-service task and resolves with the parsed
   * `/ls_resp` payload, or `null` when the response carried none. Rejects
   * with `TimeoutError` when no response arrives in time.
   */
  async lsRequest(spec: LsTaskSpec): Promise<unknown> {
    const client = this.#client;
    if (client === null) {
      throw new MQTTError(
        "cannot send a lightweight-service request while disconnected",
        "MQTT_NOT_CONNECTED",
        { retryable: true, context: { label: spec.label } },
      );
    }

    let taskPayload: string;
    try {
      taskPayload = JSON.stringify(spec.payload);
    } catch (error) {
      throw new ValidationError("lightweight-service task payload is not serializable", {
        cause: error,
        context: { label: spec.label },
      });
    }

    const requestId = ++this.#lsRequestId;
    const taskId = ++this.#taskId;
    const timeoutMs = spec.timeoutMs ?? LS_REQUEST_TIMEOUT_MS;
    const content = {
      app_id: FB_LS_APP_ID,
      payload: JSON.stringify({
        data_trace_id: null,
        epoch_id: Number.parseInt(generateOfflineThreadingId(), 10),
        tasks: [
          {
            failure_count: null,
            label: spec.label,
            payload: taskPayload,
            queue_name: spec.queueName,
            task_id: taskId,
          },
        ],
        version_id: spec.versionId,
      }),
      request_id: requestId,
      type: 3,
    };

    return new Promise<unknown>((resolve, reject) => {
      const key = String(requestId);
      let settled = false;
      const finish = (error: Error | null, value: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#lsRequests.delete(key);
        if (error !== null) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(
          new TimeoutError(
            `lightweight-service task "${spec.label}" timed out after ${timeoutMs}ms`,
            { context: { label: spec.label, queueName: spec.queueName } },
          ),
          null,
        );
      }, timeoutMs);
      this.#lsRequests.set(key, { finish, timer });
      void this.#publishNow(client, TOPIC_LS_REQ, JSON.stringify(content), 1, false, MQTT_CONNECT_TIMEOUT_MS).catch(
        (error: Error) => finish(error, null),
      );
    });
  }

  /**
   * Updates the availability flag, republishing the foreground and
   * client-settings state on the live connection when there is one.
   * Applies presence pattern variation to avoid predictable timing.
   */
  async setChatOn(chatOn: boolean): Promise<void> {
    this.#chatOn = chatOn;
    const client = this.#client;
    if (client === null) return;
    
    // Apply presence obfuscation: vary timing to avoid predictable patterns
    if (!this.#obfuscation.shouldPublishPresence()) {
      this.#logger.debug("skipping presence publish for pattern variation");
      return;
    }
    
    const delay = this.#obfuscation.getOperationDelay();
    await applyObfuscationDelay(delay);
    
    await this.#publishNow(client, TOPIC_FOREGROUND_STATE, JSON.stringify({ foreground: chatOn }), 1, false);
    
    // Add spacing between presence publishes
    const spacingDelay = this.#obfuscation.getOperationDelay();
    await applyObfuscationDelay(spacingDelay);
    
    await this.#publishNow(client, TOPIC_CLIENT_SETTINGS, JSON.stringify({ make_user_available_when_in_foreground: chatOn }), 1, false);
    
    this.#obfuscation.recordPresencePublish();
  }

  // -------------------------------------------------------------------------
  // Connection cycling
  // -------------------------------------------------------------------------

  get #config(): ResolvedConfig {
    return this.#deps.config;
  }

  /** One activation of the dial loop: a full region sweep, then hand over. */
  async #cycle(): Promise<void> {
    if (this.#closed || this.#cycleRunning || this.#client !== null) return;
    this.#cycleRunning = true;
    let failure: Error | null = null;
    try {
      await this.#dialRegions();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.#cycleRunning = false;
    }
    if (failure !== null) this.#scheduleRetry(failure.message);
  }

  /** Dials each region candidate in order until one connects. */
  async #dialRegions(): Promise<void> {
    const candidates = this.#regionCandidates();
    const names = candidates.map((region) => region ?? "default").join(", ");
    let lastError: Error | null = null;
    for (const region of candidates) {
      try {
        await this.#dial(region);
        if (region !== null) this.#preferredRegion = region;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const withCause = error instanceof Error && (error as { cause?: unknown }).cause;
        this.#logger.warn(
          { region: region ?? "default", err: lastError.message, ...(withCause !== undefined ? { cause: String(withCause) } : {}) },
          "MQTT dial failed",
        );
      }
    }
    throw new MQTTError(
      `could not connect to any MQTT region (${names}): ${lastError?.message ?? "unknown error"}`,
      "MQTT_CONNECTION_FAILED",
      {
        retryable: true,
        context: { regions: names },
        ...(lastError !== null ? { cause: lastError } : {}),
      },
    );
  }

  /** Candidate regions for this sweep: preferred, then the defaults. */
  #regionCandidates(): readonly (string | null)[] {
    const endpoint = this.#deps.mqttEndpoint;
    if (endpoint !== undefined && endpoint !== "") return [null];
    const candidates: (string | null)[] = [];
    if (this.#preferredRegion !== null) candidates.push(this.#preferredRegion);
    else candidates.push(null);
    for (const region of MQTT_FALLBACK_REGIONS) {
      if (region === this.#preferredRegion) continue;
      candidates.push(region);
    }
    return candidates;
  }

  /** Builds the WebSocket URL for one attempt. `region` is `null` for the default or custom endpoint. */
  #buildUrl(region: string | null, sessionId: number): string {
    const endpoint = this.#deps.mqttEndpoint;
    if (endpoint !== undefined && endpoint !== "") {
      return `${endpoint}&sid=${sessionId}&cid=${this.#cid}`;
    }
    if (region !== null) {
      return `${MQTT_WS_URL}?region=${region.toLowerCase()}&sid=${sessionId}&cid=${this.#cid}`;
    }
    return `${MQTT_WS_URL}?sid=${sessionId}&cid=${this.#cid}`;
  }

  /**
   * Dials one endpoint. Resolves when the connection is established and
   * fully set up (subscribed, sync queue published, offline queue flushed);
   * rejects on failure so the sweep can continue.
   */
  #dial(region: string | null): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      const generation = ++this.#generation;
      const sessionId = Math.floor(Math.random() * MAX_SESSION_ID) + 1;
      const url = this.#buildUrl(region, sessionId);
      const cookieHeader = this.#deps.cookies.headerFor(FB_BASE_URL);

      // The connect username carries the classic payload shape. `st` is
      // empty and topics are subscribed explicitly after CONNACK.
      const username = {
        u: this.#deps.userID,
        s: sessionId,
        chat_on: this.#chatOn,
        fg: true,
        d: this.#cid,
        ct: "websocket",
        aid: FB_CHAT_APP_ID,
        mqtt_sid: "",
        cp: 3,
        ecp: 10,
        st: [] as string[],
        pm: [] as unknown[],
        dc: "",
        no_auto_fg: true,
        gas: null,
        pack: [] as unknown[],
      };

      const headers: Record<string, string> = {
        Cookie: cookieHeader,
        Origin: FB_BASE_URL,
        "User-Agent": this.#config.userAgent,
        Referer: `${FB_BASE_URL}/`,
        Host: new URL(url).hostname,
      };
      // `ws` reads `origin` (setting the Origin header) and validates
      // `protocolVersion` against 8/13; the proxy agent routes the
      // handshake when configured.
      const proxy = this.#config.httpProxy;
      const wsOptions: NonNullable<IClientOptions["wsOptions"]> =
        proxy === null
          ? { headers, origin: FB_BASE_URL, protocolVersion: 13 }
          : {
              headers,
              origin: FB_BASE_URL,
              protocolVersion: 13,
              agent: createWsProxyAgent(proxy, { timeoutMs: MQTT_CONNECT_TIMEOUT_MS }),
            };

      const options: IClientOptions = {
        clientId: "mqttwsclient",
        protocolId: "MQIsdp",
        protocolVersion: 3,
        username: JSON.stringify(username),
        clean: true,
        keepalive: this.#config.heartbeatInterval,
        reschedulePings: true,
        connectTimeout: MQTT_CONNECT_TIMEOUT_MS,
        // The transport owns reconnection; never let mqtt.js retry on its own.
        reconnectPeriod: 0,
        wsOptions,
      };

      this.#logger.debug({ region: region ?? "default", url }, "dialing MQTT endpoint");

      // Apply connection jitter to avoid synchronized connections
      const connectionJitter = this.#obfuscation.getConnectionJitter();
      if (connectionJitter > 0) {
        await applyObfuscationDelay(connectionJitter);
      }

      let client: MqttClient;
      try {
        client = connect(url, options);
      } catch (error) {
        reject(
          new MQTTError(`failed to start the MQTT connection: ${errorMessage(error)}`, "MQTT_CONNECTION_FAILED", {
            retryable: true,
            ...(error instanceof Error ? { cause: error } : {}),
          }),
        );
        return;
      }

      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error !== undefined) reject(error);
        else resolve();
      };

      const onConnect = (): void => {
        client.removeListener("error", onConnectError);
        client.removeListener("close", onConnectClosed);
        // A close during post-CONNACK setup must settle the dial so the
        // region sweep can move on.
        client.once("close", () =>
          settle(
            new MQTTError("MQTT connection closed during setup", "MQTT_CONNECTION_FAILED", {
              retryable: true,
            }),
          ),
        );
        void this.#onConnack(client, generation).then(
          () => settle(),
          (error: unknown) => {
            this.#forceEnd(client);
            settle(
              error instanceof Error
                ? error
                : new MQTTError(String(error), "MQTT_CONNECTION_FAILED", { retryable: true }),
            );
          },
        );
      };
      const onConnectError = (error: Error): void => {
        settle(
          new MQTTError(`MQTT connection failed: ${error.message}`, "MQTT_CONNECTION_FAILED", {
            retryable: true,
            cause: error,
          }),
        );
      };
      const onConnectClosed = (): void => {
        settle(
          new MQTTError("MQTT connection closed before CONNACK", "MQTT_CONNECTION_FAILED", {
            retryable: true,
          }),
        );
      };

      client.once("connect", onConnect);
      client.once("error", onConnectError);
      client.once("close", onConnectClosed);
    });
  }

  // -------------------------------------------------------------------------
  // Connection established
  // -------------------------------------------------------------------------

  /** Sets up a freshly connected client: handlers, subscriptions, sync. */
  async #onConnack(client: MqttClient, generation: number): Promise<void> {
    if (this.#closed) {
      this.#forceEnd(client);
      return;
    }

    const attempt = this.#attempt;
    const reconnect = this.#everConnected;
    this.#attempt = 0;
    this.#attemptAtConnect = attempt;
    this.#everConnected = true;

    this.#client = client;
    this.#syncEstablishedOnConnection = false;
    this.#pendingPingAt = null;
    this.#lastInboundAt = Date.now();
    this.#drainedThisConnection = 0;

    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#deps.diagnostics.setMqttConnected(true);
    if (reconnect) this.#deps.diagnostics.recordReconnect();
    this.#logger.info({ region: this.#preferredRegion ?? "default", reconnect, attempt }, "MQTT connection established");
    this.#resolveConnect();

    this.#attachClientHandlers(client, generation);
    this.#startHeartbeatWatchdog();

    // Subscribe to every topic with MQTT obfuscation:
    // 1. Randomize subscription order to avoid predictable patterns
    // 2. Add staggered delays between subscriptions
    const topics = this.#obfuscation.randomizeTopicOrder(MQTT_TOPICS);
    
    const subscribeWithObfuscation = async () => {
      for (let i = 0; i < topics.length; i++) {
        const topic = topics[i]!;
        
        // Apply obfuscation delay before each subscription (except first)
        if (i > 0) {
          const delay = this.#obfuscation.getSubscriptionDelay(i, topics.length);
          await applyObfuscationDelay(delay);
        }
        
        client.subscribe(topic, (error) => {
          if (error === null) return;
          this.#logger.warn({ topic, err: error.message }, "MQTT subscription failed");
          this.#runCallback("onWarning", () =>
            this.#deps.callbacks.onWarning(`failed to subscribe to MQTT topic "${topic}"`, { topic }),
          );
        });
      }
    };
    
    // Run subscription obfuscation asynchronously
    subscribeWithObfuscation().catch((error) => {
      this.#logger.warn({ err: errorMessage(error) }, "subscription obfuscation failed");
    });

    // A fresh queue needs a sequence id; fetch one when the hook is wired.
    if (this.#syncToken === null && this.#lastSeqId === null && this.#deps.refetchLastSeqId !== undefined) {
      this.#lastSeqId = await this.#deps.refetchLastSeqId();
    }
    if (this.#client !== client) return; // the connection cycled mid-fetch

    await this.#publishSyncQueue(client);
    
    // Mark the client foreground and available with obfuscated timing
    const presenceDelay = this.#obfuscation.getOperationDelay();
    await applyObfuscationDelay(presenceDelay);
    
    await this.#publishNow(client, TOPIC_FOREGROUND_STATE, JSON.stringify({ foreground: this.#chatOn }), 1, false);
    
    const spacingDelay = this.#obfuscation.getOperationDelay();
    await applyObfuscationDelay(spacingDelay);
    
    await this.#publishNow(client, TOPIC_CLIENT_SETTINGS, JSON.stringify({ make_user_available_when_in_foreground: this.#chatOn }), 1, false);
    
    this.#obfuscation.recordPresencePublish();

    this.#drainedThisConnection = await this.#drainQueue(client);

    // The first /t_ms must arrive promptly, otherwise the connection is
    // treated as broken and cycled.
    this.#armTmsWatchdog();
  }

  /** Publishes the sync queue request appropriate for the held cursor. */
  async #publishSyncQueue(client: MqttClient): Promise<void> {
    const base = {
      sync_api_version: SYNC_API_VERSION,
      max_deltas_able_to_process: SYNC_MAX_DELTAS,
      delta_batch_size: SYNC_DELTA_BATCH_SIZE,
      encoding: "JSON",
      entity_fbid: this.#deps.userID,
    };
    let topic: string;
    let payload: Record<string, unknown>;
    if (this.#syncToken !== null && this.#lastSeqId !== null) {
      topic = TOPIC_SYNC_GET_DIFFS;
      payload = { ...base, last_seq_id: this.#lastSeqId, sync_token: this.#syncToken };
    } else {
      topic = TOPIC_SYNC_CREATE_QUEUE;
      payload = { ...base, device_params: null };
      if (this.#lastSeqId !== null) payload.initial_titan_sequence_id = this.#lastSeqId;
    }
    await this.#publishNow(client, topic, JSON.stringify(payload), 1, false);
  }

  /**
   * Recreates the sync queue on the live connection after a queue-lost
   * error: refetch a sequence id and publish create_queue. The cursor itself
   * is reset by {@link MqttTransport.#resetSyncCursor} before this runs.
   */
  async #recreateSyncQueue(client: MqttClient): Promise<void> {
    if (this.#deps.refetchLastSeqId !== undefined) {
      try {
        this.#lastSeqId = await this.#deps.refetchLastSeqId();
      } catch (error) {
        this.#logger.warn({ err: errorMessage(error) }, "failed to refetch sequence id after queue loss");
        this.#runCallback("onWarning", () =>
          this.#deps.callbacks.onWarning("failed to refetch the sequence id after sync queue loss", {
            err: errorMessage(error),
          }),
        );
      }
    }
    if (this.#client !== client) return; // the connection cycled mid-fetch
    await this.#publishSyncQueue(client);
    this.#armTmsWatchdog();
  }

  /** Clears the sync cursor and notifies listeners so it can be persisted. */
  #resetSyncCursor(): void {
    this.#syncToken = null;
    this.#lastSeqId = null;
    this.#runCallback("onSyncUpdate", () => this.#deps.callbacks.onSyncUpdate(this.getCursor()));
  }

  /** Flushes the offline queue in order; keeps the remainder on failure. */
  async #drainQueue(client: MqttClient): Promise<number> {
    let drained = 0;
    while (this.#queue.length > 0 && this.#client === client) {
      const entry = this.#queue[0]!;
      try {
        await this.#publishNow(client, entry.topic, entry.payload, entry.qos, entry.retain, MQTT_CONNECT_TIMEOUT_MS);
      } catch {
        this.#runCallback("onWarning", () =>
          this.#deps.callbacks.onWarning(
            `failed to flush the offline MQTT queue at "${entry.topic}"; keeping ${this.#queue.length} packets queued`,
            { topic: entry.topic, queued: this.#queue.length },
          ),
        );
        break;
      }
      this.#queue.shift();
      this.#deps.diagnostics.setQueueDepth(this.#queue.length);
      drained += 1;
    }
    return drained;
  }

  /** Attaches the persistent handlers for one live connection. */
  #attachClientHandlers(client: MqttClient, generation: number): void {
    client.on("message", (topic, payload) => {
      if (generation !== this.#generation) return;
      this.#handleMessage(topic, payload);
    });
    client.on("packetsend", (packet: Packet) => {
      if (generation !== this.#generation) return;
      if (packet.cmd === "pingreq") {
        this.#pendingPingAt = Date.now();
        this.#deps.callbacks.onPingSent?.();
      }
    });
    client.on("packetreceive", (packet: Packet) => {
      if (generation !== this.#generation) return;
      this.#lastInboundAt = Date.now();
      if (packet.cmd === "pingresp" && this.#pendingPingAt !== null) {
        this.#deps.diagnostics.recordHeartbeat(Date.now() - this.#pendingPingAt);
        this.#pendingPingAt = null;
        this.#deps.callbacks.onPongReceived?.();
      }
    });
    client.on("error", (error) => {
      if (generation !== this.#generation) return;
      this.#logger.warn({ err: error.message }, "MQTT client error");
      // The close event follows and drives the reconnect cycle.
    });
    client.on("disconnect", () => {
      if (generation !== this.#generation) return;
      this.#handleConnectionEnd(client, generation, "server sent an MQTT disconnect packet");
    });
    client.on("close", () => {
      if (generation !== this.#generation) return;
      this.#handleConnectionEnd(client, generation, "connection closed");
    });
  }

  /** Tears down a dead connection and schedules the retry. */
  #handleConnectionEnd(client: MqttClient, generation: number, reason: string): void {
    if (generation !== this.#generation || this.#client !== client) return;
    // Invalidate this client's remaining handlers.
    this.#generation += 1;
    this.#teardownConnection();
    this.#deps.diagnostics.recordDisconnect();
    this.#logger.info({ reason }, "MQTT connection ended");
    if (this.#closed) return;
    // A dial sweep in progress handles its own retries.
    if (this.#cycleRunning) return;
    this.#scheduleRetry(reason);
  }

  /** Clears all per-connection state. */
  #teardownConnection(): void {
    this.#client = null;
    this.#pendingPingAt = null;
    this.#stopHeartbeatWatchdog();
    this.#clearTmsTimer();
    this.#deps.diagnostics.setMqttConnected(false);
    this.#rejectPendingLsRequests(
      new MQTTError(
        "MQTT connection lost while awaiting a lightweight-service response",
        "MQTT_NOT_CONNECTED",
        { retryable: true },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Reconnect scheduling
  // -------------------------------------------------------------------------

  /** Records the failure, notifies, and schedules the next sweep. */
  #scheduleRetry(reason: string): void {
    if (this.#closed || this.#cycleRunning || this.#reconnectTimer !== null) return;
    this.#attempt += 1;
    if (this.#attempt > this.#config.reconnectAttempts) {
      const attempts = this.#config.reconnectAttempts;
      this.#attempt = 0;
      this.#logger.error({ reason, attempts }, "MQTT reconnection attempts exhausted");
      this.#rejectConnect(
        new MQTTError(`MQTT connection failed after ${attempts} attempt(s): ${reason}`, "MQTT_CONNECTION_FAILED", {
          retryable: false,
          context: { reason, attempts },
        }),
      );
      this.#runCallback("onReconnectExhausted", () =>
        this.#deps.callbacks.onReconnectExhausted({ reason, attempts }),
      );
      return;
    }
    const delayMs = this.#backoffDelayMs(this.#attempt);
    this.#logger.warn({ reason, attempt: this.#attempt, delayMs }, "MQTT connection lost; scheduling reconnect");
    this.#runCallback("onConnectionLost", () =>
      this.#deps.callbacks.onConnectionLost({ reason, attempt: this.#attempt, delayMs }),
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#cycle();
    }, delayMs);
  }

  /**
   * Jittered exponential backoff: `min(reconnectDelayMax, 1000·2^(n-1))`
   * scaled by a random factor in `[0.5, 1.5)`.
   */
  #backoffDelayMs(attempt: number): number {
    const base = Math.min(this.#config.reconnectDelayMax, 1000 * 2 ** (attempt - 1));
    return Math.max(1, Math.round(base * (0.5 + Math.random())));
  }

  // -------------------------------------------------------------------------
  // Watchdogs
  // -------------------------------------------------------------------------

  #armTmsWatchdog(): void {
    this.#clearTmsTimer();
    this.#tmsTimer = setTimeout(() => {
      this.#tmsTimer = null;
      const client = this.#client;
      if (client === null) return;
      this.#logger.warn({}, "no /t_ms arrived after queue creation; cycling connection");
      this.#runCallback("onWarning", () =>
        this.#deps.callbacks.onWarning("no /t_ms received after sync queue creation; reconnecting", {}),
      );
      this.#forceEnd(client);
    }, TMS_TIMEOUT_MS);
  }

  #clearTmsTimer(): void {
    if (this.#tmsTimer === null) return;
    clearTimeout(this.#tmsTimer);
    this.#tmsTimer = null;
  }

  #startHeartbeatWatchdog(): void {
    this.#stopHeartbeatWatchdog();
    this.#watchdogTimer = setInterval(() => {
      const pending = this.#pendingPingAt;
      if (pending === null) return;
      const now = Date.now();
      if (now - pending > this.#config.heartbeatTimeout * 1000 && this.#lastInboundAt < pending) {
        this.#pendingPingAt = null;
        this.#deps.diagnostics.recordMissedHeartbeat();
        this.#logger.warn({ sinceMs: now - pending }, "heartbeat response overdue; forcing reconnect");
        const client = this.#client;
        if (client !== null) this.#forceEnd(client);
      }
    }, HEARTBEAT_WATCHDOG_INTERVAL_MS);
  }

  #stopHeartbeatWatchdog(): void {
    if (this.#watchdogTimer === null) return;
    clearInterval(this.#watchdogTimer);
    this.#watchdogTimer = null;
  }

  #forceEnd(client: MqttClient): void {
    try {
      client.end(true);
    } catch {
      // Already ending; the close handler takes over.
    }
  }

  // -------------------------------------------------------------------------
  // Inbound messages
  // -------------------------------------------------------------------------

  #handleMessage(topic: string, payload: Buffer): void {
    this.#deps.diagnostics.recordMqttMessageReceived();
    let json: unknown;
    try {
      json = JSON.parse(payload.toString("utf8"));
    } catch {
      this.#runCallback("onWarning", () =>
        this.#deps.callbacks.onWarning(`dropped a non-JSON MQTT payload on "${topic}"`, { topic }),
      );
      return;
    }
    if (topic === TOPIC_MS) this.#handleTms(json);
    if (topic === TOPIC_LS_RESP) this.#handleLsResp(json);
    this.#runCallback("onMessage", () => this.#deps.callbacks.onMessage(topic, json));
  }

  /** Applies sync bookkeeping to a `/t_ms` payload. */
  #handleTms(json: unknown): void {
    const parsed = TmsEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      this.#runCallback("onWarning", () =>
        this.#deps.callbacks.onWarning("dropped a /t_ms payload that is not a sync envelope", {
          reason: parsed.error.message,
        }),
      );
      return;
    }
    const message = parsed.data;
    const client = this.#client;

    // The reference clients treat these branches as mutually exclusive: the
    // first /t_ms after queue creation carries the sync token and the first
    // delta sequence id; later messages carry either an error code or the
    // high-water sequence id.
    if (message.syncToken !== undefined && message.firstDeltaSeqId !== undefined) {
      const seqId = toSeqId(message.firstDeltaSeqId);
      if (seqId !== null) {
        this.#lastSeqId = seqId;
        this.#syncToken = message.syncToken;
        this.#runCallback("onSyncUpdate", () => this.#deps.callbacks.onSyncUpdate(this.getCursor()));
      }
    } else if (message.errorCode !== undefined) {
      if (typeof message.errorCode === "string" && QUEUE_LOST_ERROR_CODES.has(message.errorCode)) {
        this.#logger.warn({ errorCode: message.errorCode }, "sync queue lost; recreating");
        // The cursor is dead either way; only the republish needs a client.
        this.#resetSyncCursor();
        if (client !== null) {
          void this.#recreateSyncQueue(client).catch((error: unknown) => {
            this.#logger.error({ err: errorMessage(error) }, "failed to recreate the sync queue");
            this.#runCallback("onWarning", () =>
              this.#deps.callbacks.onWarning("failed to recreate the sync queue after a queue-lost error", {
                err: errorMessage(error),
              }),
            );
          });
        }
      } else {
        this.#runCallback("onWarning", () =>
          this.#deps.callbacks.onWarning(`sync error code ${String(message.errorCode)} received`, {
            errorCode: message.errorCode,
          }),
        );
      }
    } else if (message.lastIssuedSeqId !== undefined) {
      // Present on every other /t_ms: the high-water sequence id.
      const seqId = toSeqId(message.lastIssuedSeqId);
      if (seqId !== null && seqId !== this.#lastSeqId) {
        this.#lastSeqId = seqId;
        this.#runCallback("onSyncUpdate", () => this.#deps.callbacks.onSyncUpdate(this.getCursor()));
      }
    }

    this.#markSyncEstablished();
  }

  /** Fires `onSyncEstablished` once per connection, on the first `/t_ms`. */
  #markSyncEstablished(): void {
    if (this.#syncEstablishedOnConnection) return;
    this.#syncEstablishedOnConnection = true;
    // Read before flipping: a previous connection may already have synced.
    const reconnect = this.#everSyncEstablished;
    this.#everSyncEstablished = true;
    this.#clearTmsTimer();
    const attempt = this.#attemptAtConnect;
    const drained = this.#drainedThisConnection;
    this.#runCallback("onSyncEstablished", () =>
      this.#deps.callbacks.onSyncEstablished({ reconnect, attempt, drained }),
    );
  }

  /** Correlates an `/ls_resp` with its pending request. */
  #handleLsResp(json: unknown): void {
    const parsed = LsRespEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      this.#runCallback("onWarning", () =>
        this.#deps.callbacks.onWarning("dropped an /ls_resp payload that is not a response envelope", {
          reason: parsed.error.message,
        }),
      );
      return;
    }
    const pending = this.#lsRequests.get(String(parsed.data.request_id));
    if (pending === undefined) return;
    const payload = parsed.data.payload;
    if (payload === undefined) {
      pending.finish(null, null);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      pending.finish(null, null);
      this.#runCallback("onWarning", () =>
        this.#deps.callbacks.onWarning("an /ls_resp carried an unparseable payload", {}),
      );
      return;
    }
    pending.finish(null, value);
  }

  // -------------------------------------------------------------------------
  // Shared plumbing
  // -------------------------------------------------------------------------

  /** Publishes on a live client, with an optional deadline. */
  #publishNow(
    client: MqttClient,
    topic: string,
    payload: string,
    qos: 0 | 1,
    retain: boolean,
    timeoutMs?: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              if (settled) return;
              settled = true;
              reject(
                new TimeoutError(`MQTT publish to "${topic}" timed out after ${timeoutMs}ms`, {
                  context: { topic },
                }),
              );
            }, timeoutMs);
      try {
        client.publish(topic, payload, { qos, retain }, (error) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          if (error) {
            reject(
              new MQTTError(`MQTT publish to "${topic}" failed: ${error.message}`, "MQTT_CONNECTION_FAILED", {
                retryable: true,
                cause: error,
                context: { topic },
              }),
            );
          } else {
            this.#deps.diagnostics.recordMqttMessageSent();
            resolve();
          }
        });
      } catch (error) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        reject(
          new MQTTError(`MQTT publish to "${topic}" failed: ${errorMessage(error)}`, "MQTT_CONNECTION_FAILED", {
            retryable: true,
            ...(error instanceof Error ? { cause: error } : {}),
          }),
        );
      }
    });
  }

  /** Rejects every pending lightweight-service request. */
  #rejectPendingLsRequests(error: Error): void {
    for (const pending of [...this.#lsRequests.values()]) {
      clearTimeout(pending.timer);
      pending.finish(error, null);
    }
    this.#lsRequests.clear();
  }

  #resolveConnect(): void {
    const deferred = this.#connectDeferred;
    this.#connectDeferred = null;
    if (deferred !== null) deferred.resolve();
  }

  #rejectConnect(error: Error): void {
    const deferred = this.#connectDeferred;
    this.#connectDeferred = null;
    if (deferred !== null) deferred.reject(error);
  }

  /** Invokes an owner callback, logging instead of throwing. */
  #runCallback(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.#logger.error({ callback: what, err: errorMessage(error) }, "transport callback threw");
    }
  }
}
