# Panindigan Automate

[![Node.js](https://img.shields.io/badge/node.js-%3E%3D22%20(rec%20v26)-339933)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9%20(recommended)-orange)](https://pnpm.io)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.1-f472b6)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)](https://www.typescriptlang.org/)
[![CI](https://github.com/nazzelofficial/panindigan-automate/actions/workflows/ci.yml/badge.svg)](https://github.com/nazzelofficial/panindigan-automate/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/panindigan-automate.svg)](https://www.npmjs.com/package/panindigan-automate)
[![npm downloads](https://img.shields.io/npm/dm/panindigan-automate.svg)](https://www.npmjs.com/package/panindigan-automate)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Programmatic Facebook Messenger automation for personal accounts, written from scratch in strict TypeScript. Panindigan drives the account the way the web client does — HTTP endpoints plus a persistent MQTT-over-WebSocket socket — and puts a typed, promise-based API on top of it.

It is **not** a fork, wrapper, or port of any existing Messenger library. It targets **Node.js 22+** (Node.js 26 recommended) and **Bun >= 1.1**, ships dual ESM/CJS builds with bundled type declarations, and treats strictness as a design constraint: no `any` in the source, no stubs, no unvalidated external input.

> *Panindigan* is Tagalog for "to hold one's ground." The library is named for the hardest part of bot development: keeping a session alive. Panindigan reconnects after drops, refreshes cookies before they expire, queues outbound packets while offline, persists session state across restarts, and tells you — precisely — why Facebook said no.

**Status: pre-1.0.** The public API may change in minor releases until 1.0 lands. **Read the [Honest reality check](#honest-reality-check) before you ship this to a real account.**

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

- **Node.js 22+** (Node.js 26 recommended) or **Bun >= 1.1**
- Credentials from a logged-in Facebook session — see [Authentication](docs/authentication.md). No email/password login, by design.

## Installation

```bash
pnpm add panindigan-automate
```

```ts
import { login } from "panindigan-automate";
// CommonJS: const { login } = require("panindigan-automate");
```

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
  client.on("message", ...);
});
```

`login(credentials, options?, callback?)` — `options` are the same `ClientOptions` object accepted by `new MessengerClient(options)`; pass `dryRun: true` etc.

### Also kept: the modern client

The full, typed `MessengerClient` API is unchanged and equally supported — use it when you want explicit construction or non-trivial options:

```ts
import { MessengerClient } from "panindigan-automate";

const client = new MessengerClient();
client.on("ready", (event) => console.log(`logged in as ${event.userId}`));
await client.login("./appstate.json");
```

Both entry points produce the same `MessengerClient` — same events, same methods, same options. `login()` is nothing more than this:

```ts
const client = new MessengerClient(options);
await client.login(credentials);   // this is what login() does
```

> A default export (`import login from "panindigan-automate"` / callable `require("panindigan-automate")`) also exists, but `import { login } from "panindigan-automate"` is the documented main entry.

## Modern API only

This library supports **one** API surface — the modern, typed `MessengerClient` API. There is no legacy compatibility layer and never will be one bundled: existing fca-era code should be ported to the modern event and method names (`messageId`, `threadId`, `senderId`, `participant_join`, `participant_leave`, `client.getThread`, `client.changeGroupTheme`, …); see [docs/migration.md](docs/migration.md) for the full mapping. Unported legacy-looking APIs in old codebases must be updated to the modern surface.

## Quick start

```ts
import { login } from "panindigan-automate";

const client = await login("./appstate.json");

client.on("message", async (event) => {
  if (event.isSelf || !event.body) return;
  await client.sendMessage(event.threadId, { type: "text", body: `echo: ${event.body}` });
});
```

More examples in [`examples/`](examples/): echo bot, group manager, warmup-aware broadcast, dry-run, E2EE DM.

## Authentication

Six credential formats, auto-detected — AppState array, AppState object, JSON file path, environment variable name, cookie array, or a raw cookie header string. Only `c_user`, `xs` and `datr` are required; they are validated before any network request is made. See [docs/authentication.md](docs/authentication.md).

**If Facebook rejects your session:** it answers with the logged-out page or a tiny JSON error envelope. The client surfaces exactly what was served (status, path, byte count, booleans — never cookie values) and tears the session down rather than pretending. Re-export cookies from a browser that is actually logged in; solve checkpoints there; if the account is restricted, appeal or use another account.

## Stealth Guard (on by default)

The guard stops the bot from behaving in ways that trip restriction systems, and stops the bot safely when risk signals appear.

What it does, all wired into every mutating operation (send/edit/unsend/forward, reactions, group mutations, polls, mute/archive/delete):

- **Signal detection** — restriction codes and messages across HTTP, GraphQL, and the MQTT control plane (`1357004`, checkpoints, `429`, abuse flags, messaging limits, session death, …). Chat content never triggers the detector.
- **Circuit breaker** — repeated halting signals (default: 3 in 10 minutes) freeze the bot; every proactive send rejects with `AccountRestrictedError` (code `ACCOUNT_RESTRICTED`); the account stays frozen until a human runs `client.stealth.reset()` after the cooldown (default 24h).
- **Caps** — 30 messages/thread/hour, 100/hour, 200/day, configurable. Crossing 80% doubles pacing; at 100% proactive sends stop until the window resets.
- **Token buckets** — per-operation burst + sustained refill, plus a max of 5 in-flight calls per operation+target.
- **Warmup** — fresh sessions ramp from 30% to 100% over 7 days.
- **Pacing** — randomized inter-operation delays; never metronomic.
- **Guard audit log** — the last 200 guard decisions, exported via diagnostics.

```ts
const client = new MessengerClient({
  stealth: {
    // everything optional; sensible strict defaults:
    enabled: true,
    caps: { perThreadPerHour: 30, globalPerHour: 100, globalPerDay: 200 },
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

**Honest status — read this before relying on it.** Offline tests (in `tests/e2ee.test.ts`) cover the WA-binary codec, the protobuf codec, RFC 5869 HKDF, XEdDSA sign/verify, the full X3DH + ratchet message path between two real device stores, the device-store persistence, and the complete Noise XX client handshake against an in-memory reference server. **No part of this has been verified by the authors against live Facebook.** Protocol details can drift; connecting registers an E2EE device on the account. Treat this as experimental, test with a throwaway account, and treat any breakage as expected until live verification is done. `Facebook may block or change E2EE at any time.`

## Dry-run mode

See exactly what the bot would send — nothing touches the network:

```ts
const dry = new MessengerClient({ dryRun: true });
```

Every outbound operation logs its payload summary and returns clearly-marked synthetic results. Use it before pointing the bot at a real account.

## Diagnostics & debugging

```ts
const snapshot = client.diagnostics.getSnapshot();
console.log(snapshot.http.latency.p95, snapshot.mqtt.queue.depth);
console.log(snapshot.stealth); // guard state, caps, health score, audit log

const json = client.diagnostics.exportJSON();  // attach to incident reports
const html = client.diagnostics.exportHTML();  // self-contained, no external assets
```

Set `PANINDIGAN_DEBUG=1` and an uncaught exception writes `debug-report.json` next to your process.

Guard decisions are recorded in a 200-entry audit log; health score trends feed `health_warning`/`health_critical`; a send-volume surge emits `risk_rising` before any restriction signal fires.

## Idempotent sends & long messages

- Identical sends within 24h return the cached message id — retries never duplicate a message.
- Text bodies longer than 2000 characters split at sentence/paragraph boundaries with human-like inter-chunk delays. Mentions disable chunking.

## Groups, polls, themes

Everything in [docs/api-reference.md](docs/api-reference.md): group create/participants/admin/nickname/photo/name/emoji/theme, polls with voting, thread list/search, pinned presence, `fronter`-free surfaces. Thread colors accept the theme ids in `client.getThreadColorList()` (Facebook rejects hex). Invite links are `NotImplementedError` — no maintained implementation exists anywhere; use the Facebook app.

## Update checker & doctor

```ts
const client = new MessengerClient({
  update: { enabled: true }, // announce-only; checks at most once a day
});

const info = await client.update.check();
if (info) console.log(`update available: ${info.current} → ${info.latest}`);
// explicit, backed up, rolled back on failure; restart is yours:
// await client.update.install();
```

```bash
npx panindigan-automate doctor [--login]
```

Checks Node version, required cookies, storage writability, facebook.com and MQTT edge reachability — `--login` performs a real end-to-end login and logs out.

## Errors

All errors extend `LibraryError` with a stable `code`, a `retryable` flag, and non-secret `context`. See the full registry at [docs/error-codes.md](docs/error-codes.md).

```ts
client.on("error", (event) => {
  const err = event.error;
  if (err.code === "ACCOUNT_RESTRICTED") { /* guard halted — stop, don't retry */ }
  if (err.code === "AUTH_REFRESH_REQUIRED") { /* re-export cookies */ }
});
```

## Events

`message`, `message_reply`, `message_unsend`, `reaction`, `typing`, `presence`, `read`, `delivered`, `participant_join`, `participant_leave`, `admin_change`, `thread_update`, `poll`, `call`, `reconnect`, `disconnect`, `error`, `warning`, `debug`, `raw`, plus guard/E2EE additions: `suspension_warning`, `suspension_halt`, `suspension_reset`, `checkpoint`, `health_warning`, `health_critical`, `session_dead`, `risk_rising`, `e2ee_message`, `e2ee_message_edit`, `e2ee_message_reaction`.

## Migration from 0.1.6

Nothing breaks; new behavior is additive or opt-out:

- Stealth Guard is **on by default** — pace every send, or `stealth: { enabled: false }`.
- `THREAD_COLORS` are now theme ids; arbitrary hex throws `ValidationError`. Use `getThreadColorList()`.
- `changeGroupPhoto` unchanged; `changeGroupAvatar` is an alias.
- `muteThread()` accepts an optional duration (minutes or `"always"`).
- Session refresh is best-effort; `AUTH_REFRESH_REQUIRED` is terminal for the current login — re-export cookies.

## Documentation

- [Quick start](docs/quick-start.md)
- [API reference](docs/api-reference.md)
- [Authentication](docs/authentication.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Error codes](docs/error-codes.md)
- [Migration guide](docs/migration.md)
- [FAQ](docs/faq.md)

## Testing & contributing

```bash
pnpm install
pnpm run test
pnpm run typecheck
pnpm run build
```

Contributions welcome. Please run the suite and keep the build green; new endpoints need evidence against a live account or a note saying why you can't verify them — do not guess Facebook's wire format.

## License

MIT — see [LICENSE](LICENSE).
