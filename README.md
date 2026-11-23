# Panindigan Automate

[![Node.js](https://img.shields.io/badge/node.js-%3E%3D22%20(rec%20v26)-339933)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9%20(recommended)-orange)](https://pnpm.io)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.1-f472b6)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)](https://www.typescriptlang.org/)
[![CI](https://github.com/nazzelofficial/panindigan-automate/actions/workflows/ci.yml/badge.svg)](https://github.com/nazzelofficial/panindigan-automate/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/panindigan-automate.svg)](https://www.npmjs.com/package/panindigan-automate)
[![npm downloads](https://img.shields.io/npm/dm/panindigan-automate.svg)](https://www.npmjs.com/package/panindigan-automate)
[![npm total downloads](https://img.shields.io/npm/dt/panindigan-automate.svg)](https://www.npmjs.com/package/panindigan-automate)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Facebook Messenger automation for Node.js and Bun, written from scratch in strict TypeScript. Built with care by [**Nazzel**](https://github.com/nazzelofficial) for bot developers.

Panindigan Automate drives a personal Messenger account the same way the web client does — over Facebook's HTTP endpoints and a persistent MQTT-over-WebSocket connection — and wraps it in a typed, promise-based API. You can send, edit, unsend, and forward messages; react; manage threads, groups, participants, and admins; upload and download attachments; create and vote in polls; track presence, typing, and read receipts; and listen to every realtime event as it happens.

It is not a fork, wrapper, or port of any existing Messenger library. It targets **Node.js 22 LTS and Node.js 26** (Node.js 26 recommended) as well as **Bun (>= 1.1)**, ships dual ESM/CJS builds with bundled type declarations, and treats strictness — compile-time and runtime — as a design constraint rather than a preference: no `any` in the source, no stubs, no unvalidated external input, and discriminated unions on every event payload.

> *Panindigan* is a Tagalog word meaning "to hold one's ground." The library is named for the part of bot development everyone else leaves to you: keeping a session alive. Panindigan reconnects after drops, refreshes cookies before they expire, queues outbound packets while offline, persists session state across restarts, and tells you — precisely — why Facebook said no.

**Status: pre-1.0.** The public API may still change in minor releases until 1.0 lands. **Read the [Honest reality check](#honest-reality-check) before you ship this to a real account.**

**Documentation:** [Quick start](docs/quick-start.md) · [API reference](docs/api-reference.md) · [Authentication](docs/authentication.md) · [Troubleshooting](docs/troubleshooting.md) · [Error codes](docs/error-codes.md) · [Migration](docs/migration.md) · [FAQ](docs/faq.md)

---

## Honest reality check

Cookie-based automation of a personal Facebook account fights a live anti-abuse system. Some things you need to know before deploying:

- Facebook may restrict, checkpoint, or revoke the account. Usually because of *behavior*, not code.
- **The Stealth Guard reduces that risk; it does not eliminate it.** Nothing makes an automated personal account "safe". Anyone selling "undetectable Messenger botting" is lying.
- Your strongest protections are: an account you can afford to lose, conservative behavior, periodic cookie rotation, and stopping the moment Facebook challenges you. Re-export cookies regularly; watch `health_warning`/`health_critical`.
- If the session dies and Facebook will not accept a fresh one (`1357004` on a confirmed-fresh export from a residential connection), the account is restricted. Appeal in a browser, or use a different account. No code can change that.
- The official Meta Messenger Platform (Page bots) is the only fully supported path; it cannot drive personal accounts, groups you don't admin, or DMs you did not initiate.

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
import { login } from "panindigan-automate";

// CommonJS
const { login } = require("panindigan-automate");
```

Type declarations and source maps are included; there is no `@types` package to install.

### Main entry: `login()`

The documented, primary way in — promise-based, or fca-style callback:

```ts
import { login } from "panindigan-automate";

const client = await login("./appstate.json");                 // promise form
client.on("message", async (event) => {
  if (event.isSelf || !event.body) return;
  await client.sendMessage(event.threadId, { type: "text", body: `echo: ${event.body}` });
});
```

```js
// CommonJS — same function, callback accepted
const { login } = require("panindigan-automate");
login("./appstate.json", (err, client) => {
  if (err) return console.error(err);
  client.on("message", (event) => { /* ... */ });
});
```

`login(credentials, options?, callback?)` — `options` are the same `ClientOptions` object accepted by `new MessengerClient(options)`; pass `dryRun: true` etc.

### Also kept: the modern client

The full, typed `MessengerClient` API is equally supported — use it when you want explicit construction or non-trivial options:

```ts
import { MessengerClient } from "panindigan-automate";

const client = new MessengerClient();
client.on("ready", (event) => console.log(`logged in as ${event.userId}`));
await client.login("./appstate.json");
```

Both entry points produce the same `MessengerClient` — same events, same methods, same options. `login()` is nothing more than:

```ts
const client = new MessengerClient(options);
await client.login(credentials);   // this is what login() does
```

> A default export (`import login from "panindigan-automate"` / callable `require("panindigan-automate")`) also exists, but `import { login } from "panindigan-automate"` is the documented main entry.

## Modern API only

This library supports **one** API surface — the modern, typed `MessengerClient` API. There is no legacy compatibility layer and never will be one bundled: existing fca-era code should be ported to the modern event and method names (`messageId`, `threadId`, `senderId`, `participant_join`, `participant_leave`, `client.getThread`, `client.changeGroupTheme`, …); see [docs/migration.md](docs/migration.md) for the full mapping. Unported legacy-looking APIs in old codebases must be updated to the modern surface.

## Quick start

An echo bot in about 15 lines:

```ts
import { login } from "panindigan-automate";

const client = await login("./appstate.json");

client.on("message", async (event) => {
  if (event.isSelf || !event.body) return;
  await client.sendMessage(event.threadId, { type: "text", body: `echo: ${event.body}` });
});
```

Two things worth knowing early:

- `login()` resolves once the session is validated **and** the realtime connection is up. Until then, message events won't fire.
- Background failures (MQTT drops, session expiry, recovery giving up) surface on the `error` and `warning` events, not as rejected promises. In production, listen to both.

More examples in [`examples/`](examples/): echo bot, group manager, warmup-aware broadcast, dry-run, E2EE DM.

## Authentication

You authenticate with cookies exported from a browser session where you're already logged in. Six input formats are accepted and detected automatically — no wrappers, no type discriminator field required:

| Format | Input |
|--------|-------|
| AppState array | `[{ key: "c_user", value: "…", domain: "facebook.com", path: "/", expires: "2027-03-01" }, …]` |
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

**If Facebook rejects your session:** it answers with the logged-out page or a tiny JSON error envelope. The client surfaces exactly what was served (status, path, byte count, booleans — never cookie values) and tears the session down rather than pretending. Re-export cookies from a browser that is actually logged in; solve checkpoints there; if the account is restricted, appeal or use another account. See [docs/authentication.md](docs/authentication.md) for the full guide, including 2FA.

## Events

Listeners are typed end to end: register `client.on("message", …)` and the parameter is a `MessageEvent` — fields autocompleted, misspelled event names rejected at compile time. `client.on` and `client.once` return an unsubscribe function; `client.off`, `client.removeAll`, and `client.listenerCount` are also available.

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

Plus the Stealth Guard and E2EE additions: `suspension_warning`, `suspension_halt`, `suspension_reset`, `checkpoint`, `health_warning`, `health_critical`, `session_dead`, `risk_rising`, `e2ee_message`, `e2ee_message_edit`, `e2ee_message_reaction`.

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

`content` is a discriminated union — `{ type: "text", body }` (optionally with `mentions`), `{ type: "sticker", stickerId }`, `{ type: "gif", gifId }`, or `{ type: "attachment", attachmentId }` (from `uploadMedia`). Message bodies are capped at 20,000 characters, matching Facebook's limit; see [Idempotent sends & long messages](#idempotent-sends--long-messages) for automatic splitting.

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
| `muteThread` / `unmuteThread` | Notification mute — accepts an optional duration (minutes or `"always"`) |
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
| `prettyPrint` | `true` | Colorized, human-readable output on every host, including production. Set `false` in code for JSON |
| `logFile` | — | Write logs to a file |
| `logTransports` | `[]` | Additional transports receiving every log record |
| `httpTimeout` | `30000` | Per-request timeout, in ms |
| `httpRetries` | `3` | Retries on network errors and 429/5xx |
| `httpMaxRedirects` | `10` | Redirect limit (loops are detected immediately) |
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

Common options can also come from the environment — `LOG_LEVEL` (or `PANINDIGAN_LOG_LEVEL`), `PANINDIGAN_HTTP_TIMEOUT`, `PANINDIGAN_HTTP_PROXY`, `PANINDIGAN_RECONNECT_ATTEMPTS`, and so on. Programmatic options always win.

Pretty logging is **always on** in production: an old `PANINDIGAN_PRETTY_PRINT=false` is ignored. For machine-parsed JSON, set `PANINDIGAN_JSON_LOGS=true` or pass `prettyPrint: false` in code. Colors are emitted as ANSI; hosts that strip them still get the same human-readable text.

Two larger option objects deserve their own sections: [`stealth`](#stealth-guard-on-by-default) (on by default) and [`e2ee`](#e2ee-end-to-end-encryption-experimental) (off by default) — plus `dryRun: true` for a no-network rehearsal.

## Delay-based anti-spam (on by default)

Every mutating outbound operation passes through a real rate-shaping gate. It is not a cosmetic toggle — the delay is computed from actual send history:

- **Sliding window** (`antiSpamWindowMs`, default 60s): recent sends are tracked globally and per thread.
- **Threshold** (`antiSpamThreshold`, default 5): the first N sends in the window are not delayed.
- **Escalating delay**: beyond the threshold the wait grows exponentially — `antiSpamBaseDelayMs × 2^(excess-1)` — capped at `antiSpamMaxDelayMs` (default 10s), with ±25% jitter so the cadence is not fixed.
- **Independent per-thread windows** (`antiSpamPerThread`, default true): a busy thread does not slow down a quiet one, and vice versa.
- **Combined with pacing**: the anti-spam delay is added on top of the existing random `basePacingMs` jitter.

This sits alongside the token-bucket limits, hourly/daily caps, and the suspension-signal circuit breaker described below. To disable all of it for a bot account: `stealth: { enabled: false, pacingEnabled: false }` — a single `enabled: false` now fully disables pacing, anti-spam, caps, and the halt circuit (signals are still logged for diagnostics, but no action is taken).

## Stealth Guard (on by default)

The guard stops the bot from behaving in ways that trip restriction systems, and stops the bot safely when risk signals appear.

What it does, all wired into every mutating operation (send/edit/unsend/forward, reactions, group mutations, polls, mute/archive/delete):

- **Signal detection** — restriction codes and messages across HTTP, GraphQL, and the MQTT control plane (`1357004`, checkpoints, `429`, abuse flags, messaging limits, session death, …). Chat content never triggers the detector.
- **Circuit breaker** — repeated halting signals (default: 3 in 10 minutes) freeze the bot; every proactive send rejects with `AccountRestrictedError` (code `ACCOUNT_RESTRICTED`); the account stays frozen until a human runs `client.stealth.reset()` after the cooldown (default 24h).
- **Caps** — non-binding by default (no practical throughput limit). They exist as an opt-in guardrail: set `caps` lower if you want per-thread/hour/day ceilings.
- **Token buckets** — non-binding by default; configurable via `limits` if you want a hard rate. A max of 5 in-flight calls per operation+target still applies to prevent pile-ups.
- **Warmup** — over 7 days a fresh session's pacing eases from cautious to normal. Warmup shapes the inter-send delay (anti-detection), not throughput — day 0 does not reduce how many messages you can send.
- **Pacing** — randomized inter-operation delays; never metronomic.
- **Guard audit log** — the last 200 guard decisions, exported via diagnostics.

```ts
const client = new MessengerClient({
  stealth: {
    // everything optional; caps are non-binding by default:
    enabled: true,
    // caps: { perThreadPerHour: 30, globalPerHour: 100, globalPerDay: 200 }, // opt-in hard cap
    signalThreshold: 3,
    cooldownMs: 24 * 60 * 60 * 1000,
    // pace: false to disable pacing jitter
    // enabled: false to disable the guard entirely (not recommended)
  },
});

client.on("suspension_halt", (event) => console.error("GUARD HALTED:", event.reason));
client.on("checkpoint", (event) => console.warn("checkpoint from", event.operation));

// inspect:
console.log(client.stealth.getState());       // circuitState, signals, warmup day
console.log(client.stealth.getAudit());       // ring buffer of decisions

// after the cooldown:
await client.stealth.reset();
```

**The guard never bypasses a checkpoint, never retries one, never "escalates" your behavior to avoid detection. It stops the bot. That is the whole job.**

## Anti-Detection helpers (on by default)

Enabled by default since 0.2.0; opt out with `stealth: { antiDetection: false }`. What it actually does:

- **Human-like compose timing** — the pre-send delay now scales with message length and follows an approximately-normal distribution (`humanTypingDelay`): most messages land near a median, a few take noticeably longer. A `typingIndicatorDuration()` helper returns a shorter duration suitable for showing a typing indicator before a reply. Configurable with `typingRhythm` (default true).
- **Burst-pause rhythm** — after `burstPauseCount` rapid sends (default 10 within 5s), a longer natural pause (`burstPauseMs`, default 2s) is injected. Configurable.
- **Staggered subscription timing** on MQTT connect (subscription order randomization and per-topic delays) via `MqttObfuscationManager`.
- **One consistent browser identity** — the canonical `userAgent` from config is now used for the fingerprint, HTTP headers, and MQTT handshake together (`antiDetection.userAgent`). Previously the fingerprint generated a random Chrome 120–124 UA while requests sent Chrome 149 — a mismatch across layers. You can override it with `stealth: { antiDetection: { userAgent: "..." } }`.
- **Fingerprint API** — `client.getAntiDetectionFingerprint()` / `client.getHardwareDeviceId()` return a SHA-256 hash of the machine's CPU model, core count, primary MAC address, and hostname, formatted as a UUID. The hash is used **nowhere on the wire**.

What it does **not** do: it does not evade checkpoints, verify identities, or bypass any Facebook security control. Its effect on restriction rates has **not been measured** — these are timing/consistency mechanisms, not evasion technology. Claims like "indistinguishable from human behavior" or "anti-ban" are not made; no local code can guarantee a platform will not restrict an account.

## E2EE (End-to-End Encryption, experimental)

One-to-one Messenger **E2EE** (Signal Protocol + Noise XX transport) is built into this package. It is a faithful TypeScript port of [bhhoang/fbapi-unofficial](https://github.com/bhhoang/fbapi-unofficial)'s `src/e2ee/` (MIT), with per-file attribution in the source. It is **not** a from-scratch reimplementation, and we do not claim otherwise.

**Scope in this release:**

- ✅ 1:1 text messages — send and receive (sealed Signal envelopes)
- ✅ Reactions, edits and unsends received as events (`e2ee_message_reaction`, `e2ee_message_edit`, `message_unsend`)
- ✅ XEdDSA-signed prekeys, X3DH session establishment, Double Ratchet style ratcheting
- ✅ Device identity persisted at `<storageDirectory>/e2ee_device.json` — **keep the file**; deleting it registers a new E2EE device under your account
- ❌ Group E2EE (sender keys) — not implemented; group threads get `NotImplementedError`
- ❌ E2EE attachments — not implemented in this release
- ❌ Encrypted backup restore — not implemented

```ts
const client = new MessengerClient({
  e2ee: "auto", // "off" (default) | "auto" | "require"
});

client.on("e2ee_message", (event) => {
  console.log(`E2EE message from ${event.senderId}: ${event.body}`);
});

// Throws NotImplementedError in group threads
await client.sendEncryptedMessage(threadId, "secret 🔒");
```

- `"auto"` — E2EE enabled; connects at login (failure downgrades to a warning)
- `"require"` — E2EE enabled; login fails if the encrypted channel cannot be established
- `"off"` — E2EE disabled entirely

Fine-grained control is available via the object form: `e2ee: { enabled, require, autoConnect, selfListen, deviceListCacheMs, deviceStorePath }`.

**Honest status — read this before relying on it.** Offline tests (in `tests/e2ee.test.ts`) cover the WA-binary codec, the protobuf codec, RFC 5869 HKDF, XEdDSA sign/verify, the full X3DH + ratchet message path between two real device stores, the device-store persistence, and the complete Noise XX client handshake against an in-memory reference server. **No part of this has been verified by the authors against live Facebook.** Protocol details can drift; connecting registers an E2EE device on the account. Treat this as experimental, test with a throwaway account, and treat any breakage as expected until live verification is done. Facebook may block or change E2EE at any time.

## Dry-run mode

See exactly what the bot would send — nothing touches the network:

```ts
const dry = new MessengerClient({ dryRun: true });
```

Every outbound operation logs its payload summary and returns clearly-marked synthetic results. Use it before pointing the bot at a real account.

## Error handling

Everything the library throws is a `LibraryError` subclass with a machine-readable `code`, a `retryable` flag, and a `context` object that never contains credentials:

```ts
import { APIError, TimeoutError } from "panindigan-automate";

try {
  await client.sendMessage(threadId, { type: "text", body: "hi" });
} catch (error) {
  if (error instanceof TimeoutError && error.retryable) {
    // worth trying again
  } else if (error instanceof APIError && error.code === "API_ERROR") {
    // Facebook rejected the request
  }
}
```

Branch on `error.code`, not on `error.message` — messages are for humans and can change between releases. The full, stable registry is in [docs/error-codes.md](docs/error-codes.md).

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
| `AccountRestrictedError` | Stealth Guard circuit breaker halted the bot — code `ACCOUNT_RESTRICTED` |

Background failures surface on the `error`/`warning` events rather than as rejected promises — listen to both in production:

```ts
client.on("error", (event) => {
  const err = event.error;
  if (err.code === "ACCOUNT_RESTRICTED") { /* guard halted — stop, don't retry */ }
  if (err.code === "AUTH_REFRESH_REQUIRED") { /* re-export cookies */ }
});
```

## Middleware

Middleware hooks into every operation — before the request is sent, after the response lands, or on failure. Register globally or scoped to specific operations:

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

Execution order is deterministic: `before` runs global → plugin → user registrations; `after` runs user → plugin → global; `error` runs in reverse of `before` (user → plugin → global, reversed within each tier). Error middleware runs mirror of the `before` chain. Not calling `next()` short-circuits the chain. Full context shape and ordering rules are in the [API reference](docs/api-reference.md#middleware).

## Plugins

```ts
import type { Plugin } from "panindigan-automate";

const messageCounter: Plugin = {
  name: "message-counter",
  version: "1.0.0",
  async onLoad(context) {
    context.on("message", async (event) => {
      const count = Number((await context.cache.get(`count:${event.threadId}`)) ?? 0) + 1;
      await context.cache.set(`count:${event.threadId}`, count, { tags: ["message-counter"] });
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

Plugins run in a sandboxed context: a child logger, namespaced cache and storage scopes, middleware registration, and event listeners that are removed automatically when the plugin is disabled. A plugin never sees the cookie jar, the transports, or another plugin's state. The lifecycle and full context API are in the [API reference](docs/api-reference.md#plugins).

## Logging

The default is **professional colorized output on every host** — local, Render, Docker, anywhere. Pino redacts secrets first, then one centralized formatter renders every record:

```text
12:11:41 PM  ℹ INFO   [panindigan-automate] [MQTT] MQTT connection established
12:11:42 PM  ⚠ WARN   [panindigan-automate] [MQTT] Connection lost. Reconnecting...
12:11:43 PM  ✖ ERROR  [panindigan-automate] [MQTT] MQTT connection failed
12:11:44 PM  ● DEBUG  [panindigan-automate] [HTTP] Request completed
```

Errors print their complete stack trace on the following lines. Key lifecycle events render as framed panels (`MQTT CONNECTED`, `REALTIME READY`, `STEALTH GUARD`). ANSI colors are emitted for log levels; hosts that strip ANSI still show the same readable format. `logFile` and custom transports receive the same redacted records at the same time.

```ts
const client = new MessengerClient(); // colorized by default, even in production
```

For machine-parsed JSON (log aggregators), opt out explicitly — in code or with `PANINDIGAN_JSON_LOGS=true`:

```ts
const client = new MessengerClient({ prettyPrint: false });
```

There is also a richer console logger with banners and indicators. **It does not redact secrets — local use only.**

```ts
const client2 = new MessengerClient({ useConsoleLogger: true });
```

If you build a custom logger tree, `createRootLogger` is also exported at the package root:

```ts
import { createRootLogger } from "panindigan-automate";
```

## Diagnostics

Long-running bots need observability. `client.diagnostics.getSnapshot()` returns a typed snapshot of everything the library measures:

```ts
const snapshot = client.diagnostics.getSnapshot();
console.log(snapshot.http.requests.total, snapshot.http.latency.p95);
console.log(snapshot.mqtt.heartbeat.avgMs, snapshot.mqtt.queue.depth);
console.log(snapshot.cache.hitRate, snapshot.events.throughput);
console.log(snapshot.stealth); // guard state, caps, health score, audit log
```

HTTP counts and latency percentiles, retries, MQTT heartbeat round-trip times and reconnect count, queue depth, cache hit rate, per-event emission counts, and process memory — collected since startup or the last `diagnostics.reset()`.

```ts
const json = client.diagnostics.exportJSON();  // attach to incident reports
const html = client.diagnostics.exportHTML();  // self-contained, no external assets
```

Set `PANINDIGAN_DEBUG=1` and an uncaught exception writes `debug-report.json` next to your process. Guard decisions are recorded in a 200-entry audit log; health score trends feed `health_warning`/`health_critical`; a send-volume surge emits `risk_rising` before any restriction signal fires.

## Idempotent sends & long messages

- Identical sends within 24h return the cached message id — retries never duplicate a message.
- Text bodies longer than 2000 characters split at sentence/paragraph boundaries with human-like inter-chunk delays. Mentions disable chunking.

## Groups, polls, themes

Everything in [docs/api-reference.md](docs/api-reference.md): group create/participants/admin/nickname/photo/name/emoji/theme, polls with voting, thread list/search, pinned presence. Thread colors accept the theme ids in `client.getThreadColorList()` (Facebook rejects hex). Invite links are `NotImplementedError` — no maintained implementation exists anywhere; use the Facebook app.

## Update checker & doctor

```ts
const client = new MessengerClient({
  update: { enabled: true }, // default since 0.2.0 — checks on startup and every 24h; installs automatically
});

const info = await client.update.check();
if (info) console.log(`update available: ${info.current} → ${info.latest}`);
// explicit install (also what the automatic path does): backs up, rolls back on failure; restart is yours:
// await client.update.install();
```

**Automatic updates are on by default since 0.2.0.** A client constructed with no `update` options checks the npm registry on startup and every 24 hours, and installs a newer published version automatically (with backup and rollback on failure; a process restart is required afterwards — automatic updates do not restart your bot).

```ts
const client = new MessengerClient({
  update: { enabled: false },        // turn the checker off entirely
  // or
  update: { autoInstall: false },    // notices only; never install automatically
});
```

Installation method options: `packageManager` (auto-detected from the lockfile when unset), `releaseChannel` (npm dist-tag, default `"latest"`), `timeout` (registry timeout ms, default 30s), `autoRestart` (default false — never restart for you), `allowPrerelease` (default false).

Client-level convenience helpers (same behavior as `client.update.*`):

```ts
client.getUpdateStatus();   // installed/latest versions, availability, history
client.getUpdateHistory();  // readonly UpdateHistory[] of the last installs
await client.checkForUpdates();  // triggers a check now; installs automatically if autoInstall is set
await client.installUpdate();    // installs the available update now
```

```bash
npx panindigan-automate doctor [--login]
```

Checks Node version, required cookies, storage writability, facebook.com and MQTT edge reachability — `--login` performs a real end-to-end login and logs out.

## Protocol notes

Wire-level facts about how this library talks to Messenger. These describe the implementation in this package — assembled from observation of the web client and actively maintained Messenger-automation implementations — and have **not** been re-verified against live Facebook for this release. Treat them as an accurate map of the code, not a guarantee of Facebook's current server behavior. Useful when debugging or writing a `raw`-event consumer.

- **Realtime transport.** MQTT 3.1 (`MQIsdp`, protocol level 3) over WebSocket at `wss://edge-chat.facebook.com/chat?region=<region>&sid=<session>&cid=<client>`, or the regionless `wss://edge-chat.facebook.com/chat?sid=<session>&cid=<client>` when no region is known. The CONNECT username is the JSON session blob Messenger's web client sends (`u`, `s`, `chat_on`, `fg`, `d`, `ct: "websocket"`, `aid: "219994525426954"`, `mqtt_sid`, `cp: 3`, `ecp: 10`, `st: []`, `pm: []`, `dc`, `no_auto_fg: true`, `gas: null`, `pack: []`); topics are subscribed individually after CONNACK rather than embedded in `st`. When the account's region is unknown, connection attempts rotate through the `prn`, `pnb`, `vll`, `hkg`, `sin`, `ftw`, and `ash` region variants before giving up on a host, and the first region that succeeds is remembered for later reconnects.
- **Sync stream.** After the connection is established, the client subscribes to 19 topics (including `/t_ms`, the delta stream, and the `/ls_req`/`/ls_resp` pair) and publishes a sync queue on `/messenger_sync_create_queue` — sync protocol version 11, `max_deltas_able_to_process` 100, `delta_batch_size` 500 — with `device_params: null` and, when a sequence id is already known, `initial_titan_sequence_id`. Reconnects that still hold a token use `/messenger_sync_get_diffs` instead. The first `/t_ms` reply carries `syncToken` and `firstDeltaSeqId`; later replies carry `lastIssuedSeqId`. A `/t_ms` whose `errorCode` is the string `ERROR_QUEUE_NOT_FOUND` or `ERROR_QUEUE_OVERFLOW` means the queue died: the cursor is cleared, a fresh sequence id is fetched, and a new queue is created on the same connection. A fresh connection that sees no `/t_ms` traffic within 5 seconds is treated as broken and cycled. `/foreground_state` and `/set_client_settings` are published after the queue is created; a graceful shutdown publishes `/browser_close` before the socket is closed.
- **Login tokens.** `login()` loads the desktop root page (`/`) and scrapes `fb_dtsg` from `DTSGInitialData`, `lsd` from `["LSD",[],{"token":"…"}]`, `clientID`, the MQTT region from the `irisSeqID`/`MqttWebConfig` endpoint payloads, and `iris_seq_id`; `jazoest` is derived as `"2"` plus the sum of the `fb_dtsg` character codes. With `validateOnLogin` (the default), `/chat/user_info/` is then posted for the authenticated id to confirm Facebook accepts the session, and `/ajax/presence/reconnect.php?reason=6` re-establishes the web client's presence session before the realtime connection is awaited.
- **Lightweight service.** Message edits and typing indicators are task-style requests published to `/ls_req` (application id `2220391788200892`) and correlated by request id on `/ls_resp`, with a 10-second default timeout.
- **GraphQL.** Thread list, thread info, and message history go through `/api/graphql` with document id `3336396659757871` (batch `MessengerGraphQLThreadlistFetcher` — also the source of the sync sequence id), `3449967031715030` (batch `MessengerGraphQLThreadFetcher`), and `1498317363570230`. Reactions use document id `1491398900900362`; forced fetches of a single delta's full payload use `2848441488556444` with `thread_and_message_id`, the same document used for quoted-message lookups. Group creation uses `577041672419534` at `/api/graphql/`; thread themes use `1727493033983591` at `/api/graphqlbatch/`. `/api/graphqlbatch/` replies are a sequence of concatenated JSON objects plus a summary object, not a JSON array.
- **Mercury.** Sends and thread mutations use the classic form-encoded `/messaging/send/`-family endpoints with a rotating `fb_dtsg` token; attachments upload to Facebook's upload host first. Group sends set `thread_fbid`; 1:1 sends set `specific_to_list[0]`/`specific_to_list[1]` and `other_user_fbid`. The thread kind comes from the client's cache, from a thread-info lookup for ambiguous 15-character ids, and otherwise from the web client's length heuristic. Group membership is a `log:subscribe` log message; removals go to `/chat/remove_participants`. Group photo changes upload first, then post `thread_image_id` to `/messaging/set_thread_image/`.
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

## Migration from 0.1.6

Nothing breaks; new behavior is additive or opt-out:

- Stealth Guard is **on by default** — pace every send, or `stealth: { enabled: false }`.
- `THREAD_COLORS` are now theme ids; arbitrary hex throws `ValidationError`. Use `getThreadColorList()`.
- `changeGroupPhoto` unchanged; `changeGroupAvatar` is an alias.
- `muteThread()` accepts an optional duration (minutes or `"always"`).
- Session refresh is best-effort; `AUTH_REFRESH_REQUIRED` is terminal for the current login — re-export cookies.

Also see [docs/migration.md](docs/migration.md) for the full legacy→modern mapping (method names, event names, id fields).

## Documentation

| Guide | Description |
| :--- | :--- |
| [Quick Start](docs/quick-start.md) | Install to a running echo bot in under 5 minutes |
| [Authentication](docs/authentication.md) | The 6 credential formats, cookie refresh, and 2FA |
| [API Reference](docs/api-reference.md) | Complete signatures, parameter tables, and examples — including middleware and plugins |
| [Console Logger](docs/console-logger.md) | Colorized terminal logging with `useConsoleLogger` |
| [Cookie Export Guide](docs/COOKIE-EXPORT-GUIDE.md) | How to export a session cookie set from a browser |
| [Migration](docs/migration.md) | Transitioning from legacy/unmaintained FCA libraries |
| [Troubleshooting](docs/troubleshooting.md) | Error codes, diagnostics, and debugging |
| [Error Codes](docs/error-codes.md) | Machine-readable error registry |
| [FAQ](docs/faq.md) | Common questions, ban prevention, and deployment |
| [Examples](examples/) | Ready-to-run bot scripts (echo bot, group manager) |

## Testing & contributing

```bash
pnpm install
pnpm run test
pnpm run typecheck
pnpm run build
```

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Every change needs tests; every public API change needs docs; every bug fix gets a regression test that stays in the suite. New endpoints need evidence against a live account or a note saying why you can't verify them — do not guess Facebook's wire format. Bug reports and feature requests can use the GitHub issue templates.

## Author

Created and maintained by [**Nazzel** (@nazzelofficial)](https://github.com/nazzelofficial) for bot developers everywhere.

## License

[MIT](LICENSE)
