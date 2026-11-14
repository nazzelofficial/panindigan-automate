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
| `logLevel` | `string` | `"info"` | Logging severity: `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`, `"fatal"`, or `"silent"`. |
| `logFile` | `string \| null` | `null` | Path to append structured log output. |
| `prettyPrint` | `boolean` | `false` | Pretty-prints console log records (requires `pino-pretty`). |
| `httpProxy` | `string \| null` | `null` | HTTP or SOCKS5 proxy URL (`http://...`, `https://...`, `socks5://...`). Tunnels both HTTP and MQTT sockets. |
| `httpTimeout` | `number` | `30000` | HTTP request timeout in milliseconds. |
| `httpRetries` | `number` | `3` | Maximum automatic retries on network failures and 429/5xx responses. |
| `userAgent` | `string` | *(Modern Chrome)* | User-Agent string sent with HTTP and WebSocket handshakes. |
| `heartbeatInterval` | `number` | `60` | MQTT ping interval in seconds. |
| `heartbeatTimeout` | `number` | `5` | Maximum seconds to await `PINGRESP` before marking connection dead. |
| `reconnectAttempts`| `number` | `Infinity` | Maximum reconnect attempts before giving up. |
| `reconnectDelayMax` | `number` | `30000` | Upper limit in ms for exponential backoff between reconnect sweeps. |
| `mqttQueueMaxSize` | `number` | `500` | Maximum outgoing MQTT messages buffered while disconnected. |
| `persistSession` | `boolean` | `true` | Persists session metadata, sequences, and refreshed cookies to storage. |
| `storageAdapter` | `"memory" \| "file" \| StorageAdapter` | `"file"` | Session persistence backend. |
| `storageDirectory` | `string` | `"./panindigan-session"` | File storage path when using file adapter. |
| `validateOnLogin` | `boolean` | `true` | Validates session with Facebook before resolving login. |

---

## Lifecycle & Session

### `client.login(credentials)`

Authenticates with Facebook using exported browser session cookies, validates credentials, establishes the realtime MQTT connection, and initializes the sync stream.

- **Parameters**:
  - `credentials`: `string | AppStateCookie[] | AppStateObject | CookieEntry[]` — AppState JSON file path, env var, array, or raw cookie header string.
- **Returns**: `Promise<LoginResult>` — `{ userId: string, restored: boolean }`.
- **Throws**: `CookieError` if required cookies (`c_user`, `xs`, `datr`) are missing or expired; `AuthenticationError` if Facebook rejects credentials.

```ts
const { userId, restored } = await client.login("./appstate.json");
console.log(`Logged in as ${userId} (restored: ${restored})`);
```

### `client.logout()`

Gracefully terminates the session: flushes outgoing queues, sends `/browser_close`, disconnects MQTT, tears down HTTP connection pools, and clears state.

- **Returns**: `Promise<void>`.

```ts
await client.logout();
```

### `client.getSession()`

Returns active, non-sensitive session diagnostics and status.

- **Returns**: `SessionInfo`
  - `userId`: `string`
  - `state`: `"UNINITIALIZED" | "AUTHENTICATING" | "ACTIVE" | "RECONNECTING" | "CLOSING" | "CLOSED"`
  - `connected`: `boolean`
  - `connectedSince`: `number | null`
  - `lastSeqId`: `number | null`
  - `syncToken`: `string | null`
  - `loginTime`: `number`
  - `reconnects`: `number`

### `client.isConnected()`

Checks whether the realtime MQTT transport is currently open.

- **Returns**: `boolean`.

---

## Messaging

### `client.sendMessage(threadId, content)`

Sends a message to a 1:1 direct chat or a group chat. Automatically adjusts targeting (`thread_fbid` vs `specific_to_list`).

- **Parameters**:
  - `threadId`: `string` — Recipient user ID or group thread ID.
  - `content`: `MessageContent` — Text, sticker, GIF, or uploaded attachment.
- **Returns**: `Promise<MessageSendResult>` — `{ messageId: string, timestamp: number }`.

```ts
// Plain text
await client.sendMessage("1000123456789", {
  type: "text",
  body: "Hello world!",
});

// Text with @mention
await client.sendMessage("2000987654321", {
  type: "text",
  body: "@Alex Welcome to the team!",
  mentions: [{ id: "1000123456789", tag: "@Alex" }],
});
```

### `client.sendReply(threadId, messageId, content)`

Sends a reply quoted directly against an existing message.

- **Parameters**:
  - `threadId`: `string`
  - `messageId`: `string`
  - `content`: `MessageContent`
- **Returns**: `Promise<MessageSendResult>`.

```ts
await client.sendReply(event.threadId, event.id, {
  type: "text",
  body: "This is a direct reply.",
});
```

### `client.sendAttachment(threadId, file)`

Uploads a local file or buffer and sends it as an attachment in one operation.

- **Parameters**:
  - `threadId`: `string`
  - `file`: `FileInput` — `{ path: string }`, `{ buffer: Buffer, filename: string, mimeType?: string }`, or `{ stream: Readable, filename: string }`.
- **Returns**: `Promise<MessageSendResult>`.

```ts
await client.sendAttachment(threadId, { path: "./report.pdf" });
```

### `client.sendSticker(threadId, stickerId)`

Sends a sticker by its Facebook sticker ID.

- **Parameters**:
  - `threadId`: `string`
  - `stickerId`: `string`
- **Returns**: `Promise<MessageSendResult>`.

### `client.editMessage(messageId, newBody)`

Edits an already-sent text message via the lightweight-service task queue (`/ls_req` Task 742).

- **Parameters**:
  - `messageId`: `string`
  - `newBody`: `string`
- **Returns**: `Promise<void>`.

```ts
await client.editMessage(sent.messageId, "Updated text content.");
```

### `client.unsendMessage(messageId)`

Unsends (deletes for everyone) a previously sent message.

- **Parameters**:
  - `messageId`: `string`
- **Returns**: `Promise<void>`.

### `client.forwardMessage(messageId, targetThreadId)`

Forwards the attachments of a cached message to another thread. (Requires the message to be in local cache, e.g. via `client.getMessages`).

- **Parameters**:
  - `messageId`: `string`
  - `targetThreadId`: `string`
- **Returns**: `Promise<void>`.

---

## Reactions

### `client.setMessageReaction(messageId, reaction)`

Adds or updates an emoji reaction on a message via GraphQL mutation `1491398900900362`.

- **Parameters**:
  - `messageId`: `string`
  - `reaction`: `ReactionInput` — Emoji (`"❤️"`, `"👍"`, `"😆"`, `"😮"`, `"😢"`, `"😠"`) or named reaction (`"heart"`, `"like"`, `"haha"`, `"wow"`, `"sad"`, `"angry"`).
- **Returns**: `Promise<void>`.

```ts
await client.setMessageReaction(event.id, "❤️");
```

### `client.removeMessageReaction(messageId)`

Removes an existing reaction from a message.

- **Parameters**:
  - `messageId`: `string`
- **Returns**: `Promise<void>`.

---

## Media & Attachments

### `client.uploadMedia(file)`

Uploads a file to Facebook's Mercury media endpoint without immediately sending it.

- **Parameters**:
  - `file`: `FileInput`
- **Returns**: `Promise<MediaInfo>` — `{ attachmentId: string, type: AttachmentType, filename: string, size: number, mimeType: string }`.

```ts
const media = await client.uploadMedia({ path: "./photo.jpg" });
await client.sendMessage(threadId, { type: "attachment", attachmentId: media.attachmentId });
```

### `client.downloadAttachment(attachmentId)`

Downloads an attachment by ID as an in-memory buffer.

- **Parameters**:
  - `attachmentId`: `string`
- **Returns**: `Promise<Buffer>`.

### `client.streamAttachment(attachmentId)`

Streams an attachment by ID as a Node.js `ReadableStream`.

- **Parameters**:
  - `attachmentId`: `string`
- **Returns**: `Promise<ReadableStream>`.

### `client.getMediaInfo(attachmentId)`

Retrieves metadata about an uploaded attachment from memory or cache.

- **Parameters**:
  - `attachmentId`: `string`
- **Returns**: `Promise<MediaInfo>`.

---

## Threads

### `client.getThread(threadId)`

Fetches detailed metadata, customization, and participant list for a thread via GraphQL doc `3449967031715030`.

- **Parameters**:
  - `threadId`: `string`
- **Returns**: `Promise<ThreadInfo>`.

### `client.getThreadList(options?)`

Fetches recent threads with cursor pagination using GraphQL doc `3336396659757871`.

- **Parameters**:
  - `options`: `ThreadListOptions`
    - `limit?: number` (default `20`, max `100`)
    - `cursor?: string`
    - `folder?: "inbox" | "archived" | "spam"`
- **Returns**: `Promise<ThreadListResult>` — `{ threads: ThreadInfo[], hasMore: boolean, cursor: string | null }`.

```ts
const { threads, hasMore, cursor } = await client.getThreadList({ limit: 10 });
```

### `client.getMessages(threadId, options?)`

Fetches historical messages in a thread using GraphQL doc `1498317363570230`.

- **Parameters**:
  - `threadId`: `string`
  - `options`: `MessageListOptions`
    - `limit?: number` (default `20`, max `100`)
    - `before?: string`
- **Returns**: `Promise<MessageListResult>` — `{ messages: Message[], hasMore: boolean, cursor: string | null }`.

### `client.muteThread(threadId, durationSeconds?)`

Mutes notifications for a thread (`-1` for indefinite, or seconds).

- **Parameters**:
  - `threadId`: `string`
  - `durationSeconds`: `number` (default `-1`)
- **Returns**: `Promise<void>`.

### `client.unmuteThread(threadId)`

Unmutes a previously muted thread.

### `client.archiveThread(threadId, archive?)`

Archives or unarchives a thread.

- **Parameters**:
  - `threadId`: `string`
  - `archive`: `boolean` (default `true`)
- **Returns**: `Promise<void>`.

### `client.deleteThread(threadId)`

Deletes a thread and its history permanently from your inbox.

- **Parameters**:
  - `threadId`: `string`
- **Returns**: `Promise<void>`.

---

## Group Management

### `client.createGroup(participantIds, name?)`

Creates a new group thread with initial participants using GraphQL doc `577041672419534`.

- **Parameters**:
  - `participantIds`: `string[]` — At least 2 user IDs.
  - `name`: `string | undefined`
- **Returns**: `Promise<{ threadId: string }>`.

### `client.addParticipant(threadId, userIds)`

Adds one or more users to an existing group thread.

- **Parameters**:
  - `threadId`: `string`
  - `userIds`: `string | string[]`
- **Returns**: `Promise<void>`.

### `client.removeParticipant(threadId, userId)`

Removes (kicks) a participant from a group thread.

- **Parameters**:
  - `threadId`: `string`
  - `userId`: `string`
- **Returns**: `Promise<void>`.

### `client.changeGroupName(threadId, name)`

Renames a group chat.

- **Parameters**:
  - `threadId`: `string`
  - `name`: `string`
- **Returns**: `Promise<void>`.

### `client.changeGroupPhoto(threadId, file)`

Uploads and sets a new group avatar photo.

- **Parameters**:
  - `threadId`: `string`
  - `file`: `FileInput`
- **Returns**: `Promise<void>`.

### `client.changeGroupEmoji(threadId, emoji)`

Changes the default reaction emoji of a group thread.

- **Parameters**:
  - `threadId`: `string`
  - `emoji`: `string`
- **Returns**: `Promise<void>`.

### `client.changeGroupTheme(threadId, color)`

Changes the chat bubble color and background theme using GraphQL mutation `1727493033983591`.

- **Parameters**:
  - `threadId`: `string`
  - `color`: `string` — A 6-character hex code (`"0084ff"`) or a `THREAD_COLORS` constant name (`"MessengerBlue"`, `"NeonGreen"`, etc.).
- **Returns**: `Promise<void>`.

### `client.changeAdminStatus(threadId, userId, isAdmin)`

Promotes or demotes an admin in a group thread.

- **Parameters**:
  - `threadId`: `string`
  - `userId`: `string`
  - `isAdmin`: `boolean`
- **Returns**: `Promise<void>`.

### `client.changeNickname(threadId, userId, nickname)`

Sets or clears a participant's nickname in a thread.

- **Parameters**:
  - `threadId`: `string`
  - `userId`: `string`
  - `nickname`: `string` (max 500 chars; pass `""` to reset)
- **Returns**: `Promise<void>`.

---

## Users & Search

### `client.getMe()`

Returns profile info of the authenticated account.

- **Returns**: `Promise<UserInfo>`.

### `client.getUser(userId)`

Fetches public profile info for a user.

- **Parameters**:
  - `userId`: `string`
- **Returns**: `Promise<UserInfo>`.

### `client.searchUsers(query)`

Searches contacts by name using Facebook's typeahead API.

- **Parameters**:
  - `query`: `string`
- **Returns**: `Promise<UserSearchResult[]>`.

### `client.getFriendList()`

Returns the list of friends for the logged-in user.

- **Returns**: `Promise<FriendInfo[]>`.

### `client.searchThreads(query)`

Searches thread names and group subjects.

- **Parameters**:
  - `query`: `string`
- **Returns**: `Promise<ThreadSearchResult[]>`.

### `client.searchMessages(query, options?)`

Searches message content globally or within a specific thread.

- **Parameters**:
  - `query`: `string`
  - `options`: `MessageSearchOptions` (`threadId?: string`, `limit?: number`)
- **Returns**: `Promise<MessageSearchResult[]>`.

---

## Polls

### `client.createPoll(threadId, question, options)`

Creates a poll in a group thread.

- **Parameters**:
  - `threadId`: `string`
  - `question`: `string`
  - `options`: `string[]` (at least 2 options)
- **Returns**: `Promise<{ pollId: string }>`.

### `client.votePoll(pollId, selectedOptions)`

Casts votes for options in an active poll.

- **Parameters**:
  - `pollId`: `string`
  - `selectedOptions`: `string[]`
- **Returns**: `Promise<void>`.

### `client.getPoll(pollId)`

Fetches current options, votes, and totals for a poll.

- **Parameters**:
  - `pollId`: `string`
- **Returns**: `Promise<PollInfo>`.

---

## Presence & Receipts

### `client.setTyping(threadId, typing)`

Publishes a typing indicator to a thread over MQTT via `/ls_req` Type-4 task envelope.

- **Parameters**:
  - `threadId`: `string`
  - `typing`: `boolean`
- **Returns**: `Promise<void>`.

### `client.markAsRead(threadId)`

Marks all messages in a thread as read over `/mark_thread`.

- **Parameters**:
  - `threadId`: `string`
- **Returns**: `Promise<void>`.

### `client.markAsDelivered(messageId)`

Sends a delivery receipt for a message.

- **Parameters**:
  - `messageId`: `string`
- **Returns**: `Promise<void>`.

### `client.getPresence(userId)`

Returns cached online presence for a user (populated by `/orca_presence`).

- **Parameters**:
  - `userId`: `string`
- **Returns**: `Promise<{ status: "active" | "idle" | "offline" | "unknown", lastActiveEpochMs: number | null }>`.

---

## Middleware

### `client.use(stage, handler, options?)`

Registers an interceptor into the execution pipeline.

- **Parameters**:
  - `stage`: `"before" | "after" | "error"`
  - `handler`: `MiddlewareHandler`
  - `options`: `{ operation?: string, priority?: number }`

See [Middleware Documentation](middleware.md) for complete details.

---

## Plugins

### `client.plugins.register(plugin)`

Loads and activates a sandboxed plugin.

- **Parameters**:
  - `plugin`: `Plugin` (`name`, `version`, `init`, `destroy`)

See [Plugins Documentation](plugins.md) for complete details.

---

## Diagnostics

### `client.diagnostics.getSnapshot()`

Returns a real-time snapshot of runtime metrics, connection health, request latency, and cache efficiency.

- **Returns**: `DiagnosticsSnapshot`
  - `http`: Connection pool stats, total requests, average latency, retry counts.
  - `mqtt`: Connection duration, ping latency (`avgMs`), packet drop count.
  - `cache`: Hit rates, item counts, invalidation totals.
  - `process`: Memory usage (RSS, heap), process uptime.

---

## Events

The client extends a strongly typed event emitter:

```ts
client.on("message", (event) => { ... });
client.on("reaction", (event) => { ... });
client.on("ready", (event) => { ... });
client.on("warning", (event) => { ... });
client.on("error", (event) => { ... });
```

| Event | Payload Type | Description |
| :--- | :--- | :--- |
| `ready` | `ReadyEvent` | Fired when login and MQTT sync stream are fully ready. |
| `message` | `MessageEvent` | Inbound message in 1:1 or group chat. |
| `message_reply` | `MessageReplyEvent` | Inbound message that quotes another message. |
| `message_unsend` | `MessageUnsendEvent` | A message was unsent / deleted. |
| `reaction` | `ReactionEvent` | A reaction was added or removed. |
| `typing` | `TypingEvent` | A user started or stopped typing. |
| `presence` | `PresenceEvent` | User online/idle state changed. |
| `participant_join` | `ParticipantJoinEvent` | New members added to a group. |
| `participant_leave`| `ParticipantLeaveEvent`| Members left or were kicked from a group. |
| `admin_change` | `AdminChangeEvent` | Group admin promoted or demoted. |
| `thread_update` | `ThreadUpdateEvent` | Group name, photo, emoji, or theme changed. |
| `poll` | `PollEvent` | Poll created or votes cast. |
| `warning` | `WarningEvent` | Non-fatal network glitch, retry, or parse anomaly. |
| `error` | `ErrorEvent` | Critical background failure. |
| `disconnect` | `DisconnectEvent` | MQTT disconnect after retries exhausted. |
| `raw` | `RawEvent` | Unhandled or unrecognized Facebook delta payload. |
