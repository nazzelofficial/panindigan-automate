# API Reference

Complete reference for `MessengerClient`, the primary entry point for Panindigan Automate.

```ts
import { MessengerClient } from "panindigan-automate";
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
| `prettyPrint` | `boolean` | `false` | Pretty-prints console log records (requires `pino-pretty`). |
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

---

## Lifecycle & Session

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

### `client.muteThread(threadId)` / `client.unmuteThread(threadId)`

Mutes or unmutes notifications for a thread.

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

Uploads and sets the group photo.

### `client.changeGroupEmoji(threadId, emoji)`

Changes the group's default reaction emoji.

### `client.changeGroupTheme(threadId, color)`

Changes the group theme. `color` is a `THREAD_COLORS` name (`"MessengerBlue"`, `"NeonGreen"`, …) or a 6-digit hex value.

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

The context exposes `operation`, `request` (`url`, `method`, `headers`), `response`, `error`, and `metadata`. See [Middleware](middleware.md).

---

## Plugins

Plugins are registered at construction and run in a sandboxed context (child logger, namespaced cache/storage, auto-removed listeners, scoped middleware).

```ts
const client = new MessengerClient({
  plugins: [{ plugin: myPlugin }],
});
```

The `Plugin` contract exposes `name`, `version`, and optional `onLoad`, `onEnable`, `onDisable`, `onReload`, `onDestroy`. See [Plugins](plugins.md).

---

## Diagnostics

### `client.diagnostics.getSnapshot()` / `client.diagnostics.reset()`

Returns or zeroes the diagnostics snapshot: HTTP request counts/latency/retries, MQTT heartbeat/reconnect/queue counters, cache hit rate, per-event counts and throughput, and process memory.

```ts
const snapshot = client.diagnostics.getSnapshot();
console.log(snapshot.http.requests.total, snapshot.mqtt.heartbeat.avgMs, snapshot.cache.hitRate);
```

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
