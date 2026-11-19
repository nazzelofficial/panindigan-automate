# API Reference

Complete reference for `MessengerClient`, the primary entry point for Panindigan Automate.

```ts
import { login } from "panindigan-automate";

const client = await login("./appstate.json");
```

The main entry is `login()`; the modern `MessengerClient` constructor below is fully supported for explicit construction and the `ready` event. Both share the same event surface.

```ts
// Equivalent
const client = new MessengerClient();
await client.login("./appstate.json");
```

---

## Table of Contents

- [Constructor](#constructor)
- [Lifecycle & Session](#lifecycle--session)
- [Messaging](#messaging)
- [Reactions](#reactions)
- [Media & Attachments](#media--attachments)
- [Threads](#threads)
- [Group Management](#group-management)
- [Users & Search](#users--search)
- [Polls](#polls)
- [Presence & Receipts](#presence--receipts)
- [Middleware](#middleware)
- [Plugins](#plugins)
- [Diagnostics](#diagnostics)
- [Stealth Guard](#stealth-guard)
- [E2EE](#e2ee)
- [Update checker](#update-checker)
- [Events](#events)

---

## Constructor

### `new MessengerClient(options?)`

Creates a new `MessengerClient` instance.

#### Options (`ClientOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `logLevel` | `string` | `"info"` | `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`, `"fatal"`, or `"silent"`. |
| `logFile` | `string \| null` | `null` | Path to append structured log output. |
| `prettyPrint` | `boolean` | `false` | Colorized local-development logs. Uses `pino-pretty` when installed, otherwise a built-in colorizer — no extra dependency needed. Never enable in production; keep redacted JSON there. |
| `useConsoleLogger` | `boolean` | `false` | Swap pino for the built-in colorized console logger. Console mode writes to stdout only and secret redaction does **not** apply there — for local runs only. |
| `logTransports` | `LogTransport[]` | `[]` | Additional log transports receiving every record. |
| `httpProxy` | `string \| null` | `null` | HTTP or SOCKS5 proxy URL. Tunnels both HTTP and MQTT sockets. |
| `httpTimeout` | `number` | `30000` | HTTP request timeout in milliseconds. |
| `httpRetries` | `number` | `3` | Automatic retries on network failures and 429/5xx responses. |
| `httpMaxRedirects` | `number` | `5` | Maximum redirects followed. |
| `userAgent` | `string` | Chrome 149 reduced UA | User-Agent sent with HTTP and WebSocket handshakes. |
| `heartbeatInterval` | `number` | `60` | MQTT ping interval in seconds. |
| `heartbeatTimeout` | `number` | `5` | Seconds to await `PINGRESP` before marking the connection dead. |
| `reconnectAttempts` | `number` | `Infinity` | Reconnect attempts before giving up. |
| `reconnectDelayMax` | `number` | `30000` | Backoff cap in milliseconds. |
| `mqttQueueMaxSize` | `number` | `500` | Outgoing MQTT messages buffered while disconnected. |
| `cacheMaxItems` | `number` | `5000` | LRU cache capacity. |
| `persistSession` | `boolean` | `true` | Persists session metadata, sequences, and refreshed cookies. |
| `storageAdapter` | `"memory" \| "file" \| StorageAdapter` | `"file"` | Session persistence backend. |
| `storageDirectory` | `string` | `"./panindigan-session"` | File storage path for the file adapter. |
| `validateOnLogin` | `boolean` | `true` | Validates the session with Facebook before resolving `login()`. |
| `plugins` | `PluginRegistration[]` | `[]` | Plugins registered at construction. |
| `stealth` | `Partial<StealthConfig>` | see below | Stealth Guard overrides. `{ enabled: false }` disables; `caps`, `limits`, `pacingEnabled`, `signalThreshold`, `signalWindow`, `cooldownMs`, `warmupDays`, `basePacingMs`, `jitterPercent`, `warmupEnabled`, `capWarningDelayMultiplier` are all adjustable. |
| `dryRun` | `boolean` | `false` | Every outbound operation logs its payload summary; nothing reaches the network. |
| `e2ee` | `"auto" \| "require" \| "off" \| { enabled?, require?, autoConnect?, selfListen?, deviceListCacheMs?, deviceStorePath? }` | `"off"` | E2EE for 1:1 threads (port of fbapi-unofficial, MIT). `"auto"` connects at login; `"require"` fails login without the encrypted channel; object form for fine-grained control. |
| `update` | `{ enabled?, checkIntervalMs? }` | `{ enabled: true }` | Update checker. On by default: checks on startup and every 24h, and installs automatically; set `autoInstall: false` to keep announce-only, `enabled: false` to disable entirely. |

Default stealth configuration:

```ts
{
  enabled: true,
  signalThreshold: 3,
  signalWindow: 600_000,      // 10 min
  cooldownMs: 86_400_000,     // 24 h
  warmupEnabled: true,
  warmupDays: 7,              // ramp 30% → 100%
  basePacingMs: 1200,
  jitterPercent: 0.5,
  pacingEnabled: true,
  capWarningDelayMultiplier: 2,
  caps: { perThreadPerHour: 30, globalPerHour: 100, globalPerDay: 200 },
  limits: {
    sendMessage: { burst: 10, sustained: 30, refillRate: 30 / 3600 },
    addReaction: { burst: 20, sustained: 100, refillRate: 100 / 3600 },
    createGroup: { burst: 2, sustained: 5, refillRate: 5 / 3600 },
    global: { burst: 50, sustained: 200, refillRate: 200 / 3600 },
  },
}
```

---

## Lifecycle & Session

### `login(credentials, options?, callback?)` — top-level function, main entry

```ts
import { login } from "panindigan-automate";

const client = await login("./appstate.json");
```

Authenticates exactly like `client.login(credentials)` but is exposed as a top-level call for the main documented entry.

- **Overloads**: `login(credentials): Promise<MessengerClient>` · `login(credentials, options): Promise<MessengerClient>` · `login(credentials, options, callback): void` where `callback = (error: Error | null, client?: MessengerClient) => void`.
- **`options`**: the same `ClientOptions` accepted by `new MessengerClient(options)`.
- **Returns**: the connected `MessengerClient` when the promise resolves.

```ts
const client = await login("./appstate.json", { e2ee: "auto" });
```

### `client.login(credentials)`

Authenticates with Facebook, builds the transports, and resolves once the realtime connection is up.

- **Parameters**:
  - `credentials`: `Credentials` — AppState array, AppState object, JSON file path, environment variable name, cookie array, or raw cookie header string.
- **Returns**: `Promise<LoginResult>` — `{ userId: string, restored: boolean }`.
- **Throws**: `CookieError` when `c_user`/`xs`/`datr` are missing or expired; `AuthenticationError` when Facebook rejects the session; `TimeoutError` when the realtime connection does not sync in time.

```ts
const { userId, restored } = await client.login("./appstate.json");
```

### `client.logout()`

Ends the session: closes the MQTT transport (publishing `/browser_close`), drains the HTTP pool, and clears persisted session state.

- **Returns**: `Promise<void>`.

### `client.getSession()`

Returns non-sensitive session metadata: `userId`, `state`, `connected`, `connectedSince`, `lastSeqId`, `syncToken`, `loginTime`, `reconnects`.

### `client.isConnected()`

Whether the realtime connection is currently established.

---

## Messaging

### `client.sendMessage(threadId, content)`

Sends text, a sticker, a GIF, or a previously uploaded attachment. Group threads are targeted with `thread_fbid`; direct threads use `specific_to_list`/`other_user_fbid`.

- **Parameters**:
  - `threadId`: `string`
  - `content`: `MessageContent` — `{ type: "text", body, mentions? }`, `{ type: "sticker", stickerId }`, `{ type: "gif", gifId }`, or `{ type: "attachment", attachmentId }`.
- **Returns**: `Promise<MessageSendResult>` — `{ messageId, threadId, offlineThreadingId }`.

```ts
await client.sendMessage("1000123456789", { type: "text", body: "Hello!" });

await client.sendMessage("2000987654321", {
  type: "text",
  body: "@Alex Welcome!",
  mentions: [{ id: "1000123456789", tag: "@Alex" }],
});
```

### `client.sendReply(threadId, messageId, content)`

Replies to a specific message.

- **Returns**: `Promise<MessageSendResult>`.

```ts
await client.sendReply(event.threadId, event.messageId, {
  type: "text",
  body: "This is a reply.",
});
```

### `client.sendAttachment(threadId, file)`

Uploads a file and sends it as an attachment.

- **Parameters**: `file`: `FileInput` — filesystem path (`string`), `Buffer`, or Node readable stream.
- **Returns**: `Promise<MessageSendResult>`.

### `client.sendSticker(threadId, stickerId)`

Sends a sticker by id.

- **Returns**: `Promise<MessageSendResult>`.

### `client.editMessage(messageId, newBody)`

Edits a message you sent through lightweight-service task `742`. Rejects with `APIError` when Facebook refuses the edit (too old, or not yours).

- **Returns**: `Promise<void>`.

### `client.unsendMessage(messageId)`

Unsends (deletes for everyone) a message.

- **Returns**: `Promise<void>`.

### `client.forwardMessage(messageId, targetThreadId)`

Forwards every attachment of a cached message to another thread. The message must be in the local cache (populated by `message` events and `getMessages`); otherwise a `ValidationError` is thrown.

- **Returns**: `Promise<void>`.

---

## Reactions

### `client.addReaction(messageId, reaction)`

Adds a reaction. `reaction` accepts a `REACTION_EMOJI` name (`"like"`, `"love"`, `"haha"`, `"wow"`, `"sad"`, `"angry"`) or any emoji character.

- **Returns**: `Promise<void>`.

### `client.removeReaction(messageId)`

Removes your reaction.

- **Returns**: `Promise<void>`.

---

## Media & Attachments

### `client.uploadMedia(file)`

Uploads a file to Facebook's CDN.

- **Parameters**: `file`: `FileInput`.
- **Returns**: `Promise<MediaInfo>` — `{ attachmentId, filename, mimeType, size, kind }`, where `kind` is `"image" | "gif" | "file" | "video" | "audio"`.

```ts
const media = await client.uploadMedia("./photo.jpg");
await client.sendMessage(threadId, { type: "attachment", attachmentId: media.attachmentId });
```

### `client.downloadAttachment(attachmentId)`

Downloads an attachment into memory as a `Buffer`.

### `client.streamAttachment(attachmentId)`

Streams an attachment without buffering it. Returns `Promise<DownloadResponse>` (`{ status, url, contentType, contentLength, stream }`).

### `client.getMediaInfo(mediaId)`

Returns metadata for media uploaded through this client instance (memory plus cache). Unknown ids throw `APIError` with code `MEDIA_NOT_FOUND`.

---

## Threads

### `client.getThread(threadId)`

Fetches thread metadata through GraphQL document `3449967031715030`.

- **Returns**: `Promise<ThreadInfo>`.

### `client.getThreadList(options?)`

Lists inbox threads with cursor pagination through GraphQL document `3336396659757871`.

- **Options**: `limit` (default `20`, max `100`), `cursor` (epoch-milliseconds string from a previous result), `tags` (default `["INBOX"]`).
- **Returns**: `Promise<ThreadListResult>` — `{ threads, cursor, hasMore }`.

```ts
const page = await client.getThreadList({ limit: 10 });
if (page.hasMore) await client.getThreadList({ cursor: page.cursor });
```

### `client.getMessages(threadId, options?)`

Fetches message history through GraphQL document `1498317363570230`, newest first.

- **Options**: `limit` (default `20`, max `100`), `before` (epoch milliseconds).
- **Returns**: `Promise<MessageListResult>` — `{ messages, hasMore }`.

### `client.muteThread(threadId, duration?)` / `client.unmuteThread(threadId)`

Mutes or unmutes notifications for a thread. `duration` is a whole number of minutes (1–525600) or `"always"` for the web client's indefinite mute (`mute_settings: "-1"`); default is `"always"`. Threads unmuted explicitly or automatically (leave the thread) return to `"0"`.

### `client.archiveThread(threadId)` / `client.unarchiveThread(threadId)`

Archives or unarchives a thread.

### `client.deleteThread(threadId)`

Deletes a thread from the inbox.

---

## Group Management

### `client.createGroup(userIds, name?)`

Creates a group thread through GraphQL document `577041672419534`.

- **Parameters**: `userIds`: at least two user ids; `name`: optional group title.
- **Returns**: `Promise<string>` — the new thread id.

### `client.addParticipant(threadId, userId)`

Adds a participant with a `log:subscribe` log message.

### `client.removeParticipant(threadId, userId)`

Removes a participant through `/chat/remove_participants`.

### `client.changeGroupName(threadId, name)`

Renames a group thread.

### `client.changeGroupPhoto(threadId, file)`

Uploads and sets the group photo. Alias: `client.changeGroupAvatar(threadId, file)` — same behavior.

### `client.changeGroupEmoji(threadId, emoji)`

Changes the group's default reaction emoji.

### `client.changeGroupTheme(threadId, color)`

Changes the group theme. `color` is a `getThreadColorList()` name (case-insensitive) or a raw numeric theme id — arbitrary hex is rejected by Facebook since ~2019. Returns the frozen registry from `client.getThreadColorList()` for reference.

### `client.createInviteLink(threadId)` / `client.joinGroupByLink(link)`

**`NotImplementedError`.** No publicly verifiable invite-link endpoint exists; no maintained client implements one either. Use the Facebook app for links.

### `client.changeAdminStatus(threadId, userId, isAdmin)`

Promotes or demotes a group admin.

### `client.changeNickname(threadId, userId, nickname)`

Sets or clears a participant's nickname (pass `""` to clear).

---

## Users & Search

### `client.getMe()`

Returns the authenticated account's profile.

### `client.getUser(userId)`

Fetches a user profile through `/chat/user_info/`.

### `client.searchUsers(query)`

Searches contacts through `/ajax/typeahead/search.php`.

- **Returns**: `Promise<readonly UserSearchResult[]>`.

### `client.getFriendList()`

Returns friends through `/chat/user_info_all`.

- **Returns**: `Promise<readonly UserInfo[]>`.

### `client.searchThreads(query)`

Searches threads by name through `/ajax/mercury/search_threads.php`.

- **Returns**: `Promise<readonly ThreadInfo[]>`.

### `client.searchMessages(query, options?)`

Searches message snippets globally, then per thread, through `/ajax/mercury/search_snippets.php?dpr=1`.

- **Options**: `limit` (default `20`, max `100`).
- **Returns**: `Promise<readonly MessageSearchResult[]>` — `{ messageId, threadId, senderId, body, timestamp }`.

---

## Polls

### `client.createPoll(threadId, question, options)`

Creates a poll with at least two options.

- **Returns**: `Promise<void>`.

### `client.votePoll(pollId, optionIds)`

Votes for one or more options.

- **Returns**: `Promise<void>`.

### `client.getPoll(pollId)`

Returns `{ id, question, options, optionCount }`. The options endpoint does not return the question, so the question comes from a cached poll event when available, otherwise `""`.

---

## Presence & Receipts

### `client.setTyping(threadId, isTyping)`

Publishes a typing indicator through the type-4 `/ls_req` envelope.

### `client.markAsRead(threadId)`

Marks a thread read through `/mark_thread`.

### `client.markAsDelivered(messageId)`

Sends a delivery receipt. The thread is read from the cached message→thread map, so call `getMessages` first if the message was not seen live.

### `client.getPresence(userId)`

Returns `{ userId, status, lastActive, updatedAt }`, where `status` is `"online" | "idle" | "offline" | "unknown"`. Presence is served from the `/orca_presence` cache; unseen users return `"unknown"`.

---

## Middleware

### `client.use(phase, hook, options?)`

Registers a middleware hook.

- **Parameters**:
  - `phase`: `"before" | "after" | "error"`
  - `hook`: `(context, next) => void | Promise<void>`
  - `options`: `{ operations?: string[], name?: string }`

```ts
client.use(
  "before",
  async (context, next) => {
    context.request.headers.set("X-Request-Source", "my-bot");
    await next();
  },
  { operations: ["sendMessage"] },
);
```

The context exposes `operation`, `request` (`url`, `method`, `headers`), `response`, `error`, and `metadata`.

---

## Plugins

Plugins are registered at construction and run in a sandboxed context (child logger, namespaced cache/storage, auto-removed listeners, scoped middleware).

```ts
const client = new MessengerClient({
  plugins: [{ plugin: myPlugin }],
});
```

The `Plugin` contract exposes `name`, `version`, and optional `onLoad`, `onEnable`, `onDisable`, `onReload`, `onDestroy`.

---

## Diagnostics

### `client.diagnostics.getSnapshot()` / `client.diagnostics.reset()`

Returns or zeroes the diagnostics snapshot: HTTP request counts/latency/retries, MQTT heartbeat/reconnect/queue counters, cache hit rate, per-event counts and throughput, and process memory — plus a `stealth` section (guard circuit state, caps, warmup, health score, thread heat, guard audit log) because the Stealth Guard wires itself into diagnostics.

```ts
const snapshot = client.diagnostics.getSnapshot();
console.log(snapshot.http.requests.total, snapshot.mqtt.heartbeat.avgMs, snapshot.cache.hitRate);
console.log(snapshot.stealth?.circuitState, snapshot.stealth?.healthScore, snapshot.stealth?.caps);
```

### `client.diagnostics.exportJSON()` / `client.diagnostics.exportHTML()`

Self-contained exports for attaching to incidents. The JSON export round-trips through `JSON.parse`; the HTML export is a single inline file with no external requests.

**Setting `PANINDIGAN_DEBUG=1`** writes `debug-report.json` (error + diagnostics) on an uncaught exception.

---

## Stealth Guard

### `client.stealth`

The Stealth Guard singleton: `client.stealth.getState()`, `client.stealth.reset()`, `client.stealth.getAudit()`, `client.stealth.capsSnapshot()`.

- **`getState()`** — `{ circuitState, haltedAt, signals[], warmupDay, hourWindow, dayWindow, sessionStartMs }`.
- **`reset()`** — manual reset; refuses until the cooldown expires. Returns `boolean`.
- **`getAudit()`** — ring buffer of the last 200 guard decisions (`allow`, `deny`, `halt`, `cap_warning`, `cap_reached`, `checkpoint`, `reset`) with reasons.
- **`capsSnapshot()`** — `{ hour: { count, limit, level }, day: { count, limit, level } }`, `level` is `"ok" | "warning" | "reached"`.

Events emitted by the guard: `suspension_warning` (a signal was observed), `suspension_halt` (circuit opened), `suspension_reset` (manual reset), `checkpoint` (identity verification demanded), `health_warning` / `health_critical` (health score crossed a threshold), `risk_rising` (send volume accelerating), `session_dead` (the session died and could not be re-validated). All rejections throw `AccountRestrictedError` with code `ACCOUNT_RESTRICTED`.

---

## E2EE

### `client.e2ee`

The 1:1 E2EE client — a faithful port of [bhhoang/fbapi-unofficial](https://github.com/bhhoang/fbapi-unofficial)'s `src/e2ee/` (MIT) into this package's source, with per-file attribution. `null` unless enabled via `e2ee` in the client options.

Config (string shorthand or object):

- `"off"` (default) — E2EE disabled
- `"auto"` — enabled; connects at login; failure downgrades to a `warning` event
- `"require"` — enabled; login fails if the encrypted channel cannot be established
- Object: `{ enabled?, require?, autoConnect?, selfListen?, deviceListCacheMs?, deviceStorePath? }`
  - `deviceStorePath` — defaults to `<storageDirectory>/e2ee_device.json`. **Keep the file** — deleting it re-registers a new device under your account.

Public surface:

- `connect(): Promise<void>` — opens the Noise XX encrypted channel and registers/loads the E2EE device
- `disconnect(): Promise<void>` — closes the channel and stops heartbeat/prekey sync
- `isConnected(): boolean`
- `deviceId: number | null`
- `store: DeviceStore | null` — the persisted identity (tests/diagnostics)
- `sendTextMessage(threadId, text): Promise<{ messageId, timestamp }>` — sealed send, 1:1 only

- `sendEncryptedMessage(threadId, text)` (on `MessengerClient`) — the same send through the guard, dry-run aware, with thread-kind validation. Group threads throw `NotImplementedError`.

Events: `e2ee_message` (incoming text), `e2ee_message_edit`, `e2ee_message_reaction`; unsends surface as `message_unsend`. Payload marker field `isE2EE: true`.

**Scope in this release:** 1:1 text only. Group chats (sender keys), E2EE attachments and encrypted backup restore are **not implemented**.

**Honest status:** the offline tests pass (WA/protobuf codec, RFC 5869 HKDF, XEdDSA sign/verify, full X3DH round trip between two device stores, Noise XX client handshake against an in-memory reference server). **Live behavior against real Facebook has not been verified by the authors.** Treat the feature as experimental; connecting registers an E2EE device on the account.

---

## Update checker

### `client.update`

**Automatic and on by default since 0.2.0.** A client constructed with no `update` options checks the npm registry on startup and every 24 hours, and installs a newer published version automatically. Back the package up first and roll back on failure.

```ts
// Default behavior (do nothing):
const client = new MessengerClient();   // checks on startup & every 24h; installs if newer exists
// Disable automatic updates entirely:
const client = new MessengerClient({ update: { enabled: false } });
// Keep the notices but never auto-install (announce-only):
const client = new MessengerClient({ update: { autoInstall: false } });
```

```ts
const info = await client.update.check();      // announce-only; null when disabled/too recent/up to date
if (info) console.log(`${info.current} → ${info.latest}`);
const result = await client.update.install();  // explicit: plan → backup → install → rollback on failure
```

Installation method options: `packageManager` (auto-detected from the lockfile when unset), `releaseChannel` (npm dist-tag, default `"latest"`), `timeout` (registry timeout ms, default 30s), `autoRestart` (default false — never restart for you), `allowPrerelease` (default false).

`client.update.install()` and the automatic path both: back up `node_modules/panindigan-automate`, install the new version, and roll the backup back on any failure. **A process restart is required afterwards in both cases — automatic updates do not restart the bot.** If you run a long-lived process, restart it yourself (e.g. under a process manager) to pick up a new version.

Status and history:

- `update.getStatus()` — installed/latest versions, availability, install status, history (last 10)
- `update.getHistory()` — the install history ring
- `update.getLatestVersion()` — the cached latest version, if known
- `update.stop()` — stops the periodic checker (the timer is unref'd; you only need this if you construct the checker yourself)
- Client-level helpers: `getUpdateStatus()`, `getUpdateHistory()`, `checkForUpdates()`, `installUpdate()` — thin delegates to the above, returning status objects directly.

`client.update.install()` requires a process restart; the caller decides when to restart.

---

## Events

```ts
const unsubscribe = client.on("message", (event) => { ... });
unsubscribe();
```

| Method | Description |
| :--- | :--- |
| `client.on(event, listener)` | Registers a typed listener; returns an unsubscribe function. |
| `client.once(event, listener)` | One-shot listener; returns an unsubscribe function. |
| `client.off(event, listener)` | Removes a listener. |
| `client.removeAll(event?)` | Removes all listeners for an event, or every listener. |
| `client.listenerCount(event)` | Number of registered listeners. |

| Event | Payload | Description |
| :--- | :--- | :--- |
| `ready` | `ReadyEvent` | Login finished and the realtime connection is up. |
| `login` | `LoginEvent` | Authentication completed. |
| `logout` | `LogoutEvent` | Session ended (voluntary, expired, or invalid). |
| `message` | `MessageEvent` | New message in a 1:1 or group thread. |
| `message_reply` | `MessageReplyEvent` | Message that quotes another message. |
| `message_unsend` | `MessageUnsendEvent` | A message was unsent. |
| `reaction` | `ReactionEvent` | A reaction was added or removed. |
| `typing` | `TypingEvent` | A participant started or stopped typing. |
| `presence` | `PresenceEvent` | Presence changed. |
| `read` | `ReadReceiptEvent` | A thread was marked read. |
| `delivered` | `DeliveredEvent` | A message reached a device. |
| `participant_join` | `ParticipantJoinEvent` | Members were added to a group. |
| `participant_leave` | `ParticipantLeaveEvent` | Members left or were removed. |
| `admin_change` | `AdminChangeEvent` | Group admin status changed. |
| `thread_update` | `ThreadUpdateEvent` | Thread name, photo, emoji, theme, or nickname changed. |
| `poll` | `PollEvent` | Poll created, voted on, or ended. |
| `call` | `CallEvent` | Call activity. |
| `reconnect` | `ReconnectEvent` | Realtime connection re-established after a drop. |
| `disconnect` | `DisconnectEvent` | Realtime connection lost and not recovered. |
| `error` | `ErrorEvent` | Internal, non-request error. |
| `warning` | `WarningEvent` | Non-fatal issue. |
| `debug` | `DebugEvent` | Internal debug output at `debug`/`trace` log levels. |
| `raw` | `RawDeltaEvent` | Every MQTT payload before parsing. |
| `suspension_warning` | `SuspensionWarningEvent` | A suspension signal was observed (or a cap crossed 80%). |
| `suspension_halt` | `SuspensionHaltEvent` | The guard froze outbound sends (circuit open / cap reached). |
| `suspension_reset` | `SuspensionResetEvent` | Manual guard reset succeeded after the cooldown. |
| `checkpoint` | `CheckpointEvent` | Facebook demanded an identity verification. |
| `health_warning` | `HealthWarningEvent` | Session health dropped below 50. |
| `health_critical` | `HealthCriticalEvent` | Session health dropped below 25. |
| `session_dead` | `SessionDeadEvent` | Session died mid-run and could not be re-validated. |
| `risk_rising` | `RiskRisingEvent` | Send volume is accelerating toward restriction risk. |
| `e2ee_message` | `E2eeMessageEvent` | Incoming 1:1 E2EE text (`isE2EE: true`). E2EE must be enabled; group threads are not supported. |
| `e2ee_message_edit` | `E2eeMessageEditEvent` | An encrypted message was edited (`isE2EE: true`). |
| `e2ee_message_reaction` | `E2eeMessageReactionEvent` | A reaction on an encrypted message (`isE2EE: true`). |
