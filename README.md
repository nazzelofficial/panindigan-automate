# Panindigan Automate

[![Node.js](https://img.shields.io/badge/node.js-%3E%3D22%20(rec%20v26)-339933)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9%20(recommended)-orange)](https://pnpm.io)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.1-f472b6)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)](https://www.typescriptlang.org/)
[![CI](https://github.com/nazzelofficial/panindigan-automate/actions/workflows/ci.yml/badge.svg)](https://github.com/nazzelofficial/panindigan-automate/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/panindigan-automate.svg)](https://www.npmjs.com/package/panindigan-automate)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Facebook Messenger automation for Node.js and Bun, written from scratch in strict TypeScript. Built with care by [**Nazzel**](https://github.com/nazzelofficial) for bot developers.

Panindigan Automate drives a personal Messenger account the same way the web client does — over Facebook's HTTP endpoints and a persistent MQTT-over-WebSocket connection — and wraps it in a typed, promise-based API. You can send, edit, unsend, and forward messages; react; manage threads, groups, participants, and admins; upload and download attachments; create and vote in polls; track presence, typing, and read receipts; and listen to every realtime event as it happens.

It is not a fork, wrapper, or port of any existing Messenger library. It targets **Node.js 22 LTS and Node.js 26** (Node.js 26 recommended) as well as **Bun (>= 1.1)**, ships dual ESM/CJS builds with bundled type declarations, and treats strictness — compile-time and runtime — as a design constraint rather than a preference: no `any` in the source, no stubs, no unvalidated external input, and discriminated unions on every event payload.

> *Panindigan* is a Tagalog word meaning "to hold one's ground." The library is named for the part of bot development everyone else leaves to you: keeping a session alive. Panindigan reconnects after drops, refreshes cookies before they expire, queues outbound packets while offline, and persists session state across restarts.

**Status: pre-1.0.** The public API may still change in minor releases until 1.0 lands.

## Requirements

- **Node.js 22 LTS or newer** (Node.js 26 recommended) or **Bun >= 1.1**. Node.js 20 has reached End-of-Life and is no longer supported.
- Credentials from a logged-in Facebook session (see [Authentication](#authentication)). There is no email/password login, by design.

## Installation

```bash
# pnpm (Recommended)
pnpm add panindigan-automate

# Bun
bun add panindigan-automate

# npm
npm install panindigan-automate
```

Both module systems are supported:

```ts
// ESM
import { MessengerClient } from "panindigan-automate";

// CommonJS
const { MessengerClient } = require("panindigan-automate");
```

Type declarations and source maps are included; there is no `@types` package to install.

## Quick start

An echo bot — install to first reply in about 15 lines:

```ts
import { MessengerClient } from "panindigan-automate";

const client = new MessengerClient();

let me: string | undefined;

client.on("ready", (event) => {
  me = event.userId;
});

client.on("message", async (event) => {
  if (event.senderId === me || !event.body) return;

  await client.sendMessage(event.threadId, {
    type: "text",
    body: event.body,
  });
});

await client.login("./appstate.json");
```

Two things worth knowing early:

- `login()` resolves once the session is validated **and** the realtime connection is up. Until then, message events won't fire.
- Background failures (MQTT drops, session expiry, recovery giving up) surface on the `error` and `warning` events, not as rejected promises. In production, listen to both.

## Authentication

You authenticate with cookies exported from a browser session where you're already logged in. Six input formats are accepted and detected automatically — no wrappers, no type discriminator field required:

| Format | Input |
|--------|-------|
| AppState array | `[{ key: "c_user", value: "…", domain: ".facebook.com", path: "/", expires: "2027-03-01" }, …]` |
| AppState object | `{ c_user: { value: "…" }, xs: { value: "…" } }` |
| JSON file path | `"./appstate.json"` — file contents may be any other format |
| Environment variable name | `"FB_APPSTATE"` — variable contains JSON in any other format |
| Cookie array | `[{ name: "c_user", value: "…" }, …]` |
| Cookie header string | `"c_user=123; xs=…; datr=…"` |

Notes:

- Formats other than the raw cookie string preserve all cookie attributes (expiry, domain, path, `httpOnly`, `secure`, `sameSite`). A cookie header carries none, so cookies parsed from one are treated as session cookies.
- Three cookies must be present and unexpired or `login()` throws a `CookieError` before any network request is made: **`c_user`**, **`xs`**, and **`datr`**.
- When `xs` or `datr` approach expiry, the library refreshes them in the background and persists the updated jar. You don't need to re-export your browser session on every run.
- With `persistSession` (on by default), the cookie jar and session metadata are written to storage after login and kept current, so state survives process restarts.

## Events

Listeners are typed end to end: register `client.on("message", …)` and the parameter is a `MessageEvent` — fields autocompleted, misspelled event names rejected at compile time.

| Event | Fires when |
|-------|------------|
| `ready` | Login finished and the realtime connection is up |
| `login` | Authentication completed, with user metadata |
| `logout` | Session ended — voluntary, expired, or invalid |
| `message` | A new message in any thread you're part of |
| `message_reply` | A message that replies to another message |
| `message_unsend` | A participant unsent or deleted a message |
| `reaction` | A reaction was added or removed |
| `typing` | A participant started or stopped typing |
| `presence` | A contact's online status changed |
| `read` | A thread was marked read |
| `delivered` | A message reached a participant's device |
| `participant_join` | Someone was added to a group thread |
| `participant_leave` | Someone left or was removed from a group thread |
| `admin_change` | Admin status changed in a group thread |
| `thread_update` | Thread settings changed — name, photo, theme, emoji, nickname |
| `poll` | Poll created, voted on, or ended |
| `call` | Call initiated, joined, declined, missed, or ended |
| `reconnect` | Connection re-established after a drop |
| `disconnect` | Connection lost and not recovered |
| `error` | An internal, non-request error |
| `warning` | A non-fatal issue — dropped packet, full queue, retry |
| `debug` | Internal debug output (only when `logLevel` is `debug` or `trace`) |
| `raw` | Every MQTT delta before parsing — for debugging and forward compatibility |

Unknown delta types never throw. They're logged, and re-emitted as `raw`, so you can handle whatever Facebook ships next before a parser exists for it.

## API

Overview by area — full signatures, parameters, thrown errors, and examples are in the [API reference](docs/api-reference.md).

**Messaging**

| Method | Description |
|--------|-------------|
| `sendMessage(threadId, content)` | Send text, sticker, GIF, or an uploaded attachment |
| `sendReply(threadId, messageId, content)` | Reply to a specific message |
| `editMessage(messageId, newBody)` | Edit a message you sent |
| `unsendMessage(messageId)` | Unsend a message |
| `forwardMessage(messageId, targetThreadId)` | Forward a message to another thread |

`content` is a discriminated union — `{ type: "text", body }` (optionally with `mentions`), `{ type: "sticker", stickerId }`, `{ type: "gif", gifId }`, or `{ type: "attachment", attachmentId }` (from `uploadMedia`). Message bodies are capped at 20,000 characters, matching Facebook's limit.

**Reactions**

| Method | Description |
|--------|-------------|
| `addReaction(messageId, reaction)` | React with an emoji |
| `removeReaction(messageId)` | Remove your reaction |

**Attachments and media**

| Method | Description |
|--------|-------------|
| `sendAttachment(threadId, file)` | Send a file — buffer, stream, or path |
| `sendSticker(threadId, stickerId)` | Send a sticker |
| `downloadAttachment(attachmentId)` | Download an attachment into memory |
| `streamAttachment(attachmentId)` | Download as a stream (large files) |
| `uploadMedia(file)` | Upload to Facebook's CDN, returns an attachment ID |
| `getMediaInfo(mediaId)` | Metadata for uploaded media |

**Threads**

| Method | Description |
|--------|-------------|
| `getThread(threadId)` | Thread metadata |
| `getThreadList(options?)` | Paginated thread list |
| `getMessages(threadId, options?)` | Paginated message history |
| `muteThread` / `unmuteThread` | Notification mute |
| `archiveThread` / `unarchiveThread` | Archive |
| `deleteThread(threadId)` | Delete |

**Groups**

| Method | Description |
|--------|-------------|
| `createGroup(userIds, name?)` | Create a group thread |
| `addParticipant` / `removeParticipant` | Membership |
| `changeGroupName` / `changeGroupPhoto` | Identity |
| `changeGroupEmoji` / `changeGroupTheme` | Emoji and color theme |
| `changeAdminStatus(threadId, userId, isAdmin)` | Promote or demote an admin |
| `changeNickname(threadId, userId, nickname)` | Set or clear a nickname |

**Users**

| Method | Description |
|--------|-------------|
| `getMe()` | The authenticated user's profile |
| `getUser(userId)` | Profile for a user |
| `searchUsers(query)` | Search contacts |
| `getFriendList()` | Friends as `UserInfo[]` |

**Polls**

| Method | Description |
|--------|-------------|
| `createPoll(threadId, question, options)` | Create a poll |
| `votePoll(pollId, optionIds)` | Vote on one or more options |
| `getPoll(pollId)` | Current poll state |

**Presence and receipts**

| Method | Description |
|--------|-------------|
| `setTyping(threadId, isTyping)` | Show or hide the typing indicator |
| `markAsRead(threadId)` | Mark a thread read |
| `markAsDelivered(messageId)` | Mark a message delivered |
| `getPresence(userId)` | A user's presence status |

**Search**

| Method | Description |
|--------|-------------|
| `searchMessages(query, options?)` | Search message history |
| `searchThreads(query)` | Search threads by name |

**Session and diagnostics**

| Method | Description |
|--------|-------------|
| `login(credentials)` / `logout()` | Session lifecycle |
| `getSession()` / `isConnected()` | Session metadata, connection state |
| `diagnostics.getSnapshot()` | Full metrics snapshot |
| `diagnostics.reset()` | Zero all counters |

**Behavior notes**

- `forwardMessage` forwards the attachments of a message already in the local cache (populated by `message` events and `getMessages`); unknown ids throw `ValidationError`.
- `markAsDelivered` uses the cached message→thread map, so call `getMessages` first if the message was not seen live.
- `getMediaInfo` returns metadata for media uploaded through this client instance (memory plus cache); it cannot look up arbitrary Facebook attachment ids.
- `getPoll` reads options from Facebook, but that endpoint omits the question; the question comes from a cached poll event when available, otherwise `""`.
- `getPresence` is served from the `/orca_presence` cache and returns `unknown` until the user has been observed.

## Configuration

Every option has a default. Credentials are the only required input, and they go to `login()`, not the constructor:

```ts
const client = new MessengerClient({
  logLevel: "info",
  httpTimeout: 30_000,
  httpRetries: 3,
  heartbeatInterval: 60,
  reconnectAttempts: 10,
  storageAdapter: "file",
  storageDirectory: "./session",
});
```

Common options:

| Option | Default | Description |
|--------|---------|-------------|
| `logLevel` | `"info"` | `trace` through `fatal`, or `silent` |
| `prettyPrint` | `false` | Human-readable console output via pino-pretty (dev only) |
| `logFile` | — | Write logs to a file |
| `httpTimeout` | `30000` | Per-request timeout, in ms |
| `httpRetries` | `3` | Retries on network errors and 429/5xx |
| `httpMaxRedirects` | `5` | Redirect limit |
| `httpProxy` | — | HTTP or SOCKS5 proxy URL — applied to HTTP requests **and** the realtime WebSocket |
| `userAgent` | Chrome 149 reduced UA | Sent with every request |
| `heartbeatInterval` | `60` | MQTT keepalive, in seconds |
| `heartbeatTimeout` | `5` | Seconds to wait for a PINGRESP before calling the connection dead |
| `reconnectAttempts` | `Infinity` | Reconnection attempts before giving up |
| `reconnectDelayMax` | `30000` | Backoff cap, in ms |
| `mqttQueueMaxSize` | `500` | Outgoing packets queued while disconnected |
| `cacheMaxItems` | `5000` | LRU cache capacity |
| `persistSession` | `true` | Save the cookie jar and session metadata |
| `storageAdapter` | `"file"` | `"memory"`, `"file"`, or a custom `StorageAdapter` |
| `storageDirectory` | `"./panindigan-session"` | Where the file adapter writes |
| `validateOnLogin` | `true` | HTTP ping at login to confirm cookies are accepted |

Common options can also come from the environment — `PANINDIGAN_LOG_LEVEL`, `PANINDIGAN_HTTP_TIMEOUT`, `PANINDIGAN_HTTP_PROXY`, `PANINDIGAN_RECONNECT_ATTEMPTS`, and so on. Programmatic options always win.

## Error handling

Everything the library throws is a `LibraryError` subclass with a machine-readable `code`, a `retryable` flag, and a `context` object that never contains credentials:

```ts
import { APIError, TimeoutError } from "panindigan-automate";

try {
  await client.sendMessage(threadId, { type: "text", body: "hi" });
} catch (error) {
  if (error instanceof TimeoutError && error.retryable) {
    // worth trying again
  } else if (error instanceof APIError && error.code === "API_RATE_LIMIT") {
    // back off
  }
}
```

| Class | Thrown when |
|-------|-------------|
| `LibraryError` | Base class — `instanceof` matches all of the below |
| `AuthenticationError` | Login rejected, session expired |
| `CookieError` | Missing or expired required cookie, malformed input |
| `SessionError` | Session corrupt or unrecoverable |
| `TransportError` | HTTP transport failure (base of the next two) |
| `NetworkError` | DNS/TCP failure, connection refused |
| `TimeoutError` | Request exceeded `httpTimeout` |
| `ValidationError` | Invalid input to a public method |
| `PermissionError` | Not an admin, blocked, not a participant |
| `APIError` | Facebook returned a structured error |
| `MQTTError` | MQTT connection or protocol failure |
| `PluginError` | Plugin lifecycle failure |

Branch on `error.code`, not `error.message` — messages are for humans and can change between releases.

## Middleware

Middleware hooks into every operation — before the request is sent, after the response lands, or on failure. Register globally or scope to specific operations:

```ts
client.use(
  "before",
  async (context, next) => {
    context.headers.set("X-Request-Source", "my-bot");
    await next();
  },
  { operations: ["sendMessage"] },
);
```

Execution order is deterministic: global before → plugin before → user before → the operation → user after → plugin after → global after. Error middleware runs in reverse. Not calling `next()` short-circuits the chain. Context shapes and ordering rules are in the [middleware guide](docs/middleware.md).

## Plugins

```ts
import type { Plugin } from "panindigan-automate";

const messageCounter: Plugin = {
  name: "message-counter",
  version: "1.0.0",
  async onLoad(context) {
    context.on("message", (event) => {
      const count = Number(context.cache.get(`count:${event.threadId}`) ?? 0) + 1;
      context.cache.set(`count:${event.threadId}`, count, { tags: ["message-counter"] });
      context.logger.debug({ threadId: event.threadId, count }, "counted");
    });
  },
  async onEnable() {},
  async onDisable() {},
  async onReload() {},
  async onDestroy() {},
};

const client = new MessengerClient({
  plugins: [{ plugin: messageCounter }],
});
```

Plugins run in a sandboxed context: a child logger, namespaced cache and storage scopes, middleware registration, and event listeners that are removed automatically when the plugin is disabled. A plugin never sees the cookie jar, the transports, or another plugin's state. The lifecycle and full context API are in the [plugin guide](docs/plugins.md).

## Logging

Logging is structured JSON on stdout by default, one child logger per module. It's also safe by default: cookie values, tokens, and AppState are redacted at every level before anything is written — you can point production logs at an aggregator without scrubbing them first.

For local development:

```ts
new MessengerClient({ logLevel: "debug", prettyPrint: true });
```

`prettyPrint` loads pino-pretty dynamically and is ignored unless installed. Custom transports implement `LogTransport` and are passed via `logTransports`.

## Diagnostics

Long-running bots need observability. `client.diagnostics.getSnapshot()` returns a typed snapshot of everything the library measures:

```ts
const snapshot = client.diagnostics.getSnapshot();
console.log(snapshot.http.requests.total, snapshot.http.latency.p95);
console.log(snapshot.mqtt.heartbeat.avgMs, snapshot.mqtt.queue.depth);
console.log(snapshot.cache.hitRate, snapshot.events.throughput);
```

HTTP counts and latency percentiles, retries, MQTT heartbeat round-trip and reconnect count, queue depth, cache hit rate, per-event emission counts, and process memory — collected since startup or the last `diagnostics.reset()`.

## Protocol notes

Wire-level facts about how the library talks to Messenger, useful when debugging or writing a `raw`-event consumer. All values below were re-verified against live endpoints and actively maintained Messenger-automation implementations in November 2026.

- **Realtime transport.** MQTT 3.1 (`MQIsdp`, protocol level 3) over WebSocket at `wss://edge-chat.facebook.com/chat?region=<region>&sid=<session>&cid=<client>`, or the regionless `wss://edge-chat.facebook.com/chat?sid=<session>&cid=<client>` when no region is known. The CONNECT username is the JSON session blob Messenger's web client sends (`u`, `s`, `chat_on`, `fg`, `d`, `ct: "websocket"`, `aid: "219994525426954"`, `mqtt_sid`, `cp: 3`, `ecp: 10`, `st: []`, `pm: []`, `dc`, `no_auto_fg: true`, `gas: null`, `pack: []`); topics are subscribed individually after CONNACK rather than embedded in `st`. When the account's region is unknown, connection attempts rotate through the `prn`, `pnb`, `vll`, `hkg`, `sin`, `ftw`, and `ash` region variants before giving up on a host, and the first region that succeeds is remembered for later reconnects.
- **Sync stream.** After the connection is established, the client subscribes to 19 topics (including `/t_ms`, the delta stream, and the `/ls_req`/`/ls_resp` pair) and publishes a sync queue on `/messenger_sync_create_queue` — sync protocol version 11, `max_deltas_able_to_process` 100, `delta_batch_size` 500 — with `device_params: null` and, when a sequence id is already known, `initial_titan_sequence_id`. Reconnects that still hold a token use `/messenger_sync_get_diffs` instead. The first `/t_ms` reply carries `syncToken` and `firstDeltaSeqId`; later replies carry `lastIssuedSeqId`. A `/t_ms` whose `errorCode` is the string `ERROR_QUEUE_NOT_FOUND` or `ERROR_QUEUE_OVERFLOW` means the queue died: the cursor is cleared, a fresh sequence id is fetched, and a new queue is created on the same connection. A fresh connection that sees no `/t_ms` traffic within 5 seconds is treated as broken and cycled. `/foreground_state` and `/set_client_settings` are published after the queue is created; a graceful shutdown publishes `/browser_close` before the socket is closed.
- **Login tokens.** `login()` loads `/home.php` and scrapes `fb_dtsg` from `DTSGInitialData`, `lsd` from `["LSD",[],{"token":"…"}]`, `clientID`, the MQTT region from the `irisSeqID`/`MqttWebConfig` endpoint payloads, and `iris_seq_id`; `jazoest` is derived as `"2"` plus the sum of the `fb_dtsg` character codes. With `validateOnLogin` (the default), `/chat/user_info/` is then posted for the authenticated id to confirm Facebook accepts the session, and `/ajax/presence/reconnect.php?reason=6` re-establishes the web client's presence session before the realtime connection is awaited.
- **Lightweight service.** Message edits and typing indicators are task-style requests published to `/ls_req` (application id `2220391788200892`) and correlated by request id on `/ls_resp`, with a 10-second default timeout.
- **GraphQL.** Thread list, thread info, and message history go through `/api/graphql` with document id `3336396659757871` (batch `MessengerGraphQLThreadlistFetcher` — also the source of the sync sequence id), `3449967031715030` (batch `MessengerGraphQLThreadFetcher`), and `1498317363570230`. Reactions use document id `1491398900900362`; forced fetches of a single delta's full payload use `2848441488556444` with `thread_and_message_id`, the same document used for quoted-message lookups. Group creation uses `577041672419534` at `/api/graphql/`; thread themes use `1727493033983591` at `/api/graphqlbatch/`. `/api/graphqlbatch/` replies are a sequence of concatenated JSON objects plus a summary object, not a JSON array.
- **Mercury.** Sends and thread mutations use the classic form-encoded `/messaging/send/`-family endpoints with a rotating `fb_dtsg` token; attachments upload to Facebook's upload host first. Group sends set `thread_fbid`; 1:1 sends set `specific_to_list[0]`/`specific_to_list[1]` and `other_user_fbid`. Group membership is a `log:subscribe` log message; removals go to `/chat/remove_participants`. Group photo changes upload first, then post `thread_image_id` to `/messaging/set_thread_image/`.
- **Lightweight service tasks.** Message edits use task label `742` (version `6903494529735864`, queue `edit_message`); typing indicators use the type-4 `/ls_req` envelope with version `5849951561777440` and `is_group_thread`/`is_typing` flags. Both are published to `/ls_req` and correlated on `/ls_resp`.
- **Search.** Users go through `/ajax/typeahead/search.php`; threads through `/ajax/mercury/search_threads.php`; messages through `/ajax/mercury/search_snippets.php?dpr=1` — a global query returns matching threads plus per-thread totals, then a per-thread query returns the snippets (`message_id`, `author`, `timestamp`, `body`, `matched_keywords`).
- **Polls.** Creation posts ordered `option_text_array[i]`/`option_is_selected_array[i]` fields to `/messaging/group_polling/create_poll/?dpr=1`; votes post `selected_options[i]` to `/messaging/group_polling/update_vote/?dpr=1`; options come from `/ajax/mercury/get_poll_options`. The options endpoint does not return the question, so `getPoll` uses the question cached from poll events when available and otherwise reports `""`.
- **Attachments.** Uploads post multipart `farr` (with `voice_clip=true`) to `https://www.facebook.com/ajax/mercury/upload.php`, falling back to `upload_1024` on `https://upload.facebook.com/ajax/mercury/upload.php`; the id is read from `payload.metadata[0]` (`image_id`, `gif_id`, `file_id`, `video_id`, or `audio_id`). Downloads resolve a URL from the attachment cache or `/mercury/attachments/photo` and then stream it.
- **Presence.** `getPresence` reads the in-memory presence cache fed by `/orca_presence`; it returns `unknown` for users never observed. There is no verified HTTP endpoint that queries presence on demand.
- **Proxy coverage.** `httpProxy` tunnels both HTTP requests and the MQTT WebSocket, so with a proxy configured the realtime socket never dials Facebook directly.

## Risks, limitations, versioning

Read this section before putting a bot in production.

- **This is an unofficial library.** Panindigan Automate talks to private, undocumented endpoints. Automating a personal account violates Facebook's terms of service, and accounts that do it can be restricted or disabled. Use an account you can afford to lose.
- **The wire format changes without notice.** When Facebook breaks a parser, fixes ship as patch releases. Anything that changes this library's public API ships as a minor release until 1.0, a major release after.
- **Pre-1.0.** This is a pre-1.0 release. Pin your version; expect the API to tighten before it freezes.
- **Runtimes.** Node.js 22, Node.js 26 (recommended), and Bun (>= 1.1) are fully supported. Browser and Deno environments are not supported.
- **No email/password login.** By design — password login trips Facebook's automation detection far faster than cookie-based sessions do.

## Documentation

| Guide | Description |
| :--- | :--- |
| [Quick Start](docs/quick-start.md) | Install to a running echo bot in under 5 minutes |
| [Authentication](docs/authentication.md) | The 6 credential formats, cookie refresh, and 2FA |
| [API Reference](docs/api-reference.md) | Complete signatures, parameter tables, and examples |
| [Middleware](docs/middleware.md) | Intercepting, modifying, and logging operations |
| [Plugins](docs/plugins.md) | Building and packaging modular extensions |
| [Migration](docs/migration.md) | Transitioning from legacy/unmaintained FCA libraries |
| [Troubleshooting](docs/troubleshooting.md) | Error codes, diagnostics, and debugging |
| [FAQ](docs/faq.md) | Common questions, ban prevention, and deployment |
| [Examples](examples/) | Ready-to-run bot scripts (echo bot, group manager) |

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Every change needs tests; every public API change needs docs; every bug fix gets a regression test that stays in the suite. Bug reports and feature requests can use the GitHub issue templates.

## Author

Created and maintained by [**Nazzel** (@nazzelofficial)](https://github.com/nazzelofficial) for bot developers everywhere.

## License

[MIT](LICENSE)
