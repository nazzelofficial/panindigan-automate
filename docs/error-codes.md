# Error code registry

Every error thrown by `panindigan-automate` extends `LibraryError` and carries a
stable, machine-readable `code`. Branch on `code` (or `instanceof`), never on
`message` — messages are for humans and may change between releases.

`LibraryError` also carries `retryable: boolean` (a hint for automatic retry
logic) and `context` (non-secret, non-identifying structured details).

```ts
import { LibraryError } from "panindigan-automate";

client.on("error", (event) => {
  const err = event.error;
  if (err.code === "ACCOUNT_RESTRICTED") {
    // Guard halted the bot — stop, do not retry.
  }
  if (err.retryable) {
    // Safe to retry with backoff.
  }
});
```

## Authentication

| Code | Meaning | What to do |
| --- | --- | --- |
| `AUTH_INVALID_CREDENTIALS` | Login was refused at the earliest checkpoint. | Re-export cookies from a browser where you are logged in. |
| `AUTH_SESSION_EXPIRED` | Facebook rejected the session (logged-out splash, login redirect, or checkpoint). | Re-export cookies from a browser that is actually logged in; solve any checkpoint there first. |
| `AUTH_LOGIN_REJECTED` | Facebook answered "Not logged in" (error `1357001`) or the home page carried no tokens. | Confirm the account is logged in at facebook.com; checkpoint or restriction may be involved. |
| `AUTH_REFRESH_REQUIRED` | Session too stale (`1357004`); the client already attempted a mobile-surface token rotation and it was not enough. | Re-export fresh cookies. The account may also be restricted — check facebook.com in a browser. |

## Cookies

| Code | Meaning | What to do |
| --- | --- | --- |
| `COOKIE_MISSING` | A required cookie (`c_user`, `xs`, `datr`) is absent. | Make sure your export contains all three; re-export. |
| `COOKIE_EXPIRED` | A required cookie is past its expiry by the local clock. | Re-export cookies. |
| `COOKIE_MALFORMED` | Cookie input could not be normalized into a jar. | Check the input format; all six formats are documented in `docs/authentication.md`. |

## Session

| Code | Meaning | What to do |
| --- | --- | --- |
| `SESSION_NOT_AUTHENTICATED` | Operation requires an active session. | Call `login()` first. |
| `SESSION_INVALID_STATE` | Operation not allowed in the current session state. | Wait for `ready` or `reconnect`; don't call during login/logout. |
| `SESSION_CORRUPT` | Persisted session state is unusable. | Clear `./panindigan-session` and log in again. |

## Transport & network

| Code | Meaning | What to do |
| --- | --- | --- |
| `NETWORK_ERROR` | DNS/TCP/TLS failure. | Check connectivity/proxy; retryable. |
| `TIMEOUT` | Request exceeded the configured timeout. | Increase `httpTimeout`, or retry with backoff. |
| `TRANSPORT_ERROR` | Generic HTTP transport failure. | Inspect `context.operation`; usually retryable with backoff. |
| `API_RATE_LIMIT` | Facebook rate-limited the request (HTTP 429 / retry-after). | Back off; the Stealth Guard pacing limits most of these. |
| `API_ERROR` | Facebook rejected an operation with a structured error. | Read `context.operation` and `context.code`; see Facebook docs. |

## Permissions

| Code | Meaning | What to do |
| --- | --- | --- |
| `PERMISSION_DENIED` | Operation requires a different role or context. | Group-only actions need group threads; some actions need admin. |
| `PERMISSION_NOT_ADMIN` | Action requires thread admin (`changeAdminStatus`). | Ask an admin; the bot cannot promote itself. |
| `PERMISSION_NOT_PARTICIPANT` | Bot is not a participant in that thread. | Add the account to the thread. |
| `PERMISSION_BLOCKED` | Facebook blocked the action outright (usually policy). | Check the account for restrictions at facebook.com. |

## Media & attachments

| Code | Meaning | What to do |
| --- | --- | --- |
| `MEDIA_NOT_FOUND` | No uploaded media metadata for that id. | Upload first; check `getMediaInfo`. |
| `ATTACHMENT_URL_UNAVAILABLE` | Could not resolve the attachment URL. | Check the attachment id and retry. |

## MQTT

| Code | Meaning | What to do |
| --- | --- | --- |
| `MQTT_CONNECTION_FAILED` | Could not connect to the realtime endpoint. | Check proxy/firewall; the client retries with backoff. |
| `MQTT_PROTOCOL_ERROR` | Unexpected MQTT protocol behavior. | File an issue with the redacted log snippet. |
| `MQTT_QUEUE_OVERFLOW` | Offline outbound queue exceeded its bound. | Reduce send burst; check connectivity. |
| `MQTT_NOT_CONNECTED` | Operation needs the realtime channel; it is down. | Wait for `ready`/`reconnect`; client reconnects automatically. |

## Account protection (Stealth Guard)

| Code | Meaning | What to do |
| --- | --- | --- |
| `ACCOUNT_RESTRICTED` | The guard halted outbound work: too many restriction signals or an hourly/daily cap is full. | **Do not bypass.** Wait for the cooldown (default 24h), then `client.stealth.reset()`; also re-check the account at facebook.com. |

## Capability gaps

| Code | Meaning | What to do |
| --- | --- | --- |
| `NOT_IMPLEMENTED` | The capability does not exist and cannot be faked. Currently: `createInviteLink`, `joinGroupByLink`, and E2EE outside this release's scope — group chats (sender keys) and E2EE attachments. 1:1 E2EE text is implemented (port of fbapi-unofficial, MIT) but **live-unverified**; failing live handshakes surface as connection errors, not silent plaintext. | Use the Facebook app for those actions; for E2EE use 1:1 threads only. |

## Plugins

| Code | Meaning | What to do |
| --- | --- | --- |
| `PLUGIN_LOAD_FAILED` | A plugin failed to load or register. | Check the plugin's own logs; construction fails fast. |
| `PLUGIN_LIFECYCLE_FAILED` | Plugin `enable`/`disable`/`destroy` threw. | Check the plugin's hooks; call `plugins.disable` or remove it. |
