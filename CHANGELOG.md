# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- Optional Redis (`ioredis`) and SQLite (`better-sqlite3`) adapters for cache and storage
- Sentry (`@sentry/node`) log transport
- OpenTelemetry tracing hooks for the diagnostics module

## [0.1.3] - 2026-11-15

### Added

- `tests/scrape-tokens.test.ts` — regression tests with hand-crafted, sanitized fixtures (no real Facebook HTML or credentials): modern requireLazy SPA boot payloads, older `DTSGInitData` variants, relaxed scans, server-rendered hidden inputs, the `async_get_token` variant, special characters in token values, and failure pages (login page, checkpoint, empty/unknown). The suite covers both the `fb_dtsg` and `lsd` extractors and the login page detection.
- `tests/cookie-store.test.ts` — regression tests for the AppState → HTTP jar pipeline: `CookieStore.fromCookies` accepts browser-exported AppState cookies, `requireAuthenticated()` passes, and the jar emits a `Cookie` header for `www.facebook.com` for `c_user`/`xs`/`datr`/`presence`.
- `scripts/` patch helpers are now ESM (`.mjs`) instead of CommonJS.

### Fixed

- **Facebook authentication failure** — `AuthenticationError: Could not read Facebook's session tokens from the home page`:
  - `scrapeTokens` extracts `fb_dtsg` with multiple patterns instead of one pair of legacy regexes: modern requireLazy `DTSGInitialData`, older `DTSGInitData`, a relaxed scan within 160 characters, server-rendered hidden inputs, and `async_get_token`.
  - `lsd` is extracted the same multi-pattern way: requireLazy `["LSD",[],{"token":"…"}]`, a relaxed scan, and server-rendered hidden inputs.
  - `#scrapeTokens` and `#refreshCookies` now classify the response: login redirects (`/login`, `id="loginform"`) raise `AUTH_SESSION_EXPIRED`; checkpoint pages (`/checkpoint`, `two_step_verification`) are detected by URL and body markers and route through the same expiry teardown — checkpoints are never bypassed.
  - Token-scrape failures log and throw with non-sensitive diagnostics only (`fbDtsgFound`, `lsdFound`, `hasLoginForm`, `hasCheckpoint`, `bodyLength`) — never cookie values, token values, or raw HTML.
  - Successful token scraping now logs a debug line with the detected region/sequence-id presence.
- **AppState cookies were silently dropped by tough-cookie 6**: browser AppState exports carry `domain: ".facebook.com"` (with a leading dot), which tough-cookie 6 rejects without an error. `FB_COOKIE_DOMAIN` is now the canonical `facebook.com`, and `toToughCookie()` strips leading dots before constructing the `Cookie`. Freshly exported AppState is now actually applied to requests instead of failing at the required-cookie check or silently missing from the `Cookie` header.
- The previous behavior could present itself as a Facebook login redirect with an "Invalid session token" or a "Could not read session tokens" failure; with the extraction and cookie-jar fixes, a healthy exported session is applied end to end.

## [0.1.2] - 2026-11-14

### Added

- The full `MessengerClient` API (`src/client`) is implemented end to end — no stubs:
  - **Login/session:** token scraping from `/home.php` (`fb_dtsg` from `DTSGInitialData`, `lsd`, `clientID`, MQTT region from `irisSeqID`/`MqttWebConfig` boot payloads, `iris_seq_id`), optional profile validation, the web client's `/ajax/presence/reconnect.php?reason=6` presence reconnect, MQTT connect with sync-ready gating, background cookie refresh, and logout teardown that closes both transports and clears persisted state.
  - **Messaging:** `sendMessage`, `sendReply`, `editMessage` (lightweight-service task `742`, version `6903494529735864`), `unsendMessage`, `forwardMessage`, and reactions through `/webgraphql/mutation/` (document `1491398900900362`).
  - **Media:** `uploadMedia` (primary `ajax/mercury/upload.php` field `farr`, fallback upload host field `upload_1024`), `downloadAttachment`, `streamAttachment`, `getMediaInfo`, and photo URL resolution through `mercury/attachments/photo` (`ServerRedirect.redirectPageTo`).
  - **Threads:** `getThread`, `getThreadList` (cursor pagination over batch document `3336396659757871`), `getMessages` (batch document `1498317363570230`), mute/unmute, archive/unarchive, delete.
  - **Groups:** `createGroup` (GraphQL document `577041672419534`), `addParticipant`/`removeParticipant`, `changeGroupName`, `changeGroupPhoto`, `changeGroupEmoji`, `changeGroupTheme` (document `1727493033983591`), `changeAdminStatus`, `changeNickname`.
  - **Users/search:** `getMe`, `getUser`, `searchUsers` (typeahead), `getFriendList`, `searchThreads`, `searchMessages` (global thread discovery plus per-thread snippet pages).
  - **Polls:** `createPoll`, `votePoll`, `getPoll`.
  - **Presence/receipts:** `setTyping` (type-4 `/ls_req` envelope, version `5849951561777440`), `markAsRead` (`/mark_thread`), `markAsDelivered` (`delivery_receipts.php`), `getPresence`.
  - `client.use(...)` middleware registration, plugin lifecycle wiring, diagnostics wiring, and `debug` events at `debug`/`trace` log levels.
  - Group-thread kind resolution: the thread-kind cache is consulted first, ambiguous 15-character ids are resolved with a `MessengerGraphQLThreadFetcher` lookup, and only then does the web client's length heuristic apply. Group sends therefore target `thread_fbid` correctly even for 15-digit group ids.
  - Edit verification: the `/ls_resp` task payload is checked for the echoed text, so an edit Facebook rejects (too old, or not yours) rejects with `APIError` instead of silently resolving.
  - Forward verification: `/mercury/attachments/forward/` responses carrying `success: false` reject with `APIError`.
- Group-chat coverage: group versus 1:1 send targeting (thread-kind cache first, length heuristic as fallback), group thread normalization, mentions, group polls, admin/nickname/emoji/theme/photo mutations, group history, and group search.
- `tests/client.test.ts` — 30 tests covering client construction, session state, middleware, event listener registration, credential validation, thread/message/poll/search normalization, GraphQL batch extraction, media metadata, input validation, and the group-versus-1:1 message/log form builders.
- The root client exposes the typed event API directly: `client.on`, `client.once`, `client.off`, `client.removeAll`, and `client.listenerCount`. `on`/`once` return an unsubscribe function.

### Changed

- `getThreadList` paginates with the `before` timestamp cursor, drops the boundary duplicate, and derives `hasMore`/`cursor` from `page_info` or the last node's `updated_time_precise`.
- Attachment normalization accepts a top-level GraphQL `__typename` (`MessageImage`, `MessageVideo`, …) in addition to `blob_attachment` wrappers, so history and forced-fetch nodes normalize correctly.
- `getPresence` serves the in-memory presence cache populated by `/orca_presence` and returns `unknown` when the user has never been observed; there is no verified HTTP presence endpoint.
- `getMediaInfo` reads the client's uploaded-media registry (memory plus cache); unknown ids throw `APIError` with code `MEDIA_NOT_FOUND`.
- `markAsDelivered` reads the cached message→thread map (populated by `message`/`delivered` events and `getMessages`).
- Configuration defaults `logFile` and `httpProxy` now accept `null` (the built-in defaults), fixing client construction.
- The build orchestrator is plain JavaScript, the CommonJS build disables `verbatimModuleSyntax`, and `dist/cjs/package.json` marks the CommonJS output so the dual package loads under both `import` and `require`.
- `THREAD_COLORS` key ` MessengerBlue` corrected to `MessengerBlue`.

### Fixed

- Constructing `MessengerClient` with defaults no longer throws `ValidationError: Invalid option "logFile": Expected string, received null`.
- `npm run build` no longer crashes with `SyntaxError: Unexpected token ':'` from TypeScript annotations in `build.mjs`.
- The dual ESM/CJS build now loads correctly in both module systems (verified with `import()` and `require()`).
- Image attachments in history and forced-fetch payloads no longer normalize to `type: "unknown"`.
- Source builds against the upgraded dependency majors:
  - `tough-cookie` 6: `SerializedCookieJar` is now imported from the package root (the `dist/cookie/constants.js` path no longer exists).
  - `undici` 8 / `@types/node` 26: multipart `Blob`s are built from a copied `Uint8Array` (`Buffer` is no longer assignable to the DOM `BlobPart` shape).
  - TypeScript 7: `moduleResolution: "node10"` was removed; the CommonJS build uses `"bundler"`.
  - `zod` 4, `pino` 10, `vitest` 5, `@types/node` 26, `undici` 8, `tough-cookie` 6 — all tests pass and both module systems load and run.

## [0.1.1] - 2026-11-12

### Added

- The MQTT-over-WebSocket transport (`src/transport/mqtt`) is now implemented in full, matching the wire behavior of actively maintained Messenger clients:
  - One dial = one region sweep. The preferred region is tried first (seeded from configuration and made sticky after a success), then the fallback regions; a regionless candidate leads when no region is known, and a custom `mqttEndpoint` collapses the sweep to that single host.
  - Jittered exponential backoff between sweeps — `min(reconnectDelayMax, 1000 · 2^(n-1)) · (0.5 + random)` — with `reconnectAttempts` bounding the total, and a dedicated rejection plus `onReconnectExhausted` when the budget runs out.
  - 19 individual topic subscriptions after CONNACK; sync queue bootstrap via `/messenger_sync_create_queue` or `/messenger_sync_get_diffs`; `/foreground_state` and `/set_client_settings` published afterwards; `/browser_close` on graceful shutdown.
  - `/t_ms` bookkeeping for both the `syncToken`/`firstDeltaSeqId` reply and the `lastIssuedSeqId` high-water mark, with per-connection first-message notification.
  - A FIFO offline queue (bounded by `mqttQueueMaxSize`) that holds publishes while disconnected, raises `MQTT_QUEUE_OVERFLOW` and records a drop when full, and drains in order after CONNACK with per-packet deadlines.
  - A keepalive heartbeat that measures round-trip time from `pingreq`/`pingresp` and a watchdog that forces a reconnect when a ping goes unanswered past `heartbeatTimeout`; a 5-second `/t_ms` watchdog cycles connections that establish but never sync.
  - `/ls_req` task requests with per-request ids, correlated to `/ls_resp` envelopes, a configurable timeout that rejects with `TimeoutError`, and immediate rejection with `MQTT_NOT_CONNECTED` when the connection drops.
- Offline-threading-id and threading-id generators in `src/utils`, built on `BigInt` so ids stay exact past 2^53.
- `initialCursor` on the transport dependencies, so a restored session can seed `lastSeqId` and `syncToken` before the first dial instead of re-fetching them.
- MQTT WebSocket proxy tunneling. `httpProxy` previously covered only HTTP requests; it now also covers the realtime socket. A custom `http.Agent` implementation tunnels the `wss://` connection through HTTP CONNECT or SOCKS5 (using the `socks` package, added as a direct dependency), upgrades the tunnel to TLS itself, and hands surplus handshake bytes back to the TLS layer exactly as the `socks` client does. Integration tests exercise tunneling, surplus-byte delivery, CONNECT rejection, and timeouts against a local fake proxy and TLS endpoint.

### Changed

- Protocol constants re-verified (November 2026) against live endpoints and actively maintained Messenger-automation implementations, replacing values carried over from archived references:
  - Thread list and sync-sequence queries now use GraphQL document id `3336396659757871` with batch name `MessengerGraphQLThreadlistFetcher` (previously the archived `1349387578499440`).
  - Thread info now uses document id `3449967031715030` with batch name `MessengerGraphQLThreadFetcher`; message history keeps document id `1498317363570230`.
  - The MQTT sync queue is created with sync protocol version 11, `max_deltas_able_to_process` 100, and `delta_batch_size` 500, and the subscribed topic set counts 19 topics including `/ls_req`, `/ls_resp`, and `/rtc_multi`.
  - The MQTT CONNECT username uses the classic session payload shape (`u`, `s`, `chat_on`, `fg`, `d`, `ct: "websocket"`, `aid: "219994525426954"`, `mqtt_sid`, `cp: 3`, `ecp: 10`, `st: []`, `pm: []`, `dc`, `no_auto_fg: true`, `gas: null`, `pack: []`), with topics subscribed individually after CONNACK. The socket URL is `wss://edge-chat.facebook.com/chat?region=<region>&sid=<session>&cid=<client>` with region fallback, and `/foreground_state` plus `/set_client_settings` are published after the sync queue is created.
  - `/t_ms` queue-loss error codes are strings (`ERROR_QUEUE_NOT_FOUND`, `ERROR_QUEUE_OVERFLOW`), not numbers; the cursor is cleared, the sequence id refetched, and the queue recreated on the live connection.
  - A 5-second `/t_ms` watchdog cycles freshly connected sockets that receive no sync traffic, and graceful shutdown publishes `/browser_close` before ending the socket.
- The README diagnostics example now uses the implemented snapshot path (`snapshot.mqtt.heartbeat.avgMs`) and the Protocol notes describe the verified CONNECT payload and sync-queue fields instead of summaries.

### Fixed

- `/t_ms` branch ordering now matches the reference clients: a reply carrying `syncToken` and `firstDeltaSeqId` no longer also applies `lastIssuedSeqId` over it, so the cursor starts at the first delta rather than the high-water mark.
- A queue-lost `/t_ms` always clears the stored cursor, even if the connection vanished before the queue could be recreated; the republish is the only step that needs a live socket.
- `onSyncEstablished` now fires exactly once per connection. `reconnect` is derived from whether a previous connection had already synced, so the first connection never reports itself as a reconnect.
- A timed-out `/ls_req` now rejects its caller with `TimeoutError`, and a connection loss rejects it with `MQTT_NOT_CONNECTED`; previously the pending request resolved as `null`.
- The WebSocket proxy agent now declares `protocol: "https:"` on the underlying Node agent. Both `https.request` and `ws` reject custom agents whose protocol does not match the request protocol (`ERR_INVALID_PROTOCOL`); the base `http.Agent` hardcodes `http:`.
- Surplus bytes that a proxy appends after the CONNECT response head are now handed to the TLS layer synchronously via `socket.unshift()` immediately after `tls.connect()`. Node's TLSSocket constructor runs `initRead` on `process.nextTick` and drains the wrapped socket's readable buffer into the TLS parser; re-emitting the bytes later on `setImmediate` (the `socks` client's approach) is too late on modern Node — the wrap bypasses the raw stream's data events and the bytes are silently dropped. Bytes glued to the CONNECT head now fail the handshake fast instead of being discarded.
- Integration-test infrastructure: the in-process self-signed certificate generator now embeds Node's DER ECDSA signature with the required zero unused-bits prefix (Node's `sign()` already returns DER for EC keys), the fake CONNECT proxy relays raw TCP like a real proxy instead of double-encrypting, and socket cleanup tracks connections manually because Node 26 removed `server.closeAllConnections()`.

## [0.1.0] - 2026-11-10

First public release.

### Added

- `MessengerClient` — the public entry point, covering messaging (send, reply, edit, unsend, forward), reactions, attachments, threads, groups, users, polls, presence, search, and media operations. No stubs; every method is implemented.
- Authentication from six credential input formats — AppState array, AppState object, JSON file path, environment variable name, cookie array, and raw cookie header string — with automatic detection, normalization into an RFC 6265-compliant jar, and round-trip serialization for all six.
- Login-time cookie validation: `c_user`, `xs`, and `datr` must be present and unexpired, otherwise a `CookieError` is thrown before any network request is made.
- Session management as an explicit state machine (`UNINITIALIZED` → `AUTHENTICATING` → `ACTIVE` → `RECONNECTING` → `CLOSING` → `CLOSED`), with jittered exponential-backoff reconnection, automatic cookie refresh as `xs`/`datr` approach expiry, and graceful shutdown that drains in-flight requests before disconnecting.
- MQTT-over-WebSocket transport: keepalive heartbeats with round-trip measurement, dead-connection detection after three missed PINGRESPs, automatic topic re-subscription, and a FIFO outgoing packet queue (500 packets by default) that drains in order on reconnect.
- HTTP transport on undici with connection pooling, per-request timeouts, redirect limits, gzip/brotli decompression, streaming downloads, multipart uploads, retries with jittered backoff on network errors and 429/5xx responses, and HTTP/SOCKS5 proxy support.
- Delta processing into typed events for messages, replies, reactions, unsend, read and delivery receipts, presence, typing, participant join/leave, admin changes, thread updates, polls, calls, and attachments. Every payload is validated before dispatch; unknown delta types are logged and re-emitted as `raw` events rather than thrown.
- Typed event emitter with a full registry — `message`, `message_reply`, `message_unsend`, `reaction`, `typing`, `presence`, `read`, `delivered`, `participant_join`, `participant_leave`, `admin_change`, `thread_update`, `poll`, `call`, `ready`, `login`, `logout`, `reconnect`, `disconnect`, `error`, `warning`, `debug`, and `raw`. Payloads are discriminated unions.
- Middleware pipeline: `before`, `after`, and `error` hooks, global or scoped to named operations, executed in a deterministic order with short-circuit support.
- Plugin system with a sandboxed context (child logger, namespaced cache and storage, auto-removed event listeners) and a complete lifecycle — load, enable, disable, reload, destroy.
- LRU cache with per-entity TTLs (threads, users, messages, attachment URLs) behind the `CacheAdapter` interface, including tag-based invalidation and a `fetch` cache-aside helper.
- Storage subsystem with in-memory and file adapters; file writes are atomic (temp file, then rename).
- Structured logging through pino — JSON to stdout by default, child loggers per module, optional pretty printing in development, and pluggable transports.
- Diagnostics: HTTP request counts, latency percentiles, and retry counts; MQTT heartbeat round-trip, reconnect count, and queue depth; cache hits, misses, and hit rate; per-event emission counts and throughput; process memory and uptime. Exposed through `client.diagnostics.getSnapshot()`.
- A typed error hierarchy rooted at `LibraryError` — `AuthenticationError`, `SessionError`, `CookieError`, `TransportError`, `NetworkError`, `TimeoutError`, `ValidationError`, `PermissionError`, `APIError`, `MQTTError`, and `PluginError` — each with a machine-readable `code`, a `retryable` flag, and secret-free `context`.
- Dual ESM/CommonJS builds with bundled type declarations and source maps; `sideEffects: false` for tree-shaking.
- Configuration validated with Zod, defaults for everything except credentials, plus `PANINDIGAN_`-prefixed environment variable overrides (programmatic options take precedence).
- Test suite across unit, integration, regression, parser, and benchmark categories, with a local MQTT broker harness and nock-based HTTP interception; 100% line coverage on public API methods and 100% branch coverage in the delta processor.
- Documentation set: API reference, quick start, authentication, middleware, plugin, migration, troubleshooting, and FAQ guides, plus worked examples (echo bot, group manager, file sender, poll creator).

### Security

- Secrets never reach log output: redaction paths for cookies, tokens, and credentials are enabled by default at every log level, in every module.
- `getSession()` returns non-sensitive metadata only; no public method returns raw cookies or AppState.
- All public API inputs and all external responses (HTTP and MQTT) are validated before use.

### Known limitations

- Node.js only. No browser, Deno, or Bun support.
- No email/password login — cookie-based authentication only.
- No wildcard event listeners; listeners must name an exact event.
- Facebook's private endpoints change without notice. Parser fixes ship as patches; public API changes ship as minor releases until 1.0.
