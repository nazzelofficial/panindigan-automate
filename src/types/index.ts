/**
 * Public type surface.
 *
 * Every type reachable from `panindigan-automate`'s root export is declared
 * or re-exported here. Interfaces are treated as contracts: field names and
 * optionality match the documented API.
 */

import type { Logger, LogTransport } from "../logger/index.js";
import type { StealthConfig, SuspensionSignal } from "../stealth/index.js";

export type { LogTransport };

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * One cookie in the AppState array format. `key`/`value` are required; every
 * other attribute is optional and preserved when present.
 */
export interface AppStateCookie {
  readonly key: string;
  readonly value: string;
  readonly domain?: string | undefined;
  readonly path?: string | undefined;
  readonly expires?: string | undefined;
  readonly expirationDate?: number | undefined;
  readonly hostOnly?: boolean | undefined;
  readonly httpOnly?: boolean | undefined;
  readonly secure?: boolean | undefined;
  readonly sameSite?: string | undefined;
}

/**
 * One entry of an AppState object, keyed by cookie name. Only `value` is
 * required.
 */
export interface AppStateObjectEntry {
  readonly value: string;
  readonly domain?: string | undefined;
  readonly path?: string | undefined;
  readonly expires?: string | undefined;
  readonly expirationDate?: number | undefined;
  readonly hostOnly?: boolean | undefined;
  readonly httpOnly?: boolean | undefined;
  readonly secure?: boolean | undefined;
  readonly sameSite?: string | undefined;
}

/** AppState object format: cookie name to cookie entry. */
export type AppStateObject = Readonly<Record<string, AppStateObjectEntry>>;

/**
 * One cookie in the plain cookie array format (`name`/`value` pairs).
 */
export interface CookieEntry {
  readonly name: string;
  readonly value: string;
  readonly domain?: string | undefined;
  readonly path?: string | undefined;
  readonly expires?: string | number | null | undefined;
  readonly httpOnly?: boolean | undefined;
  readonly secure?: boolean | undefined;
  readonly sameSite?: string | undefined;
}

/**
 * Credential input accepted by `login()`. Six formats, detected
 * automatically: an AppState array, an AppState object, a JSON file path, an
 * environment variable name, a cookie array, or a raw cookie header string.
 */
export type Credentials =
  | string
  | readonly AppStateCookie[]
  | AppStateObject
  | readonly CookieEntry[];

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

/**
 * Cache adapter interface. The default implementation is an in-memory LRU
 * with per-entity TTLs; custom adapters (Redis, SQLite, …) implement this.
 */
export interface CacheAdapter {
  /** Reads a value. Resolves `null` on miss or TTL expiry. */
  get<T>(key: string): Promise<T | null>;
  /** Writes a value with optional TTL (seconds) and tags. */
  set(
    key: string,
    value: unknown,
    options?: { readonly ttlSeconds?: number | undefined; readonly tags?: readonly string[] | undefined },
  ): Promise<void>;
  /** Deletes one key. */
  delete(key: string): Promise<void>;
  /** Cache-aside helper: read, or load and store. */
  fetch<T>(
    key: string,
    options: { readonly ttlSeconds?: number | undefined; readonly tags?: readonly string[] | undefined },
    loader: () => Promise<T>,
  ): Promise<T>;
  /** Removes every entry carrying the given tag. */
  invalidateTag(tag: string): Promise<void>;
  /** Removes every entry. */
  clear(): Promise<void>;
  /** Cache statistics since the last reset. */
  stats(): { hits: number; misses: number; hitRate: number; sets: number; invalidations: number };
}

/**
 * Storage adapter interface for session persistence. Values are JSON-safe.
 * The default adapters are in-memory and file-based (atomic writes).
 */
export interface StorageAdapter {
  /** Reads a value, or `null` when absent. */
  get<T>(key: string): Promise<T | null>;
  /** Writes a value. */
  set(key: string, value: unknown): Promise<void>;
  /** Deletes a key. */
  delete(key: string): Promise<void>;
  /** Lists stored keys, in lexicographic order. */
  keys(): Promise<readonly string[]>;
  /** Deletes every key. */
  clear(): Promise<void>;
}

/**
 * Constructor options for `MessengerClient`. Every field is optional;
 * credentials go to `login()`.
 */
export interface ClientOptions {
  /** `trace` … `fatal`, or `silent`. Default `info`. */
  readonly logLevel?: string | undefined;
  /** Pretty-print logs (requires `pino-pretty` installed). Default `false`. */
  readonly prettyPrint?: boolean | undefined;
  /** Use the colorized console logger instead of pino for this client. Default false. */
  readonly useConsoleLogger?: boolean | undefined;
  /** File path to mirror logs into. */
  readonly logFile?: string | undefined;
  /** Additional log transports receiving every record. */
  readonly logTransports?: readonly LogTransport[] | undefined;
  /** Per-request HTTP timeout, ms. Default `30000`. */
  readonly httpTimeout?: number | undefined;
  /** Retries on network errors and 429/5xx. Default `3`. */
  readonly httpRetries?: number | undefined;
  /** Maximum redirects followed. Default `5`. */
  readonly httpMaxRedirects?: number | undefined;
  /** HTTP or SOCKS5 proxy URL. */
  readonly httpProxy?: string | undefined;
  /** User-Agent sent with every request. */
  readonly userAgent?: string | undefined;
  /** MQTT keepalive interval, seconds. Default `60`. */
  readonly heartbeatInterval?: number | undefined;
  /** Seconds to wait for a PINGRESP before a ping counts as missed. Default `5`. */
  readonly heartbeatTimeout?: number | undefined;
  /** Reconnect attempts before giving up. Default `Infinity`. */
  readonly reconnectAttempts?: number | undefined;
  /** Reconnect backoff cap, ms. Default `30000`. */
  readonly reconnectDelayMax?: number | undefined;
  /** Outgoing MQTT packets queued while disconnected. Default `500`. */
  readonly mqttQueueMaxSize?: number | undefined;
  /** LRU cache capacity. Default `5000`. */
  readonly cacheMaxItems?: number | undefined;
  /** Persist the cookie jar and session metadata. Default `true`. */
  readonly persistSession?: boolean | undefined;
  /** `"memory"`, `"file"`, or a custom adapter. Default `"file"`. */
  readonly storageAdapter?: "memory" | "file" | StorageAdapter | undefined;
  /** Directory the file adapter writes to. Default `"./panindigan-session"`. */
  readonly storageDirectory?: string | undefined;
  /** HTTP ping at login confirming cookies are accepted. Default `true`. */
  readonly validateOnLogin?: boolean | undefined;
  /** Plugins to register at construction. */
  readonly plugins?: readonly PluginRegistration[] | undefined;
  /**
   * Stealth Guard overrides. Defaults: `enabled: true`, conservative caps
   * (30/thread/hour, 100/hour and 200/day globally), 7-day warmup, 24h
   * cooldown. Pass `{ enabled: false }` to disable entirely.
   */
  readonly stealth?: Partial<StealthConfig> | undefined;
  /**
   * Dry-run mode: every outbound operation logs the payload it *would*
   * send and none of it hits the network. Results are synthetic and
   * clearly tagged. Default `false`.
   */
  readonly dryRun?: boolean | undefined;
  /**
   * E2EE for 1:1 threads — a faithful port of bhhoang/fbapi-unofficial's
   * Signal Protocol + Noise XX transport (MIT), with attribution in the
   * source files. `"auto"` connects at login and enables encrypted 1:1
   * sends/receives; `"require"` fails login when the encrypted channel
   * cannot be established; `"off"` (default) leaves it disabled.
   *
   * Scope in this release: text messages only, 1:1 threads. Group chats
   * (sender keys), attachments and encrypted backup restore are NOT
   * implemented. The device identity persists at
   * `<storageDirectory>/e2ee_device.json` unless `deviceStorePath` is set —
   * keep the file; deleting it re-registers a new device.
   */
  readonly e2ee?:
    | "auto"
    | "require"
    | "off"
    | {
        readonly enabled?: boolean | undefined;
        readonly require?: boolean | undefined;
        readonly autoConnect?: boolean | undefined;
        readonly selfListen?: boolean | undefined;
        readonly deviceListCacheMs?: number | undefined;
        readonly deviceStorePath?: string | undefined;
      }
    | undefined;
  /**
   * Update checker. Automatic and on by default since 0.2.0 — a client
   * constructed with no `update` options checks on startup and every 24h,
   * and installs newer published versions automatically (backup + rollback;
   * a process restart is required). Opt out with `enabled: false` (off) or `autoInstall: false` (notices only).
   */
  readonly update?: {
    /** Master switch. Default `true` — checks and installs automatically unless `false`. */
    readonly enabled?: boolean | undefined;
    /** Check on startup. Default true. */
    readonly checkOnStartup?: boolean | undefined;
    /** Install automatically when an update is found. Default `true`. */
    readonly autoInstall?: boolean | undefined;
    /** Minimum ms between registry checks. Default 24h. */
    readonly checkIntervalMs?: number | undefined;
    /** Alias of `checkIntervalMs` (accepted for convenience). */
    readonly checkInterval?: number | undefined;
    /** Package manager override. Auto-detected from the lockfile when unset. */
    readonly packageManager?: "npm" | "pnpm" | "yarn" | undefined;
    /** npm dist-tag to follow. Default `"latest"`. */
    readonly releaseChannel?: string | undefined;
    /** Registry request timeout in ms. Default 30000. */
    readonly timeout?: number | undefined;
    /** Restart the process after a successful install. Default `false`. */
    readonly autoRestart?: boolean | undefined;
    /** Allow installing prereleases. Default `false`. */
    readonly allowPrerelease?: boolean | undefined;
  } | undefined;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Session lifecycle states, in transition order. */
export type SessionState =
  | "UNINITIALIZED"
  | "AUTHENTICATING"
  | "ACTIVE"
  | "RECONNECTING"
  | "CLOSING"
  | "CLOSED";

/**
 * Non-sensitive session metadata, as returned by `getSession()`.
 */
export interface SessionInfo {
  /** Facebook user id of the authenticated account. */
  readonly userId: string;
  /** Current state machine state. */
  readonly state: SessionState;
  /** Whether the MQTT connection is currently established. */
  readonly connected: boolean;
  /** Epoch ms of the current MQTT connection, or `null`. */
  readonly connectedSince: number | null;
  /** Last processed sync sequence id. */
  readonly lastSeqId: number | null;
  /** Sync token returned by Facebook, when one has been issued. */
  readonly syncToken: string | null;
  /** Epoch ms of login. */
  readonly loginTime: number;
  /** Completed reconnects since login. */
  readonly reconnects: number;
}

/** Result of a successful `login()`. */
export interface LoginResult {
  /** Facebook user id of the authenticated account. */
  readonly userId: string;
  /** Whether session metadata (sequence id, sync token) was restored from storage. */
  readonly restored: boolean;
}

/** Why the session ended. */
export type LogoutReason = "user" | "expired" | "invalid" | "error";

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/** A mention inside a message body. */
export interface Mention {
  /** User id of the mentioned account. */
  readonly id: string;
  /** The exact body substring covered by the mention. */
  readonly tag: string;
  /** Where the tag starts in the body, when known. */
  readonly fromIndex?: number | undefined;
}

/** Sendable message content, discriminated by `type`. */
export type MessageContent =
  | TextContent
  | StickerContent
  | GifContent
  | AttachmentContent;

/** A text message, optionally with mentions. */
export interface TextContent {
  readonly type: "text";
  readonly body: string;
  readonly mentions?: readonly Mention[] | undefined;
}

/** A sticker, by id. */
export interface StickerContent {
  readonly type: "sticker";
  readonly stickerId: string;
}

/** A GIF, by id from `uploadMedia`. */
export interface GifContent {
  readonly type: "gif";
  readonly gifId: string;
}

/** A previously uploaded attachment, by id from `uploadMedia`. */
export interface AttachmentContent {
  readonly type: "attachment";
  readonly attachmentId: string;
}

/** Result of sending a message. */
export interface MessageSendResult {
  /** Facebook message id of the sent message. */
  readonly messageId: string;
  /** Thread the message was sent to. */
  readonly threadId: string;
  /** Offline threading id generated for the send. */
  readonly offlineThreadingId: string;
}

/** A reaction emoji: a known name (`"like"`, `"love"`, …) or any emoji character. */
export type Reaction = keyof typeof import("../constants.js").REACTION_EMOJI | (string & {});

/** A file to upload: filesystem path, buffer, or stream. */
export type FileInput = string | Buffer | NodeJS.ReadableStream;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Attachment kinds surfaced by the library. */
export type AttachmentType =
  | "photo"
  | "animated_image"
  | "video"
  | "audio"
  | "file"
  | "sticker"
  | "share"
  | "unknown";

/**
 * An attachment on a message, normalized across Mercury and GraphQL shapes.
 */
export interface Attachment {
  readonly type: AttachmentType;
  /** Attachment id, usable with `downloadAttachment` / forwarding. */
  readonly id: string;
  readonly filename: string | null;
  /** Best known downloadable or playable URL. */
  readonly url: string | null;
  readonly previewUrl: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly mimeType: string | null;
  /** Content length in bytes, when reported. */
  readonly size: number | null;
  /** Duration in milliseconds for time-based media. */
  readonly durationMs: number | null;
  /** Sticker id, for sticker attachments. */
  readonly stickerId: string | null;
  /** Remaining raw fields, for forward compatibility. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** A reaction on a message. */
export interface MessageReaction {
  readonly userId: string;
  readonly emoji: string;
}

/** A message, as delivered by events and history. */
export interface Message {
  readonly id: string;
  readonly threadId: string;
  readonly senderId: string;
  readonly body: string | null;
  readonly attachments: readonly Attachment[];
  readonly mentions: readonly Mention[];
  readonly reactions: readonly MessageReaction[];
  /** Epoch ms of the message. */
  readonly timestamp: number;
  readonly isRead: boolean;
  /** Whether the sender is the authenticated account. */
  readonly isSelf: boolean;
  /** `"message"` for user messages, `"system"` for thread-log entries. */
  readonly kind: "message" | "system";
  /** System entry subtype, when `kind` is `"system"`. */
  readonly systemType: string | null;
  /** System entry raw data, when `kind` is `"system"`. */
  readonly systemData: Readonly<Record<string, unknown>>;
}

/** A thread participant. */
export interface ThreadParticipant {
  readonly id: string;
  readonly name: string | null;
  /** Account kind: `user`, `group`, `page`, `reduce`, or an internal label. */
  readonly accountType: string | null;
}

/** Thread metadata, from `getThread` / `getThreadList`. */
export interface ThreadInfo {
  readonly id: string;
  readonly name: string | null;
  readonly isGroup: boolean;
  readonly participantIds: readonly string[];
  readonly participants: readonly ThreadParticipant[];
  /** IDs of the group's administrators (empty for 1:1 threads). */
  readonly adminIDs: readonly string[];
  readonly unreadCount: number;
  readonly emoji: string | null;
  readonly color: string | null;
  readonly nicknames: Readonly<Record<string, string>>;
  readonly photoUrl: string | null;
  readonly lastMessageTimestamp: number | null;
  readonly lastReadTimestamp: number | null;
  readonly isArchived: boolean | null;
  readonly muteUntil: number | null;
  readonly canReply: boolean;
  readonly snippet: string | null;
  /** Epoch ms of the thread's last activity. */
  readonly updatedAt: number;
}

/** A user profile. */
export interface UserInfo {
  readonly id: string;
  readonly name: string | null;
  readonly firstName: string | null;
  readonly vanity: string | null;
  readonly profileUrl: string | null;
  readonly photoUrl: string | null;
  readonly gender: string | null;
  readonly isFriend: boolean;
  readonly isVerified: boolean;
  readonly isBirthday: boolean;
  readonly type: string | null;
}

/** A poll option. */
export interface PollOption {
  readonly id: string;
  readonly text: string;
  readonly voters: readonly string[];
  readonly voteCount: number;
  readonly viewerHasVoted: boolean;
}

/** Poll state, from `getPoll`. */
export interface PollInfo {
  readonly id: string;
  readonly question: string;
  readonly options: readonly PollOption[];
  readonly optionCount: number;
}

/** Presence status of a user. */
export type PresenceStatus = "online" | "idle" | "offline" | "unknown";

/** Presence snapshot, from `getPresence`. */
export interface PresenceInfo {
  readonly userId: string;
  readonly status: PresenceStatus;
  /** Epoch ms of last activity, when known. */
  readonly lastActive: number | null;
  /** Epoch ms when this observation was recorded. */
  readonly updatedAt: number;
}

/** Uploaded media metadata, from `uploadMedia` / `getMediaInfo`. */
export interface MediaInfo {
  /** Attachment id usable with `sendMessage` and forwarding. */
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string | null;
  readonly size: number | null;
  /** Entity kind the id is valid for: image, gif, file, video, or audio. */
  readonly kind: "image" | "gif" | "file" | "video" | "audio";
}

/** Result of `uploadMedia` and `getMediaInfo`. */
export type UploadResult = MediaInfo;

/** A user search hit. */
export interface UserSearchResult {
  readonly id: string;
  readonly name: string | null;
  readonly photoUrl: string | null;
  readonly profileUrl: string | null;
  readonly isVerified: boolean;
  readonly category: string | null;
}

// ---------------------------------------------------------------------------
// Method option/result shapes
// ---------------------------------------------------------------------------

/** Options for `getThreadList`. */
export interface ThreadListOptions {
  /** Threads per page. Default `20`. */
  readonly limit?: number | undefined;
  /** Pagination cursor from a previous result. */
  readonly cursor?: string | undefined;
  /** Inbox filter tags, e.g. `["INBOX"]`. */
  readonly tags?: readonly string[] | undefined;
}

/** Result of `getThreadList`. */
export interface ThreadListResult {
  readonly threads: readonly ThreadInfo[];
  /** Cursor for the next page, or `null` at the end. */
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

/** Options for `getMessages`. */
export interface MessageListOptions {
  /** Messages per page. Default `20`. */
  readonly limit?: number | undefined;
  /** Return messages strictly older than this epoch ms. */
  readonly before?: number | undefined;
}

/** Result of `getMessages`. */
export interface MessageListResult {
  readonly messages: readonly Message[];
  readonly hasMore: boolean;
}

/** Options for `searchMessages`. */
export interface MessageSearchOptions {
  /** Maximum results. Default `20`. */
  readonly limit?: number | undefined;
}

/** Result of `searchMessages`. */
export interface MessageSearchResult {
  readonly messageId: string;
  readonly threadId: string;
  readonly senderId: string;
  readonly body: string | null;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Base of every event payload. */
export interface BaseEventPayload {
  readonly timestamp: number;
}

/** Emitted once login finished and the realtime connection is up. */
export interface ReadyEvent extends BaseEventPayload {
  readonly type: "ready";
  readonly userId: string;
}

/** Emitted when authentication completes. */
export interface LoginEvent extends BaseEventPayload {
  readonly type: "login";
  readonly userId: string;
}

/** Emitted when the session ends. */
export interface LogoutEvent extends BaseEventPayload {
  readonly type: "logout";
  readonly userId: string;
  readonly reason: LogoutReason;
}

/** Fields shared by message and message-reply events. */
export interface MessageEventBase extends BaseEventPayload {
  readonly messageId: string;
  readonly threadId: string;
  readonly senderId: string;
  readonly isGroup: boolean;
  readonly body: string | null;
  readonly attachments: readonly Attachment[];
  readonly mentions: readonly Mention[];
  readonly isSelf: boolean;
}

/** A new message in any thread. */
export interface MessageEvent extends MessageEventBase {
  readonly type: "message";
}

/** A message that replies to another message. */
export interface MessageReplyEvent extends MessageEventBase {
  readonly type: "message_reply";
  readonly repliedToMessageId: string;
}

/** A participant unsent (removed) a message. */
export interface MessageUnsendEvent extends BaseEventPayload {
  readonly type: "message_unsend";
  readonly threadId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly isSelf: boolean;
}

/** A reaction was added or removed. */
export interface ReactionEvent extends BaseEventPayload {
  readonly type: "reaction";
  readonly threadId: string;
  readonly messageId: string;
  readonly userId: string;
  /** The emoji added, or `null` when the reaction was removed. */
  readonly emoji: string | null;
  readonly isSelf: boolean;
}

/** A participant started or stopped typing. */
export interface TypingEvent extends BaseEventPayload {
  readonly type: "typing";
  readonly threadId: string;
  readonly userId: string;
  readonly isTyping: boolean;
}

/** A contact's presence changed. */
export interface PresenceEvent extends BaseEventPayload {
  readonly type: "presence";
  readonly userId: string;
  readonly status: PresenceStatus;
  readonly lastActive: number | null;
}

/** A thread was marked read. */
export interface ReadReceiptEvent extends BaseEventPayload {
  readonly type: "read";
  readonly threadId: string;
  readonly readerId: string;
  /** Epoch ms watermark up to which the thread was read. */
  readonly watermark: number | null;
  readonly isSelf: boolean;
}

/** A message reached a participant's device. */
export interface DeliveredEvent extends BaseEventPayload {
  readonly type: "delivered";
  readonly threadId: string;
  readonly deliveredTo: string;
  readonly messageIds: readonly string[];
  readonly isSelf: boolean;
}

/** Someone was added to a group thread. */
export interface ParticipantJoinEvent extends BaseEventPayload {
  readonly type: "participant_join";
  readonly threadId: string;
  readonly addedIds: readonly string[];
  readonly addedBy: string;
  readonly isSelf: boolean;
}

/** Someone left or was removed from a group thread. */
export interface ParticipantLeaveEvent extends BaseEventPayload {
  readonly type: "participant_leave";
  readonly threadId: string;
  readonly removedIds: readonly string[];
  readonly removedBy: string;
  readonly isSelf: boolean;
}

/** Admin status changed in a group thread. */
export interface AdminChangeEvent extends BaseEventPayload {
  readonly type: "admin_change";
  readonly threadId: string;
  readonly userId: string;
  /** Whether the user was promoted. */
  readonly promoted: boolean;
  readonly isSelf: boolean;
}

/** What changed in a thread update. */
export type ThreadUpdateAction =
  | "name"
  | "color"
  | "emoji"
  | "photo"
  | "icon"
  | "nickname"
  | "approval_queue"
  | "mode"
  | "unknown";

/** A thread settings change. */
export interface ThreadUpdateEvent extends BaseEventPayload {
  readonly type: "thread_update";
  readonly threadId: string;
  readonly actorId: string;
  readonly action: ThreadUpdateAction;
  /** Action-specific details. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly isSelf: boolean;
}

/** Poll lifecycle activity. */
export interface PollEvent extends BaseEventPayload {
  readonly type: "poll";
  readonly threadId: string;
  readonly pollId: string;
  /** What happened. */
  readonly action: "created" | "voted" | "ended";
  /** Poll question, when carried by the payload. */
  readonly question: string | null;
  /** Options, when carried by the payload. */
  readonly options: readonly PollOption[];
  /** Who acted, when known. */
  readonly actorId: string | null;
  readonly isSelf: boolean;
}

/** What happened with a call. */
export type CallAction = "started" | "joined" | "declined" | "missed" | "ended";

/** Call activity in a thread. */
export interface CallEvent extends BaseEventPayload {
  readonly type: "call";
  readonly threadId: string;
  readonly callId: string;
  readonly callerId: string;
  readonly action: CallAction;
  readonly isVideo: boolean | null;
  readonly isSelf: boolean;
}

/** The realtime connection was re-established after a drop. */
export interface ReconnectEvent extends BaseEventPayload {
  readonly type: "reconnect";
  readonly attempt: number;
  /** Packets drained from the offline queue after reconnecting. */
  readonly drained: number;
}

/** The realtime connection was lost and not recovered. */
export interface DisconnectEvent extends BaseEventPayload {
  readonly type: "disconnect";
  /** Human-readable reason. */
  readonly reason: string;
  readonly attempts: number;
}

/** An internal, non-request error. */
export interface ErrorEvent extends BaseEventPayload {
  readonly type: "error";
  readonly error: import("../errors/index.js").LibraryError;
}

/** A non-fatal issue: dropped packet, full queue, retry. */
export interface WarningEvent extends BaseEventPayload {
  readonly type: "warning";
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
}

/** Internal debug output, emitted at `debug`/`trace` log levels. */
export interface DebugEvent extends BaseEventPayload {
  readonly type: "debug";
  readonly module: string;
  readonly message: string;
  readonly data: unknown;
}

/** Every MQTT payload before parsing. */
export interface RawDeltaEvent extends BaseEventPayload {
  readonly type: "raw";
  readonly topic: string;
  readonly payload: unknown;
}

/** A suspension signal was observed. */
export interface SuspensionWarningEvent extends BaseEventPayload {
  readonly type: "suspension_warning";
  readonly signal: SuspensionSignal;
}

/** The circuit breaker opened; proactive sends are halted. */
export interface SuspensionHaltEvent extends BaseEventPayload {
  readonly type: "suspension_halt";
  readonly reason: string;
  /** Milliseconds until the earliest possible reset. */
  readonly cooldownMs: number;
}

/** A manual guard reset succeeded after the cooldown. */
export interface SuspensionResetEvent extends BaseEventPayload {
  readonly type: "suspension_reset";
}

/** Facebook demanded an identity verification (checkpoint). */
export interface CheckpointEvent extends BaseEventPayload {
  readonly type: "checkpoint";
  readonly operation: string;
  readonly code: number | string | undefined;
  readonly detail: string;
}

/** Session health dropped to the warning band. */
export interface HealthWarningEvent extends BaseEventPayload {
  readonly type: "health_warning";
  readonly score: number;
}

/** Session health dropped to the critical band. */
export interface HealthCriticalEvent extends BaseEventPayload {
  readonly type: "health_critical";
  readonly score: number;
}

/** The session died mid-run and could not be re-validated; halted. */
export interface SessionDeadEvent extends BaseEventPayload {
  readonly type: "session_dead";
  readonly reason: string;
}

/** Outbound behavior is trending toward restriction risk. */
export interface RiskRisingEvent extends BaseEventPayload {
  readonly type: "risk_rising";
  readonly metric: string;
  readonly detail: string;
}

/** An encrypted message received (or failed to decrypt). */
export interface E2eeMessageEvent extends MessageEventBase {
  readonly type: "e2ee_message";
  readonly isE2EE: true;
  /** False when decryption failed; body is null in that case. */
  readonly decryptFailed: boolean;
}

/** An edit to an encrypted message. */
export interface E2eeMessageEditEvent extends BaseEventPayload {
  readonly type: "e2ee_message_edit";
  readonly isE2EE: true;
  readonly threadId: string;
  readonly messageId: string;
  readonly newBody: string | null;
  readonly decryptFailed: boolean;
}

/** A reaction on an encrypted message. */
export interface E2eeMessageReactionEvent extends BaseEventPayload {
  readonly type: "e2ee_message_reaction";
  readonly isE2EE: true;
  readonly threadId: string;
  readonly messageId: string;
  readonly userId: string;
  readonly emoji: string | null;
  readonly isSelf: boolean;
}

/** Mapping of event names to payload types. */
export interface EventPayloadMap {
  readonly ready: ReadyEvent;
  readonly login: LoginEvent;
  readonly logout: LogoutEvent;
  readonly message: MessageEvent;
  readonly message_reply: MessageReplyEvent;
  readonly message_unsend: MessageUnsendEvent;
  readonly reaction: ReactionEvent;
  readonly typing: TypingEvent;
  readonly presence: PresenceEvent;
  readonly read: ReadReceiptEvent;
  readonly delivered: DeliveredEvent;
  readonly participant_join: ParticipantJoinEvent;
  readonly participant_leave: ParticipantLeaveEvent;
  readonly admin_change: AdminChangeEvent;
  readonly thread_update: ThreadUpdateEvent;
  readonly poll: PollEvent;
  readonly call: CallEvent;
  readonly reconnect: ReconnectEvent;
  readonly disconnect: DisconnectEvent;
  readonly error: ErrorEvent;
  readonly warning: WarningEvent;
  readonly debug: DebugEvent;
  readonly raw: RawDeltaEvent;
  readonly suspension_warning: SuspensionWarningEvent;
  readonly suspension_halt: SuspensionHaltEvent;
  readonly suspension_reset: SuspensionResetEvent;
  readonly checkpoint: CheckpointEvent;
  readonly health_warning: HealthWarningEvent;
  readonly health_critical: HealthCriticalEvent;
  readonly session_dead: SessionDeadEvent;
  readonly risk_rising: RiskRisingEvent;
  readonly e2ee_message: E2eeMessageEvent;
  readonly e2ee_message_edit: E2eeMessageEditEvent;
  readonly e2ee_message_reaction: E2eeMessageReactionEvent;
}

/** Names of all emittable events. */
export type EventName = keyof EventPayloadMap & string;

/** A listener for a named event. */
export type EventListener<E extends EventName> = (
  event: EventPayloadMap[E],
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Which side of the operation a hook wraps. */
export type MiddlewarePhase = "before" | "after" | "error";

/** Header view exposed to middleware. */
export interface HeadersView {
  get(name: string): string | null;
  set(name: string, value: string): void;
  has(name: string): boolean;
  delete(name: string): void;
  toJSON(): Readonly<Record<string, string>>;
}

/** A middleware hook. Call `next()` to continue the chain. */
export type MiddlewareHook = (
  context: MiddlewareContext,
  next: () => Promise<void>,
) => void | Promise<void>;

/** Context passed to middleware. */
export interface MiddlewareContext {
  /** Operation name, e.g. `"sendMessage"`. */
  readonly operation: string;
  /** The request, as it is about to be sent. */
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: HeadersView;
  };
  /** The response, populated in and after the `after` phase. */
  readonly response: {
    readonly status: number;
    readonly headers: HeadersView;
    readonly body: unknown;
  } | null;
  /** The failure, populated in the `error` phase. */
  readonly error: import("../errors/index.js").LibraryError | null;
  /** Free-form per-operation metadata. */
  readonly metadata: Record<string, unknown>;
}

/** Options when registering middleware. */
export interface MiddlewareRegistrationOptions {
  /** Restrict the hook to the named operations. Unset means all. */
  readonly operations?: readonly string[] | undefined;
  /** Registration label, used in debug output. */
  readonly name?: string | undefined;
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * A sandboxed cache scope: identical to `CacheAdapter`, but keys are
 * transparently prefixed with the plugin's name.
 */
export type NamespacedCache = CacheAdapter;

/**
 * A sandboxed storage scope: identical to `StorageAdapter`, but keys are
 * transparently prefixed with the plugin's name.
 */
export type NamespacedStorage = StorageAdapter;

/** The context handed to a plugin's `onLoad`. */
export interface PluginContext {
  /** The plugin's name. */
  readonly name: string;
  /** Child logger, tagged with the plugin's name. */
  readonly logger: Logger;
  /** Namespaced cache. */
  readonly cache: NamespacedCache;
  /** Namespaced storage. */
  readonly storage: NamespacedStorage;
  /**
   * Registers an event listener. Automatically removed when the plugin is
   * disabled or destroyed.
   */
  on<E extends EventName>(event: E, listener: EventListener<E>): () => void;
  /** Registers middleware scoped to the plugin. Removed with the plugin. */
  use(phase: MiddlewarePhase, hook: MiddlewareHook, options?: MiddlewareRegistrationOptions | undefined): void;
}

/** A plugin. All lifecycle hooks are optional. */
export interface Plugin {
  readonly name: string;
  readonly version: string;
  /** Called once at registration with the sandboxed context. */
  onLoad?(context: PluginContext): void | Promise<void>;
  /** Called when the plugin becomes active. */
  onEnable?(): void | Promise<void>;
  /** Called when the plugin is disabled. */
  onDisable?(): void | Promise<void>;
  /** Called on reload: disable, re-load, enable. */
  onReload?(): void | Promise<void>;
  /** Final teardown. */
  onDestroy?(): void | Promise<void>;
}

/** A plugin registration entry for `ClientOptions.plugins`. */
export interface PluginRegistration {
  readonly plugin: Plugin;
  /** Whether the plugin starts enabled. Default `true`. */
  readonly options?: { readonly enabled?: boolean | undefined } | undefined;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Latency statistics in milliseconds. */
export interface LatencyStats {
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

/** HTTP transport counters. */
export interface HttpDiagnostics {
  readonly requests: {
    readonly total: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly retried: number;
  };
  readonly latency: LatencyStats;
  readonly bytes: { readonly received: number; readonly sent: number };
}

/** MQTT transport counters. */
export interface MqttDiagnostics {
  readonly connected: boolean;
  readonly reconnects: number;
  readonly disconnects: number;
  readonly messagesReceived: number;
  readonly messagesSent: number;
  readonly heartbeat: {
    readonly lastMs: number | null;
    readonly avgMs: number | null;
    readonly minMs: number | null;
    readonly maxMs: number | null;
    readonly missed: number;
  };
  readonly queue: { readonly depth: number; readonly dropped: number };
}

/** Cache counters. */
export interface CacheDiagnostics {
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
  readonly sets: number;
  readonly invalidations: number;
}

/** Event emission counters. */
export interface EventDiagnostics {
  readonly total: number;
  /** Events emitted per second, measured over a recent window. */
  readonly throughput: number;
  /** Count per event name. */
  readonly counts: Readonly<Record<string, number>>;
}

/** Export file format for the diagnostics report. */
export type DiagnosticsExportFormat = "json" | "html";

/** Stealth Guard counters and the guard audit log, when the guard is enabled. */
export interface StealthDiagnostics {
  readonly enabled: boolean;
  readonly circuitState: string;
  readonly warmupDay: number;
  readonly warmupMultiplier: number;
  readonly signalsInWindow: number;
  readonly haltedAt: number | null;
  readonly caps: {
    readonly hour: { readonly count: number; readonly limit: number; readonly level: string };
    readonly day: { readonly count: number; readonly limit: number; readonly level: string };
  };
  readonly healthScore: number | null;
  /** Present when thread heat is tracked (own traffic only). */
  readonly threads?: {
    readonly tracked: number;
    readonly hottest: readonly {
      readonly threadId: string;
      readonly score: number;
    }[];
  } | undefined;
  readonly audit: {
    readonly total: number;
    readonly recent: readonly {
      readonly at: number;
      readonly decision: string;
      readonly reason: string;
      readonly operation?: string | undefined;
      readonly target?: string | undefined;
    }[];
  };
}

/** Process counters. */
export interface ProcessDiagnostics {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
}

/** The full diagnostics snapshot. */
export interface DiagnosticsSnapshot {
  readonly capturedAt: number;
  readonly uptimeMs: number;
  readonly http: HttpDiagnostics;
  readonly mqtt: MqttDiagnostics;
  readonly cache: CacheDiagnostics;
  readonly events: EventDiagnostics;
  readonly process: ProcessDiagnostics;
  /** Present when the Stealth Guard is wired up. */
  readonly stealth?: StealthDiagnostics | undefined;
}

/** Handle exposed as `client.diagnostics`. */
export interface DiagnosticsHandle {
  /** Returns an immutable snapshot of all counters. */
  getSnapshot(): DiagnosticsSnapshot;
  /** Zeroes every counter. */
  reset(): void;
  /** Self-contained JSON export of the snapshot. */
  exportJSON(): string;
  /** Self-contained HTML export of the snapshot (inline CSS, no external assets). */
  exportHTML(): string;
}
