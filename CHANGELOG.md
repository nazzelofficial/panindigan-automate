-# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [0.2.6] - 2026-11-19

Patch release: MQTT connection diagnostics, cookie export compatibility, and logging improvements.

### Fixed

- Fixed an unhandled rejection when the realtime connection timed out. `login()` now observes `mqtt.connect()` and the ready promise together, so timeout errors are always handled and include the last MQTT dial diagnostic.
- Colorized logging (`prettyPrint: true`) now works without `pino-pretty` installed, and correctly fans out to all configured destinations (`logFile`, transports).
- Cookie diagnostics now distinguish expired cookies from rejected ones. The expired `dbln` in the deployment export is reported accurately, not blamed on cookie prefixes.
- Mobile cookie exports are now fully supported: `sameSite: "No restriction"` and Puppeteer-style `expirationDate` values are parsed correctly instead of being silently dropped.
- Removed vague `unknown` values from log fields; diagnostics report the actual path or `unattributed` where no operation is attached.

### Added

- Structured MQTT dial diagnostics (`MqttDialDiagnostic`, exported): `stage`, `region`, `attempt`, `connectionId`, `elapsedMs`, `upgradeStatus`, `wsCloseCode`, `socketErrorCode`, `mqttReturnCode`, and sanitized handshake headers. All fields come from observed events; unavailable values are `null`. The `login` timeout embeds the last diagnostic.
- Exported helpers: `formatMqttDiagnostic()`, `sanitizeMqttDiagnosticText()`, `isValidMqttWsUrl()`.
- Regression tests for MQTT diagnostics and cookie export compatibility (251 tests, 18 files).

### Changed

- The MQTT WebSocket handshake no longer sends a `Sec-WebSocket-Protocol` header, matching the maintained FCA reference. The MQIsdp/3 CONNECT packet is unchanged. This is a best-effort change, not a confirmed fix for the live rejection.
- WebSocket URLs are validated before connecting; per-region failures are logged with full diagnostics and do not stop the region sweep.

### Notes

- Facebook-side rejections (1357004, redirect limit, realtime timeout) cannot be fixed in client code. Re-export cookies from a browser that is actively logged in; if a fresh export still fails, the account is restricted.
- If all regions still fail, include the new `stage=...`, `upgradeStatus=...`, `wsCloseCode=...`, `mqttReturnCode=...` fields from the deployment log in a bug report.

## [0.2.5] - 2026-11-19

Stability patch on top of the published 0.2.4. Fixes an `httpProxy` validation crash (empty string / whitespace) and tightens logout cleanup. **Whether this was the cause of the Render deployment failures is not established here** - -  no deployment log showing this validation error was available for inspection.

### Fixed

- **`httpProxy: ""` no longer crashes the client with `ValidationError: Invalid option "httpProxy": httpProxy must be an http://, https://, or socks5:// URL`.** Root cause: an empty or whitespace-only value passed the `.nullish()` gate but failed the `isProxyUrl("")` refinement. The schema now normalizes empty/whitespace values to `null` before the proxy-URL check runs. Valid, malformed and unsupported-scheme proxy values remain validated as before.
- **`logout()` now stops the update checker's interval timer.** Previously calling `logout()` left the `UpdateChecker`'s `setInterval` running, which kept the Node process alive and fired registry checks against a logged-out client.
- **`logout()` now clears the debounced session-persist timer.** A `#persistSoon()` call in-flight during logout could fire after the session was cleared, producing a stale or errored persist write.

### Tests

- Added `tests/config-proxy.test.ts`: **19 regression tests** covering every `httpProxy` path - -  `undefined`, `null`, `""`, `"   "`, valid `http://`/`https://`/`socks5://` URLs, URLs with embedded credentials, whitespace-padded URLs, malformed URLs, unsupported schemes (`ftp://`, `file://`), environment variable overrides, and programmatic overrides of env vars. The exact production failure (`httpProxy: ""`) is pinned as a named test case.

### Notes

- **A previous draft of these notes claimed 3 `proxy-agent` test failures with `EACCES` on `127.0.0.1` were "sandbox-specific".** That was not reproducible here: the full suite passes 229/229 in this environment. The real change was that the four proxy *integration* tests (HTTP CONNECT tunneling, surplus-byte handoff, CONNECT rejection, relay timeout) were **removed** from `tests/proxy-agent.test.ts`; the proxy-agent module now has only unit tests. That is a genuine coverage loss in the proxy path - -  not a passing test suite explained away as sandbox noise. If proxy tunneling matters for the deployment, those integration tests should be restored in an environment that permits localhost sockets.
- Latest verification in this tree: TypeScript clean, 229/229 tests pass, build produces ESM + CJS + declarations.

## [0.2.4] - 2026-11-18

Patch release on top of the published 0.2.3. Targets the `MQTT connection closed before CONNACK` failures seen in deployments, plus setup latency. **The Facebook-side cause is not confirmed from this environment; live verification against the user's account is still required.**

### Fixed

- **MQTT WebSocket sub-protocol no longer uses mqtt.js's `mqttv3.1` default.** Verified from the installed `mqtt` package source: with `protocolId: "MQIsdp"` and `protocolVersion: 3`, mqtt.js v5 sends `mqttv3.1` in `Sec-WebSocket-Protocol`. Facebook's edge-chat broker is assumed to accept the standard `mqtt` sub-protocol; whether this is the actual reason for the pre-CONNACK closes has **not** been verified against live Facebook. The transport supplies a `createWebsocket` callback forcing `["mqtt"]` while leaving the `MQIsdp`/3 CONNECT packet untouched. If the deployment still fails with the same error after this release, the assumption was wrong and the override should be revisited.
- **Excessive connection jitter removed from the initial dial.** The obfuscation layer added 0--5000 ms of random delay *before each dial attempt*, meaning 8 region candidates could burn up to 40 s in pure jitter before the first real connection was attempted. Jitter is now applied only on reconnects (0--500 ms), not on the initial connection.
- **Subscription stagger delays removed from post-CONNACK setup.** Topic subscriptions were issued asynchronously with 10--50 ms delays between each of the 19 topics - -  the total latency (up to ~1 s) ate into the 5 s TMS watchdog and risked missing the first `/t_ms`. Subscriptions are now issued synchronously (no inter-subscription delays); topic order is still randomized.
- **Presence publish delays removed from post-CONNACK setup.** Two obfuscation delays (100--300 ms each) were inserted between the foreground-state and client-settings publishes during setup, further delaying the sync queue and making the TMS watchdog more likely to fire. These delays are now skipped during initial setup; obfuscation delays remain active during runtime `setChatOn()` calls.

### Changed

- **`import { connect } from "mqtt"` replaced with a default import** (`const connect = mqtt.connect`). mqtt v5's browser ESM build exports only `default`, so bundlers (Bundlephobia, webpack, esbuild browser targets) failed with `ESModulesLinkingError: export 'connect' was not found in 'mqtt'`. The default export carries `.connect` in both Node and browser builds; Node behavior is unchanged (verified in consumer smoke tests).
- `MQTT_CONNECT_TIMEOUT_MS` raised from 5 s to 10 s, matching the actively-maintained FCA reference's CONNECT timeout.

### Tests

- Added `tests/mqtt-ws-subprotocol.test.ts`: a regression guard documenting the intended sub-protocol override. These tests simulate mqtt.js's documented branch and our override; they do **not** exercise a real WebSocket against Facebook. Treat them as intent documentation, not proof that the broker accepts the header.
- `tests/update.test.ts`: the "checks the registry on client construction" test timeout raised to 15 s to prevent flaky failures on slow CI; the "makes no network call when disabled" test rewritten to use `UpdateChecker` directly instead of `MessengerClient` to avoid ES module caching interference between tests.

### Notes

- The MQTT fix is a client-side protocol-negotiation correction. If the account is suspended, flagged, or the IP is blocked by Facebook, the connection will still fail - -  but with a proper error from the server instead of the silent pre-CONNACK close. Fresh cookies from an actively logged-in browser remain necessary.
- The obfuscation layer is still active for runtime operations (publish spacing, presence jitter, topic order randomization). Only the initial-setup delays were removed because they interfered with the connection lifecycle.

## [0.2.3] - 2026-11-18

Patch release on top of the published 0.2.2. MQTT region extraction robustness fixes and visibility into why Facebook refuses the socket.

### Fixed

- **Region extraction no longer returns `null` just because the boot payload format drifted.** In addition to the three historical patterns (`irisSeqID`, JSON `app_id`/`endpoint`/`iris_seq_id`, `MqttWebConfig`-quoted), extraction now also scans the first 8 KB after the `MqttWebConfig` marker for a `region` key, for an `endpoint` carrying `?region=`, and tolerates key re-ordering, whitespace and JS-escaped slashes - -  key shapes seen on the 2026 home page. The deployment had `region: null` because its 4.3 MB boot page carried the config but did not match any of the rigid historical patterns; better to parse what is actually served.
- **Per-region MQTT dial failures are now warned at info level with the underlying error**, instead of hidden at `debug`. The previous deployment produced "could not connect to any MQTT region: MQTT connection closed before CONNACK" with no reason visible because per-region reasons logged at debug and the default level was info. Each attempt now logs its name and its failure reason.
- **Client construction now initializes the automatic update checker.** Previously the checker was created only when `client.update` was accessed - -  the Messenger userbot never reads `client.update`, so no registry check or install ever ran. The checker is now constructed and started inside the constructor; `client.update` returns the same initialized instance. (`update.enabled: false` still fully disables it and the registry is never touched.)

### Risks worth knowing before the next redeploy

- **Automatic installs by default.** With `update.enabled: true` (the default) and `autoInstall: true` (the default since 0.2.0), every client construction starts the updater - -  restart of the bot will also run `pnpm add panindigan-automate@latest` inside the container. The installed version takes effect only on the next process restart; Render's ephemeral container makes the in-memory process untouched until the container itself redeploys. The log lines ("Update installed successfully - -  restart required") tell you when it happened.
- **If the Render container lacks `pnpm` on `PATH`, auto-install fails silently atwarn level** ("Package manager pnpm not available") and nothing is installed. The check still happens, so you will know what the latest published version is - -  just not that you will get it until you redeploy with a fresh lockfile. Pin `update: { enabled: false }` if you prefer to control dependency versions entirely through the bot's lockfile.
- **The updater never restarts your process.** If the bot is running, it stays on the old code until you restart/redeploy it yourself.

### Notes

- **This does not un-block a session whose socket is silently dropped by Facebook.** If every region attempts fails with the same pre-CONNACK close, the deciding party is the account/session/device/IP combination - -  not this library's dial logic. The new log lines will make the per-region cause explicit; if they all show the same silent close, the session is being dropped at the transport layer, and re-exporting cookies or appealing the account restriction is the only path.

## [0.2.2] - 2026-11-18

Patch release on top of the published 0.2.1. Fixes a false-positive login rejection triggered by substring matching against the whole app shell.

### Fixed

- **Login no longer aborts with "Facebook requires a security checkpoint" on ordinary logged-in pages.** The `hasCheckpoint` diagnostic matched `/checkpoint|two_step_verification/i` anywhere in the response body. Every Facebook app-shell page carries the substring "checkpoint" in its inlined JavaScript, so `hasCheckpoint=true` fired on normal logged-in pages (seen in production: `status=200 path=/ bytes=4295078 fbDtsg=true lsd=true checkpoint=true` - -  an app shell serving a valid boot payload, stopped before the session could even be tried). `hasCheckpoint` is now computed from the URL path only (`/checkpoint` or `/two_step_verification`).
- The `isLoginPage` gate no longer treats a body substring as evidence of a checkpoint interstitial; a checkpoint path or a literal login-form marker is required instead. A session flagged for review is caught by Facebook's own API signals - -  `/chat/user_info/` structured errors and the MQTT checkpoint signals enforced by the Stealth Guard's A9 realtime checkpoint guard - -  not by a substring guess.

### Notes

- **This does not un-restrict a flagged account.** If Facebook serves the app shell (200, path=/, valid tokens) and then rejects at the API layer, that verdict arrives through the API - -  not through page content. If a confirmed-fresh export still fails, the account is restricted; appeal or use another account.
- The deployment that produced the "security checkpoint" error above was running 0.2.0 (`node_modules/.pnpm/panindigan-automate@0.2.0/`).

### Tests

- `tests/scrape-tokens.test.ts`: the local diagnose shim now computes `hasCheckpoint` from the URL, matching production semantics.

## [0.2.1] - 2026-11-18

Patch release on top of the published 0.2.0. Cookie-load diagnostics: the "cookies silently rejected" warning now says exactly which cookie was skipped, instead of a nameless count.

### Fixed

- **CookieStore.setCookies() now names the silently rejected cookies.** Previously the warning reported only `N of M cookies were silently rejected by tough-cookie`, which gave no way to tell which cookie was skipped - -  the deployment could not be diagnosed from the log alone. The warning now lists the exact names (e.g. `__Host-FGP-...`) and explains that `__Secure-`/`__Host-` cookies need Secure (+ `Path=/` and no `Domain` for `__Host-`) attributes in the export, and that the required `c_user`/`xs`/`datr` are not implicated (they passed validation).
- **Fixed a miscount in the same detection.** Cookies scoped to `messenger.com` were counted as "rejected" even though they landed in the jar on the messenger domain; rejection is now detected per-cookie by name against the jar for that cookie's own URL.

### Tests

- Regression test: `CookieStore.fromCookies` names the rejected cookie when a `__Host-` export carries a `Domain` attribute (which is invalid for that prefix and causes silent rejection).

### Notes

- The silent rejection is tough-cookie's documented RFC 6265 prefix-security behavior (`__Secure-` requires `Secure`; `__Host-` additionally requires `Path=/` and no `Domain` attribute), not a new restriction.
- **The login `Redirect limit (5) exceeded` failure is not caused by this warning.** It is Facebook's server-side rejection of the session - -  the 0.1.8 line answered that rejection with a 249-byte `1357004` envelope; 0.2.0's root-page GET gets a redirect chain instead. The rejected cookie in that log was never load-bearing (validation requires and passes `c_user`/`xs`/`datr`). Re-export cookies from an actively logged-in browser; if a confirmed-fresh export fails the same way, the account is restricted and no code will fix it.

## [0.2.0] - 2026-11-18

### Changed

- **Login scrape is a single desktop root-page GET** (the same shape the actively maintained FCA login helpers use). The desktop-home - → mobile-home - → mobile-root multi-endpoint loop and the proactive pre-scrape token rotation were removed; `#refreshCookies` performs the in-flight recovery when Facebook presently rejects the session.
- **Transport headers lean browser-navigation-shaped** (`text/html` accept first, `upgrade-insecure-requests`, Chrome client hints). Removed the jQuery-style `x-requested-with: XMLHttpRequest` header.
- **The "Accept header is decisive" theory was removed.** Production logs show the deployment received the 1357004 envelope while already sending `Accept: text/html,...` - -  the header does not decide; the session does. Comments claiming unverified external verification were removed as well.

### Added

- **Anti-Detection helpers** (`AntiDetectionManager`, `generateHardwareDeviceId`, `generateUserAgent`, and related exports at the package root) - -  **enabled by default** since 0.2.0 (opt out with `stealth: { antiDetection: false }`). Contains randomized pre-send timing, subscription staggering on connect, and a fingerprint API (`getAntiDetectionFingerprint()` / `getHardwareDeviceId()` - -  a hash of the machine's CPU/MAC/hostname, used nowhere on the wire). Unverified: claims such as "indistinguishable from human behavior" are not measurable and are not to be taken as a guarantee. The Stealth Guard still stops the bot at checkpoints; nothing here bypasses them.
- **MQTT timing helpers** (`MqttObfuscationManager`) - -  internal subscription-order staggering, presence-pattern jitter, connect jitter, publish spacing. Enabled by default in the MQTT transport; randomized timing only, with no claim of a measured anti-detection effect.
- **Automatic updates, on by default (opt-out).** The automatic update system is here, gated by explicit opt-out. With no `update` options, clients check the npm registry on startup and every 24 hours, and install a newer published version automatically (with backup and rollback on failure; a process restart is required - -  the bot is not restarted for you). Announce-only mode: `update: { autoInstall: false }`. Fully disabled: `update: { enabled: false }`. The full surface is exposed: `initialize()` / `checkForUpdates()` / `installUpdate()` / `getStatus()` / `getHistory()` / `getLatestVersion()` / `stop()`, package-manager detection (lockfile-based), `releaseChannel` dist-tag support, and install with backup + rollback + restart-required. The announce-only 0.1.9 API (`check()`, `install()`, `isOlder`) is preserved. Client-level helpers `getUpdateStatus()`, `checkForUpdates()`, `installUpdate()`, `getUpdateHistory()` are restored as well.
- **`useConsoleLogger` client option.** Setting `useConsoleLogger: true` on `ClientOptions` (or `PANINDIGAN_USE_CONSOLE_LOGGER=1`) swaps the internal logger for the built-in colorized console logger end-to-end - -  every component stops writing JSON to stdout. `createRootLogger` is now exported at the package root (the README already showed this import, but the export did not exist). The console logger gained level gates (`silent|fatal|error|warn|info|success|debug|verbose|trace`), a working `child({ module: "..." })` with suffixed names, and `success` at level 35 between info and warn.

## Migration notes for 0.1.9 - → 0.2.0

- Existing `update.check()` / `update.install()` behavior is unchanged.
- **Default behavior changed**: clients now check on startup and every 24h, and install automatically. To restore 0.1.9 announce-only behavior: `update: { autoInstall: false }`. To disable entirely: `update: { enabled: false }`.
- `update.enabled: true` alone keeps the auto-check + auto-install behavior; it is no longer required as a master switch for anything (the default is already enabled).

### Fixed

- **26 TypeScript errors from the 0.2.0 development cycle** across `src/client/index.ts`, `src/transport/mqtt/index.ts`, and `src/update/index.ts` - -  including a duplicated connect block in the MQTT transport that shadowed the real implementation, a `UpdateChecker` wiring mismatch, and a dropped `isOlder` export on the `update` module (restored).
- **The interim updater was re-assessed rather than kept as-shipped.** The automatic updater that briefly replaced the published announce-only checker was rewritten around explicit opt-ins (see Added): nothing auto-installs without `update.autoInstall: true`, publish workflows are not broken by a silent self-upgrade, and the 0.1.9 `isOlder` export is preserved.
- **The MQTT duplicated connect block was removed** (a paste artifact that broke compilation).

### Removed

- The jQuery-style `x-requested-with: XMLHttpRequest` header.

### Notes

- **1357004 is server-side session rejection.** No header, no token rotation, and no client logic can revive it. Re-export fresh cookies from a browser that is actively logged in - -  on a confirmed-fresh export that still fails, the account is restricted.
- **Anti-detection claims are unmeasured.** Nothing in this release has been verified against live Facebook; offline fixtures and source review only. The Stealth Guard's job is to stop the bot when risk signals appear - -  not to evade detection or checkpoints. Use an account you can afford to lose.
- The `StealthConfig.antiDetection` doc comment now matches the actual default (`true`, updated since the initial draft of these notes).
- **README was restored to the published 0.1.9 content** (the interim marketing rewrite was removed), with an added honest section on the Anti-Detection helpers and their actual (unmeasured, timing-only) effect.
- **Automatic updates are enabled by default.** Every constructed client checks the registry on startup and every 24h, and installs newer published versions automatically (backup + rollback; restart required). Announce-only mode with `autoInstall: false`, or fully off with `enabled: false`. Be aware: an install requires a process restart to take effect, and a misconfigured registry or a compromised published version would propagate to all consumers - -  pin `update: { enabled: false }` if you need determinism.

## [0.1.9] - 2026-11-17

Patch release. Consolidates the session/login code and fixes a false-positive token refresh introduced in 0.1.8.

### Fixed

- **Session module consolidated - -  one implementation to audit.** The helpers in `src/client/home.ts` (home-page diagnostics, session-token extraction) were moved into `src/client/index.ts` and `src/client/home.ts` was deleted. Login/session code now lives in one file.
- **`#refreshSessionTokens` no longer reports a false success.** Previously a surface counted as refreshed when the page contained any bare `"token": "<20+ chars>"` string - -  an unanchored pattern that matched unrelated values anywhere in the page, so a deployment logged "Refreshed fb_dtsg/jazoest" and then threw `AUTH_REFRESH_REQUIRED` seconds later. Now a surface only counts when: (1) Facebook's structured error envelope is absent, (2) the page is not the logged-out splash screen, (3) the final URL is not a login/checkpoint redirect, and (4) a DTSG-anchored `fb_dtsg` is actually found (same strict patterns as the main scrape path). `jazoest` is always derived from `fb_dtsg`, matching the web client.
- **The bare-`"token"` and bootloader-`A/Q` extraction patterns were removed.** Kept: hidden `fb_dtsg` inputs, `DTSGInitialData`/`DTSGInitData` requireLazy payloads (relaxed scan within that key's neighbourhood), `async_get_token`, and `fb_dtsg`-keyed JavaScript assignments.
- **The mobile user-agent override was removed** from the refresh path - -  acceptance is decided by the returned page, not by the UA string.
- **Login tests pass again.** One regression test was failing (a 6-character `abc123` fixture against the 10-character minimum). Fixtures were corrected and new regression tests pin down the false-positive class: a bare token-shaped value without DTSG context yields no token; the exact production `1357004` envelope yields no token and maps to `AUTH_REFRESH_REQUIRED`.
- **A fresh appstate export is no longer silently ignored by a stale persisted session.** `prepareLogin()` preferred the persisted jar whenever it matched the account and passed date-based validation - -  which is blind to server-side revocation (1357004). Deployments logged in with a dead persisted jar forever no matter how often the appstate was re-exported. Now the persisted jar wins only when it matches the supplied credentials on the required cookies (pure background refresh), or when the supplied file is older than the last persist; otherwise the supplied credentials (fresh export, environment variable, or programmatic input) win. The choice is logged as `cookieSource: credentials|storage`.

### Notes

- **This release does not and cannot revive a `1357004`-revoked session.** Facebook answered the deployment's `/home.php` with its "session too stale" error envelope on every surface; on 1357004 the account must be re-exported from a browser that is actively logged in. There is no client-side rotation that fixes that - -  see `docs/troubleshooting.md`.
- Validated against offline fixtures. Live behavior against Facebook has not been verified by the maintainers.

## [0.1.8] - 2026-11-17

### Added

- **Console logger** - -  opt-in, colorized terminal output (sections, badges, icons, connection/message indicators, metric lines) via `createRootLogger({ useConsoleLogger: true })`. Same `logger.*` call-site contract. Console mode writes to stdout only; `logFile` and `prettyPrint` are ignored in that mode and secret redaction does **not** apply there - -  use the default pino logger (with redaction) when logs ship off-box.
- **`createRootLogger`** now accepts `useConsoleLogger?: boolean`.

### Fixed

- **Session refresh (`#refreshSessionTokens`) now tries every Facebook surface.** When `1357004` occurs, the client attempts `m.facebook.com`, `www.facebook.com`, and `touch.facebook.com` in order, and succeeds on the first surface that yields a usable `fb_dtsg`/`jazoest` pair (previously only `m.facebook.com` was tried).
- **Token extraction tolerates modern Facebook markup.** `extractMobileTokens()` now handles: classic hidden `<input name="fb_dtsg">` fields, single-quoted attribute variants, `DTSGInitialData` JSON payloads (modern SPA-rendered pages), relaxed `token:` assignments inside `requireLazy` payloads, and direct `fb_dtsg:` assignments - -  plus the matching `jazoest` patterns with a computed fallback (`jazoest` is derived from a sum of the `fb_dtsg` character codes) when no `jazoest` field is present. **Note: the bare-`token` patterns above were too broad and are removed in 0.1.9 - -  see `[0.1.9]`.**
- **Clear diagnostics when the session is genuinely dead.** If no surface yields tokens, the error now states `"no valid fb_dtsg/jazoest found on any surface (mobile, desktop, touch) - session is dead"` instead of the ambiguous `"mobile surface yielded no tokens"`. Each surface attempt is logged with its name (`mobile`/`desktop`/`touch`) so the failing surface can be identified.
- Session refresh returns success on the first working surface - -  no more wasted requests after one succeeds.

### Notes

- Live recovery rate has not been measured; the multi-surface path is a best-effort improvement, not a guarantee. If all three surfaces fail to yield tokens, the cookies are genuinely revoked and must be re-exported from a fresh browser session.

### Changed

- `docs/PROFESSIONAL-LOGGER.md` (which documented a non-existent `createProfessionalLogger` export) was replaced by `docs/console-logger.md`; `examples/professional-logger-demo.ts` (same problem) was replaced by `examples/console-logger-demo.mjs`.
- Version: `0.1.7` - → `0.1.8`.

## [0.1.7] - 2026-11-17

### Security

- Checkpoint signals are never retried - -  the guard freezes on first critical checkpoint signal.
- No secret ever reaches diagnostics, the guard audit log, or the error registry - -  only severities, codes, and non-secret context.
- E2EE device keys and session state persist in the device store with owner-only permissions - -  keep this file secure. The E2EE code is a port of bhhoang/fbapi-unofficial (MIT); no separate crypto library is bundled. XEdDSA-signed prekeys and X25519 sessions are verified by the offline tests, but the protocol path against live Facebook is unverified - -  treat it as experimental.

### Added

- **Compatibility `login()` entry point** - -  the main documented entry: `import { login } from "panindigan-automate"` in ESM and `const { login } = require("panindigan-automate")` in CommonJS. Also exported as the default (and `require("panindigan-automate")` is callable fca-style). Promise and callback signatures both work, with the same `ClientOptions` object as `new MessengerClient(options)`; `new MessengerClient()` remains fully supported for explicit construction and the `ready` event. This is a thin convenience over `MessengerClient#login` - -  new code should prefer `login()` or the constructor. README, quick-start, migration guide, api-reference and the bundled examples now lead with `import { login }`.
- **Stealth Guard** (`client.stealth`): outbound account protection, all wired into every mutating method in the client (send, edit, unsend, forward, reactions, group mutations, polls, mute/archive/delete).
  - **Suspension signal detector** (A1): restriction codes and messages across HTTP responses, GraphQL errors, MQTT control-plane payloads, and raw text - -  checkpoint/identity verification (`1357001`, `1357004`, `392024945`, 202, 459, ...), spam/abuse flags, rate limits (`429`, `1675035`), messaging restrictions (`2061011`, `1545012`, `1545014`, `368`), session death (`190`, `102`, `460`, `463`, `467`). Severity ladder `warn < pause < halt < critical`. Text patterns are only matched on the control plane - -  chat content never can halt the bot.
  - **Circuit breaker** (A2): `signalThreshold` halting signals inside `signalWindow` - → open circuit; all proactive sends reject with `AccountRestrictedError` (code `ACCOUNT_RESTRICTED`); emits `suspension_halt`; manual `client.stealth.reset()` after the cooldown (default 24h). Resumes on nothing automatically - -  a halt after `critical` stays halted until you reset.
  - **Sliding-window caps** (A4): hard hourly/daily counters - -  defaults 30 messages per thread per hour, 100/hour and 200/day globally. Crossing 80% doubles pacing (warning); 100% halts proactive sends until the window resets; the per-thread cap is bounded and tracked per target.
  - **Token buckets + in-flight bound** (A3): per-operation buckets (`sendMessage` / `addReaction` / `createGroup` / `global` with burst + sustained refill) and a max of 5 in-flight calls per operation+target, counted before completion.
  - **Warmup mode** (A5): fresh sessions ramp from 30% of cap to 100% over `warmupDays` (default 7), persisted across restarts.
  - **Natural pacing** (A6): randomized inter-operation delay (`basePacingMs` -× jitter) unless `pacingEnabled: false`; doubled under cap warnings.
  - **Checkpoint realtime guard** (A9): checkpoint-class signals force the circuit open immediately (`forceHalt`) and emit `checkpoint`; retries against checkpoints never happen.
  - **State persistence**: circuit state, signal history, warmup progress, caps, and warmup day survive restarts.
  - **Guard audit log** (G8): ring buffer of the last 200 guard decisions (allow/deny/halt/cap/reset/...) with reasons - -  exported via diagnostics, never leaves the process policy by itself.
- **Session health score** (G1): `health_warning` / `health_critical` events; score shown in `diagnostics` and in the guard callbacks.
- **Risk forecast** (G2): hour-over-hour send-volume acceleration emits `risk_rising` before any restriction signal fires.
- **Guard diagnostics export** (F3): `client.diagnostics.exportJSON()` / `exportHTML()` - -  self-contained report (HTTP latency percentiles, MQTT queue, guard counters, audit log) attached to incidents; no upload.
- **Error code registry** (F5): `docs/error-codes.md` - -  every `error.code` with meaning and the action to take.
- **Idempotent send** (G5): every send computes a client-side idempotency key; retries of an identical send return the cached message id instead of posting a duplicate (24h TTL, persisted).
- **Adaptive chunking** (G3): text bodies over 2000 chars split at sentence/paragraph/line/word boundaries with reading-time inter-chunk delays; mentions disable chunking; disabled with `chunking.enabled: false`.
- **Thread heat index** (G4): local, own-traffic-only per-thread activity ranking exposed in `diagnostics` (`stealth.threads.tracked`, `stealth.threads.hottest`). No message content involved.
- **Dry-run mode** (G6): `dryRun: true` - -  every outbound operation logs the payload it would send; nothing touches the network; results are clearly synthetic.
- **E2EE (End-to-End Encryption) - -  experimental, 1:1 only.** A faithful TypeScript **port** of [bhhoang/fbapi-unofficial](https://github.com/bhhoang/fbapi-unofficial)'s `src/e2ee/` (MIT), with attribution in each ported file. Not a from-scratch reimplementation.
  - **Signal Protocol** - -  X3DH key agreement with XEdDSA-signed prekeys, Double Ratchet style ratcheting
  - **Noise XX handshake** - -  WebSocket transport over `wss://web-chat-e2ee.facebook.com/ws/chat` with AES-256-GCM frames
  - **WA Binary Protocol** - -  stanza codec (tokens, dictionaries, JIDs, packed strings, zlib-aware unmarshal)
  - **Send and receive encrypted 1:1 text** - -  `sendEncryptedMessage()`, events `e2ee_message`, `e2ee_message_edit`, `e2ee_message_reaction` (unsends surface as `message_unsend`)
  - **Device persistence** - -  identity and prekeys persist at `<storageDirectory>/e2ee_device.json` (atomic writes, owner-only)
  - **Deliberately not in this release** - -  group E2EE (sender keys), E2EE attachments, encrypted backup restore. Group threads throw `NotImplementedError`; there is no fallback that silently sends plaintext.
  - **Honest status:** offline tests (WA/protobuf codec, RFC 5869 HKDF, XEdDSA, full X3DH round trip between two device stores, Noise XX client handshake vs an in-memory reference server) pass. **Live behavior against real Facebook has not been verified by the authors.** Connecting registers an E2EE device on the account; use a throwaway account first and expect breakage if Facebook changes the protocol.
- **Safe update checker** (B): announce-only by default (disabled until `update.enabled: true`); checks the registry at most once per `checkIntervalMs` (default 24h); `client.update.check()` reports; `client.update.install()` is an explicit call - -  prints a plan, backs up the installed package, installs, rolls back on failure; restart is yours. `panindigan-automate doctor` (`bin`) checks Node, cookies, storage writability, facebook.com reachability and MQTT edge reachability; `--login` optionally performs a real end-to-end login.
- **Group tools** (E): `getThreadColorList()` - -  the verifiable registry of theme ids (hex is rejected by Facebook since ~2019); `changeGroupTheme` accepts a registry name or raw numeric theme id; `changeGroupAvatar` alias; `muteThread(duration?: number | "always")` validates minutes (1--525600) or `"always"`.
- **Examples**: `examples/` - -  echo bot, dry-run demo, group manager, warmup-aware broadcast, E2EE demo.
- **CI**: `.github/workflows/ci.yml` - -  typecheck, tests, pack smoke check.
- Public API surface: `StealthGuard`, `SuspensionDetector`, guard primitives, `E2EEClient` and the `e2ee/` modules, `GuardAuditLog`, `UpdateChecker`, `isOlder`.

### Removed

- The experimental `e2ee.bridge: "fb-messenger-e2ee"` bridge and `FMEMessengerBridge` were **removed**. The E2EE surface is a port of bhhoang/fbapi-unofficial's `src/e2ee/` (MIT, included in this package's source); there is no longer any option to delegate to an external AGPL client from inside this package, and no `@noble/curves` - -  the ported code uses Node's built-in crypto (X25519, Ed25519-family verification via XEdDSA). `E2EE_BRIDGE_NOT_INSTALLED` is kept as a compatibility-only code but is not raised.

### Fixed

- **Structured constructor options were rejected at validation time.** `splitOptions` passed every non-scalar key (`dryRun`, `stealth`, `e2ee`, `update`, ...) into the strict scalar Zod schema, so documented options like `{ dryRun: true }`, `{ stealth: { enabled: false } }`, `{ e2ee: "auto" }` and `{ update: { enabled: true } }` threw `ValidationError: Unrecognized key` at construction. They are now routed around the scalar validator (typo detection for the scalar keys is retained) - -  regression coverage added in `tests/login.test.ts`.
- **1357004 ("session needs refresh") recovery - -  actually shipped this time.** An intermediate working state had replaced the recovery with a stub that unconditionally returned failure; that claim was disproven by the maintained references. The client refreshes `fb_dtsg`/`jazoest` from the mobile surface with `withDefaults: false` (so the stale tokens are not sent back) and retries `home.php` once. If that also fails, the cookies are revoked beyond recovery: login fails with `AUTH_REFRESH_REQUIRED` (`retryable: false`) and a re-export instruction, and the guard freezes outbound sends.
- 1357004 maps to `AUTH_REFRESH_REQUIRED` at the interpreter (an intermediate work state had folded it into `AUTH_SESSION_EXPIRED` without the recovery attempt).
- **THREAD_COLORS were non-functional** - -  they carried hex strings, but Facebook's theme mutation takes theme ids; the set is now the verified theme-id registry. Arbitrary hex can no longer be passed silently.
- Invite links (`createInviteLink` / `joinGroupByLink`): throw `NotImplementedError` - -  no maintained client implements them and no publicly verifiable endpoint exists. The previous silent-hex acceptance was a footgun; this fails loud instead.
- Poll question caching documented: `poll` events populate `#pollQuestions`; `getPoll()` reads the cached question when Facebook omits it, else falls back to `""`. Behavior covered by `normalizePoll` tests.
- `client.stealth.getWarmupMultiplier()` no longer persists on every read (only on day change), matching the documented behavior.

### Notes

- 0.1.7 is the next sequential release after 0.1.6; nothing between 0.1.6 and 0.1.7 was published.
- The docs and `examples/` now lead with `import { login } from "panindigan-automate"` (or `const { login } = require(...)`); `new MessengerClient(...)` remains documented for explicit construction and the `ready` event.
- Stealth Guard reduces account restriction risk; it cannot make an automated personal account "safe" - -  Facebook's systems change without notice. Re-export cookies periodically and reset the guard manually after checkpoints.

## [0.1.6] - 2026-11-15

### Added

- Automatic recovery from Facebook's error `1357004` ("session needs refresh"), the exact envelope observed in production (`status=200, bytes=249, {"error":1357004}`). The login and cookie-refresh flows now detect this envelope, refresh `fb_dtsg`/`jazoest` from the server-rendered mobile surface (`m.facebook.com/`, hidden-input scrape - -  the same rotation web/mobile clients perform), and retry `home.php` once. When the refresh yields nothing or the retry still returns `1357004`, login fails with `AUTH_REFRESH_REQUIRED` (retryable only at the HTTP layer) and the session is torn down - -  never silently retried or bypassed.
- New error code `AUTH_REFRESH_REQUIRED` in `ErrorCode` and `interpretFacebookError` maps `1357004` to it (previously surfaced as the generic `API_ERROR`).
- `extractMobileTokens()` in `src/client/home.ts` - -  scrapes `fb_dtsg`/`jazoest` hidden inputs from the mobile surface; derives `jazoest` via `computeJazoest` when the page omits it. `safeHomeDiagnostics` unchanged (no values logged, ever).
- Regression tests for the `1357004` mapping (including the exact production envelope and the anti-hijacking `for (;;);` prefix) and for `extractMobileTokens`; suite passes at 124 tests.

### Fixed

- **Critical:** `#refreshSessionTokens()` now correctly passes `withDefaults: false` when fetching from `m.facebook.com/`. Previously, the mobile token refresh request incorrectly attempted to include `fb_dtsg`/`jazoest` (the very tokens being refreshed), causing the request to fail with missing or stale tokens. The mobile surface only requires basic authentication cookies (`c_user`, `xs`, `datr`), not CSRF tokens. This fix ensures error `1357004` recovery works as designed - -  matching how browser clients handle stale sessions.
- `home.php` scrapes (login and cookie refresh) send a browser-like `Accept: text/html,...` header, so Facebook answers with the HTML shell instead of the JSON error envelope on newer stacks - -  while the JSON-envelope interpreter remains as a precise detector when it happens anyway.

## [0.1.5] - 2026-11-15

### Fixed

- **The exact production failure observed in the logs** (`status=200 path=/home.php bytes=249`): Facebook's unauthenticated response to `www.facebook.com/home.php` is a tiny JSON error envelope, not a page. Home-page scrapes now send a browser-like `Accept: text/html,...` header so Facebook serves the real page, and the client detects a JSON error envelope via `parseFacebookJson` + `interpretFacebookError` - -  surfacing the actual Facebook error (e.g. `Not logged in`) instead of the ambiguous "Could not read Facebook's session tokens from the home page".
- Login and cookie refresh now throw the *real* Facebook error verbatim (code, retryable flag, and message such as `Not logged in`), with the page diagnostic summary appended - -  no more dead-end authentication errors for this class of response. The same safe diagnostics (`status`, `path`, `bytes`, booleans) appear in the context and in the message itself so they show at any log level, not just `debug`/`trace`.
- The `Accept` header now distinguishes HTML navigations (`text/html,...`) from API requests, matching what a browser sends - -  a prerequisite for Facebook serving the HTML shell instead of the JSON envelope.
- Regression tests for the error-envelope detection (`tests/home.test.ts`); suite passes at 118 tests.

## [0.1.4] - 2026-11-15

### Added

- A dedicated, value-free home-page diagnostics module (`src/client/home.ts`). It reports `status`, the URL path only, body length, and booleans - -  `mqttWebConfigEmpty`, `fbDtsgPresent`, `lsdPresent`, `hasLoginForm`, `hasCheckpoint` - -  with zero cookies, tokens, or HTML.
- `login()` and the background cookie refresh now log these diagnostics at `warn` level (visible at default `info` log levels) and include them in the thrown `AuthenticationError` context and in the error message itself, so production logs show exactly what Facebook served without a code change.
- Explicit detection of Facebook's logged-out SSR splash screen: `MqttWebConfig` carrying `"fbid":"0"` now raises `AuthenticationError` with an actionable message ("re-export your cookies from a browser that is actually logged in") instead of the ambiguous "Could not read Facebook's session tokens from the home page".
- Regression tests (`tests/home.test.ts`) with fixtures trimmed from live Facebook pages (November 2026): the logged-out splash, an authenticated boot payload, a checkpoint page, and an empty page.

### Fixed

- Facebook session rejection now classifies precisely: a logged-out splash screen (`fbid:"0"`), a login redirect, or a checkpoint page each produce a distinct, safe error - -  including whether the session was never accepted vs. an expired/challenged one - -  and all of them funnel to the same session-expiry teardown. Checkpoints are never bypassed.
- The background cookie refresh applies the same logged-out/login/checkpoint detection and logs warn-level diagnostics, instead of failing silently behind `debug`-level logging.

## [0.1.3] - 2026-11-15

### Added

- `tests/scrape-tokens.test.ts` - -  regression tests with hand-crafted, sanitized fixtures (no real Facebook HTML or credentials): modern requireLazy SPA boot payloads, older `DTSGInitData` variants, relaxed scans, server-rendered hidden inputs, the `async_get_token` variant, special characters in token values, and failure pages (login page, checkpoint, empty/unknown). The suite covers both the `fb_dtsg` and `lsd` extractors and the login page detection.
- `tests/cookie-store.test.ts` - -  regression tests for the AppState - → HTTP jar pipeline: `CookieStore.fromCookies` accepts browser-exported AppState cookies, `requireAuthenticated()` passes, and the jar emits a `Cookie` header for `www.facebook.com` for `c_user`/`xs`/`datr`/`presence`.
- `scripts/` patch helpers are now ESM (`.mjs`) instead of CommonJS.

### Fixed

- **Facebook authentication failure** - -  `AuthenticationError: Could not read Facebook's session tokens from the home page`:
  - `scrapeTokens` extracts `fb_dtsg` with multiple patterns instead of one pair of legacy regexes: modern requireLazy `DTSGInitialData`, older `DTSGInitData`, a relaxed scan within 160 characters, server-rendered hidden inputs, and `async_get_token`.
  - `lsd` is extracted the same multi-pattern way: requireLazy `["LSD",[],{"token":"..."}]`, a relaxed scan, and server-rendered hidden inputs.
  - `#scrapeTokens` and `#refreshCookies` now classify the response: login redirects (`/login`, `id="loginform"`) raise `AUTH_SESSION_EXPIRED`; checkpoint pages (`/checkpoint`, `two_step_verification`) are detected by URL and body markers and route through the same expiry teardown - -  checkpoints are never bypassed.
  - Token-scrape failures log and throw with non-sensitive diagnostics only (`fbDtsgFound`, `lsdFound`, `hasLoginForm`, `hasCheckpoint`, `bodyLength`) - -  never cookie values, token values, or raw HTML.
  - Successful token scraping now logs a debug line with the detected region/sequence-id presence.
- **AppState cookies were silently dropped by tough-cookie 6**: browser AppState exports carry `domain: ".facebook.com"` (with a leading dot), which tough-cookie 6 rejects without an error. `FB_COOKIE_DOMAIN` is now the canonical `facebook.com`, and `toToughCookie()` strips leading dots before constructing the `Cookie`. Freshly exported AppState is now actually applied to requests instead of failing at the required-cookie check or silently missing from the `Cookie` header.
- The previous behavior could present itself as a Facebook login redirect with an "Invalid session token" or a "Could not read session tokens" failure; with the extraction and cookie-jar fixes, a healthy exported session is applied end to end.

## [0.1.2] - 2026-11-14

### Added

- The full `MessengerClient` API (`src/client`) is implemented end to end - -  no stubs:
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
- `tests/client.test.ts` - -  30 tests covering client construction, session state, middleware, event listener registration, credential validation, thread/message/poll/search normalization, GraphQL batch extraction, media metadata, input validation, and the group-versus-1:1 message/log form builders.
- The root client exposes the typed event API directly: `client.on`, `client.once`, `client.off`, `client.removeAll`, and `client.listenerCount`. `on`/`once` return an unsubscribe function.

### Changed

- `getThreadList` paginates with the `before` timestamp cursor, drops the boundary duplicate, and derives `hasMore`/`cursor` from `page_info` or the last node's `updated_time_precise`.
- Attachment normalization accepts a top-level GraphQL `__typename` (`MessageImage`, `MessageVideo`, ...) in addition to `blob_attachment` wrappers, so history and forced-fetch nodes normalize correctly.
- `getPresence` serves the in-memory presence cache populated by `/orca_presence` and returns `unknown` when the user has never been observed; there is no verified HTTP presence endpoint.
- `getMediaInfo` reads the client's uploaded-media registry (memory plus cache); unknown ids throw `APIError` with code `MEDIA_NOT_FOUND`.
- `markAsDelivered` reads the cached message- →thread map (populated by `message`/`delivered` events and `getMessages`).
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
  - `zod` 4, `pino` 10, `vitest` 5, `@types/node` 26, `undici` 8, `tough-cookie` 6 - -  all tests pass and both module systems load and run.

## [0.1.1] - 2026-11-12

### Added

- The MQTT-over-WebSocket transport (`src/transport/mqtt`) is now implemented in full, matching the wire behavior of actively maintained Messenger clients:
  - One dial = one region sweep. The preferred region is tried first (seeded from configuration and made sticky after a success), then the fallback regions; a regionless candidate leads when no region is known, and a custom `mqttEndpoint` collapses the sweep to that single host.
  - Jittered exponential backoff between sweeps - -  `min(reconnectDelayMax, 1000 · 2^(n-1)) · (0.5 + random)` - -  with `reconnectAttempts` bounding the total, and a dedicated rejection plus `onReconnectExhausted` when the budget runs out.
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
- Surplus bytes that a proxy appends after the CONNECT response head are now handed to the TLS layer synchronously via `socket.unshift()` immediately after `tls.connect()`. Node's TLSSocket constructor runs `initRead` on `process.nextTick` and drains the wrapped socket's readable buffer into the TLS parser; re-emitting the bytes later on `setImmediate` (the `socks` client's approach) is too late on modern Node - -  the wrap bypasses the raw stream's data events and the bytes are silently dropped. Bytes glued to the CONNECT head now fail the handshake fast instead of being discarded.
- Integration-test infrastructure: the in-process self-signed certificate generator now embeds Node's DER ECDSA signature with the required zero unused-bits prefix (Node's `sign()` already returns DER for EC keys), the fake CONNECT proxy relays raw TCP like a real proxy instead of double-encrypting, and socket cleanup tracks connections manually because Node 26 removed `server.closeAllConnections()`.

## [0.1.0] - 2026-11-10

First public release.

### Added

- `MessengerClient` - -  the public entry point, covering messaging (send, reply, edit, unsend, forward), reactions, attachments, threads, groups, users, polls, presence, search, and media operations. No stubs; every method is implemented.
- Authentication from six credential input formats - -  AppState array, AppState object, JSON file path, environment variable name, cookie array, and raw cookie header string - -  with automatic detection, normalization into an RFC 6265-compliant jar, and round-trip serialization for all six.
- Login-time cookie validation: `c_user`, `xs`, and `datr` must be present and unexpired, otherwise a `CookieError` is thrown before any network request is made.
- Session management as an explicit state machine (`UNINITIALIZED` - → `AUTHENTICATING` - → `ACTIVE` - → `RECONNECTING` - → `CLOSING` - → `CLOSED`), with jittered exponential-backoff reconnection, automatic cookie refresh as `xs`/`datr` approach expiry, and graceful shutdown that drains in-flight requests before disconnecting.
- MQTT-over-WebSocket transport: keepalive heartbeats with round-trip measurement, dead-connection detection after three missed PINGRESPs, automatic topic re-subscription, and a FIFO outgoing packet queue (500 packets by default) that drains in order on reconnect.
- HTTP transport on undici with connection pooling, per-request timeouts, redirect limits, gzip/brotli decompression, streaming downloads, multipart uploads, retries with jittered backoff on network errors and 429/5xx responses, and HTTP/SOCKS5 proxy support.
- Delta processing into typed events for messages, replies, reactions, unsend, read and delivery receipts, presence, typing, participant join/leave, admin changes, thread updates, polls, calls, and attachments. Every payload is validated before dispatch; unknown delta types are logged and re-emitted as `raw` events rather than thrown.
- Typed event emitter with a full registry - -  `message`, `message_reply`, `message_unsend`, `reaction`, `typing`, `presence`, `read`, `delivered`, `participant_join`, `participant_leave`, `admin_change`, `thread_update`, `poll`, `call`, `ready`, `login`, `logout`, `reconnect`, `disconnect`, `error`, `warning`, `debug`, and `raw`. Payloads are discriminated unions.
- Middleware pipeline: `before`, `after`, and `error` hooks, global or scoped to named operations, executed in a deterministic order with short-circuit support.
- Plugin system with a sandboxed context (child logger, namespaced cache and storage, auto-removed event listeners) and a complete lifecycle - -  load, enable, disable, reload, destroy.
- LRU cache with per-entity TTLs (threads, users, messages, attachment URLs) behind the `CacheAdapter` interface, including tag-based invalidation and a `fetch` cache-aside helper.
- Storage subsystem with in-memory and file adapters; file writes are atomic (temp file, then rename).
- Structured logging through pino - -  JSON to stdout by default, child loggers per module, optional pretty printing in development, and pluggable transports.
- Diagnostics: HTTP request counts, latency percentiles, and retry counts; MQTT heartbeat round-trip, reconnect count, and queue depth; cache hits, misses, and hit rate; per-event emission counts and throughput; process memory and uptime. Exposed through `client.diagnostics.getSnapshot()`.
- A typed error hierarchy rooted at `LibraryError` - -  `AuthenticationError`, `SessionError`, `CookieError`, `TransportError`, `NetworkError`, `TimeoutError`, `ValidationError`, `PermissionError`, `APIError`, `MQTTError`, and `PluginError` - -  each with a machine-readable `code`, a `retryable` flag, and secret-free `context`.
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
- No email/password login - -  cookie-based authentication only.
- No wildcard event listeners; listeners must name an exact event.
- Facebook's private endpoints change without notice. Parser fixes ship as patches; public API changes ship as minor releases until 1.0.
