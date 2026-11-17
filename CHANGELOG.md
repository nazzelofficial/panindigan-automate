# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- Optional Redis (`ioredis`) and SQLite (`better-sqlite3`) adapters for cache and storage
- Sentry (`@sentry/node`) log transport
- OpenTelemetry tracing hooks for the diagnostics module

## [0.1.7] - 2026-11-16

### Added

- **Compatibility `login()` entry point** — the main documented entry: `import { login } from "panindigan-automate"` in ESM and `const { login } = require("panindigan-automate")` in CommonJS. Also exported as the default (and `require("panindigan-automate")` is callable fca-style). Promise and callback signatures both work, with the same `ClientOptions` object as `new MessengerClient(options)`; `new MessengerClient()` remains fully supported for explicit construction and the `ready` event. This is a thin convenience over `MessengerClient#login` — new code should prefer `login()` or the constructor. README, quick-start, migration guide, api-reference and the bundled examples now lead with `import { login }`.
- **Stealth Guard** (`client.stealth`): outbound account protection, all wired into every mutating method in the client (send, edit, unsend, forward, reactions, group mutations, polls, mute/archive/delete).
  - **Suspension signal detector** (A1): restriction codes and messages across HTTP responses, GraphQL errors, MQTT control-plane payloads, and raw text — checkpoint/identity verification (`1357001`, `1357004`, `392024945`, 202, 459, …), spam/abuse flags, rate limits (`429`, `1675035`), messaging restrictions (`2061011`, `1545012`, `1545014`, `368`), session death (`190`, `102`, `460`, `463`, `467`). Severity ladder `warn < pause < halt < critical`. Text patterns are only matched on the control plane — chat content never can halt the bot.
  - **Circuit breaker** (A2): `signalThreshold` halting signals inside `signalWindow` → open circuit; all proactive sends reject with `AccountRestrictedError` (code `ACCOUNT_RESTRICTED`); emits `suspension_halt`; manual `client.stealth.reset()` after the cooldown (default 24h). Resumes on nothing automatically — a halt after `critical` stays halted until you reset.
  - **Sliding-window caps** (A4): hard hourly/daily counters — defaults 30 messages per thread per hour, 100/hour and 200/day globally. Crossing 80% doubles pacing (warning); 100% halts proactive sends until the window resets; the per-thread cap is bounded and tracked per target.
  - **Token buckets + in-flight bound** (A3): per-operation buckets (`sendMessage` / `addReaction` / `createGroup` / `global` with burst + sustained refill) and a max of 5 in-flight calls per operation+target, counted before completion.
  - **Warmup mode** (A5): fresh sessions ramp from 30% of cap to 100% over `warmupDays` (default 7), persisted across restarts.
  - **Natural pacing** (A6): randomized inter-operation delay (`basePacingMs` × jitter) unless `pacingEnabled: false`; doubled under cap warnings.
  - **Checkpoint realtime guard** (A9): checkpoint-class signals force the circuit open immediately (`forceHalt`) and emit `checkpoint`; retries against checkpoints never happen.
  - **State persistence**: circuit state, signal history, warmup progress, caps, and warmup day survive restarts.
  - **Guard audit log** (G8): ring buffer of the last 200 guard decisions (allow/deny/halt/cap/reset/…) with reasons — exported via diagnostics, never leaves the process policy by itself.
- **Session health score** (G1): `health_warning` / `health_critical` events; score shown in `diagnostics` and in the guard callbacks.
- **Risk forecast** (G2): hour-over-hour send-volume acceleration emits `risk_rising` before any restriction signal fires.
- **Guard diagnostics export** (F3): `client.diagnostics.exportJSON()` / `exportHTML()` — self-contained report (HTTP latency percentiles, MQTT queue, guard counters, audit log) attached to incidents; no upload.
- **Error code registry** (F5): `docs/error-codes.md` — every `error.code` with meaning and the action to take.
- **Idempotent send** (G5): every send computes a client-side idempotency key; retries of an identical send return the cached message id instead of posting a duplicate (24h TTL, persisted).
- **Adaptive chunking** (G3): text bodies over 2000 chars split at sentence/paragraph/line/word boundaries with reading-time inter-chunk delays; mentions disable chunking; disabled with `chunking.enabled: false`.
- **Thread heat index** (G4): local, own-traffic-only per-thread activity ranking exposed in `diagnostics` (`stealth.threads.tracked`, `stealth.threads.hottest`). No message content involved.
- **Dry-run mode** (G6): `dryRun: true` — every outbound operation logs the payload it would send; nothing touches the network; results are clearly synthetic.
- **E2EE (End-to-End Encryption) — experimental, 1:1 only.** A faithful TypeScript **port** of [bhhoang/fbapi-unofficial](https://github.com/bhhoang/fbapi-unofficial)'s `src/e2ee/` (MIT), with attribution in each ported file. Not a from-scratch reimplementation.
  - **Signal Protocol** — X3DH key agreement with XEdDSA-signed prekeys, Double Ratchet style ratcheting
  - **Noise XX handshake** — WebSocket transport over `wss://web-chat-e2ee.facebook.com/ws/chat` with AES-256-GCM frames
  - **WA Binary Protocol** — stanza codec (tokens, dictionaries, JIDs, packed strings, zlib-aware unmarshal)
  - **Send and receive encrypted 1:1 text** — `sendEncryptedMessage()`, events `e2ee_message`, `e2ee_message_edit`, `e2ee_message_reaction` (unsends surface as `message_unsend`)
  - **Device persistence** — identity and prekeys persist at `<storageDirectory>/e2ee_device.json` (atomic writes, owner-only)
  - **Deliberately not in this release** — group E2EE (sender keys), E2EE attachments, encrypted backup restore. Group threads throw `NotImplementedError`; there is no fallback that silently sends plaintext.
  - **Honest status:** offline tests (WA/protobuf codec, RFC 5869 HKDF, XEdDSA, full X3DH round trip between two device stores, Noise XX client handshake vs an in-memory reference server) pass. **Live behavior against real Facebook has not been verified by the authors.** Connecting registers an E2EE device on the account; use a throwaway account first and expect breakage if Facebook changes the protocol.
- **Safe update checker** (B): announce-only by default (disabled until `update.enabled: true`); checks the registry at most once per `checkIntervalMs` (default 24h); `client.update.check()` reports; `client.update.install()` is an explicit call — prints a plan, backs up the installed package, installs, rolls back on failure; restart is yours. `panindigan-automate doctor` (`bin`) checks Node, cookies, storage writability, facebook.com reachability and MQTT edge reachability; `--login` optionally performs a real end-to-end login.
- **Group tools** (E): `getThreadColorList()` — the verifiable registry of theme ids (hex is rejected by Facebook since ~2019); `changeGroupTheme` accepts a registry name or raw numeric theme id; `changeGroupAvatar` alias; `muteThread(duration?: number | "always")` validates minutes (1–525600) or `"always"`.
- **Examples**: `examples/` — echo bot, dry-run demo, group manager, warmup-aware broadcast, E2EE demo.
- **CI**: `.github/workflows/ci.yml` — typecheck, tests, pack smoke check.
- Public API surface: `StealthGuard`, `SuspensionDetector`, guard primitives, `E2EEClient` and the `e2ee/` modules, `GuardAuditLog`, `UpdateChecker`, `isOlder`.

### Removed

- The experimental `e2ee.bridge: "fb-messenger-e2ee"` bridge and `FMEMessengerBridge` were **removed**. The E2EE surface is a port of bhhoang/fbapi-unofficial's `src/e2ee/` (MIT, included in this package's source); there is no longer any option to delegate to an external AGPL client from inside this package, and no `@noble/curves` — the ported code uses Node's built-in crypto (X25519, Ed25519-family verification via XEdDSA). `E2EE_BRIDGE_NOT_INSTALLED` is kept as a compatibility-only code but is not raised.

### Fixed

- **Structured constructor options were rejected at validation time.** `splitOptions` passed every non-scalar key (`dryRun`, `stealth`, `e2ee`, `update`, …) into the strict scalar Zod schema, so documented options like `{ dryRun: true }`, `{ stealth: { enabled: false } }`, `{ e2ee: "auto" }` and `{ update: { enabled: true } }` threw `ValidationError: Unrecognized key` at construction. They are now routed around the scalar validator (typo detection for the scalar keys is retained) — regression coverage added in `tests/login.test.ts`.
- **1357004 ("session needs refresh") recovery — actually shipped this time.** An intermediate working state had replaced the recovery with a stub that unconditionally returned failure (and claimed modern Facebook makes it unrecoverable); that claim was disproven by the maintained references. The client once again refreshes `fb_dtsg`/`jazoest` from the mobile surface with `withDefaults: false` (so the stale tokens are not sent back) and retries `home.php` once. If that also fails, the cookies are revoked beyond recovery: login fails with `AUTH_REFRESH_REQUIRED` (`retryable: false`) and a re-export instruction, and the guard freezes outbound sends.
- 1357004 maps to `AUTH_REFRESH_REQUIRED` at the interpreter (an intermediate work state had folded it into `AUTH_SESSION_EXPIRED` without the recovery attempt).
- Version mismatch: `VERSION` was `0.1.7` while `package.json` said `0.1.8` in an unreleased working state; both now say `0.1.7`.
- **THREAD_COLORS were non-functional** — they carried hex strings, but Facebook's theme mutation takes theme ids; the set is now the verified theme-id registry. Arbitrary hex can no longer be passed silently.
- Invite links (`createInviteLink` / `joinGroupByLink`): throw `NotImplementedError` — no maintained client implements them and no publicly verifiable endpoint exists. The previous silent-hex acceptance was a footgun; this fails loud instead.
- Poll question caching documented: `poll` events populate `#pollQuestions`; `getPoll()` reads the cached question when Facebook omits it, else falls back to `""`. Behavior covered by `normalizePoll` tests.
- `client.stealth.getWarmupMultiplier()` no longer persists on every read (only on day change), matching the documented behavior.

### Security

- Checkpoint signals are never retried — the guard freezes on first critical checkpoint signal.
- No secret ever reaches diagnostics, the guard audit log, or the error registry — only severities, codes, and non-secret context.
- E2EE device keys and session state persist in the device store with owner-only permissions — keep this file secure. The E2EE code is a port of bhhoang/fbapi-unofficial (MIT); no separate crypto library is bundled. XEdDSA-signed prekeys and X25519 sessions are verified by the offline tests, but the protocol path against live Facebook is unverified — treat it as experimental.

### Notes

- Nothing between 0.1.6 and this release was published; 0.1.7 is the next sequential release after 0.1.6.
- The docs and `examples/` now lead with `import { login } from "panindigan-automate"` (or `const { login } = require(...)`); `new MessengerClient(...)` remains documented for explicit construction and the `ready` event.
- Stealth Guard reduces account restriction risk; it cannot make an automated personal account "safe" — Facebook's systems change without notice. Re-export cookies periodically and reset the guard manually after checkpoints.

## [0.1.6] - 2026-11-15

### Added

- Automatic recovery from Facebook's error `1357004` ("session needs refresh"), the exact envelope observed in production (`status=200, bytes=249, {"error":1357004}`). The login and cookie-refresh flows now detect this envelope, refresh `fb_dtsg`/`jazoest` from the server-rendered mobile surface (`m.facebook.com/`, hidden-input scrape — the same rotation web/mobile clients perform), and retry `home.php` once. When the refresh yields nothing or the retry still returns `1357004`, login fails with `AUTH_REFRESH_REQUIRED` (retryable only at the HTTP layer) and the session is torn down — never silently retried or bypassed.
- New error code `AUTH_REFRESH_REQUIRED` in `ErrorCode` and `interpretFacebookError` maps `1357004` to it (previously surfaced as the generic `API_ERROR`).
- `extractMobileTokens()` in `src/client/home.ts` — scrapes `fb_dtsg`/`jazoest` hidden inputs from the mobile surface; derives `jazoest` via `computeJazoest` when the page omits it. `safeHomeDiagnostics` unchanged (no values logged, ever).
- Regression tests for the `1357004` mapping (including the exact production envelope and the anti-hijacking `for (;;);` prefix) and for `extractMobileTokens`; suite passes at 124 tests.

### Fixed

- **Critical:** `#refreshSessionTokens()` now correctly passes `withDefaults: false` when fetching from `m.facebook.com/`. Previously, the mobile token refresh request incorrectly attempted to include `fb_dtsg`/`jazoest` (the very tokens being refreshed), causing the request to fail with missing or stale tokens. The mobile surface only requires basic authentication cookies (`c_user`, `xs`, `datr`), not CSRF tokens. This fix ensures error `1357004` recovery works as designed — matching how browser clients handle stale sessions.
- `home.php` scrapes (login and cookie refresh) send a browser-like `Accept: text/html,...` header, so Facebook answers with the HTML shell instead of the JSON error envelope on newer stacks — while the JSON-envelope interpreter remains as a precise detector when it happens anyway.

## [0.1.5] - 2026-11-15

### Fixed

- **The exact production failure observed in the logs** (`status=200 path=/home.php bytes=249`): Facebook's unauthenticated response to `www.facebook.com/home.php` is a tiny JSON error envelope, not a page. Home-page scrapes now send a browser-like `Accept: text/html,...` header so Facebook serves the real page, and the client detects a JSON error envelope via `parseFacebookJson` + `interpretFacebookError` — surfacing the actual Facebook error (e.g. `Not logged in`) instead of the ambiguous "Could not read Facebook's session tokens from the home page".
- Login and cookie refresh now throw the *real* Facebook error verbatim (code, retryable flag, and message such as `Not logged in`), with the page diagnostic summary appended — no more dead-end authentication errors for this class of response. The same safe diagnostics (`status`, `path`, `bytes`, booleans) appear in the context and in the message itself so they show at any log level, not just `debug`/`trace`.
- The `Accept` header now distinguishes HTML navigations (`text/html,...`) from API requests, matching what a browser sends — a prerequisite for Facebook serving the HTML shell instead of the JSON envelope.
- Regression tests for the error-envelope detection (`tests/home.test.ts`); suite passes at 118 tests.

## [0.1.4] - 2026-11-15

### Added

- A dedicated, value-free home-page diagnostics module (`src/client/home.ts`). It reports `status`, the URL path only, body length, and booleans — `mqttWebConfigEmpty`, `fbDtsgPresent`, `lsdPresent`, `hasLoginForm`, `hasCheckpoint` — with zero cookies, tokens, or HTML.
- `login()` and the background cookie refresh now log these diagnostics at `warn` level (visible at default `info` log levels) and include them in the thrown `AuthenticationError` context and in the error message itself, so production logs show exactly what Facebook served without a code change.
- Explicit detection of Facebook's logged-out SSR splash screen: `MqttWebConfig` carrying `"fbid":"0"` now raises `AuthenticationError` with an actionable message ("re-export your cookies from a browser that is actually logged in") instead of the ambiguous "Could not read Facebook's session tokens from the home page".
- Regression tests (`tests/home.test.ts`) with fixtures trimmed from live Facebook pages (November 2026): the logged-out splash, an authenticated boot payload, a checkpoint page, and an empty page.

### Fixed

- Facebook session rejection now classifies precisely: a logged-out splash screen (`fbid:"0"`), a login redirect, or a checkpoint page each produce a distinct, safe error — including whether the session was never accepted vs. an expired/challenged one — and all of them funnel to the same session-expiry teardown. Checkpoints are never bypassed.
- The background cookie refresh applies the same logged-out/login/checkpoint detection and logs warn-level diagnostics, instead of failing silently behind `debug`-level logging.

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
