# Troubleshooting & Diagnostics

Common questions, error resolutions, and debugging techniques when running Panindigan Automate.

---

## Typed Error Hierarchy

Panindigan Automate throws specific, typed error classes. You can catch them using `instanceof`:

```ts
import {
  login,
  CookieError,
  AuthenticationError,
  NetworkError,
  APIError,
  ValidationError,
} from "panindigan-automate";

try {
  const client = await login("./appstate.json");
  void client;
} catch (error) {
  if (error instanceof CookieError) {
    console.error("Expired or missing cookies. Please re-export from your browser.");
  } else if (error instanceof AuthenticationError) {
    console.error("Facebook rejected credentials. Account may be checkpointed or logged out.");
  } else if (error instanceof NetworkError) {
    console.error("Connection failure or proxy unreachable:", error.message);
  }
}
```

---

## Common Issues & Solutions

### 1. `CookieError: Missing required cookie "c_user"` (or "xs" / "datr")
* **Cause**: Your exported JSON file is missing one of the essential session cookies, or the cookies have expired.
* **Fix**: Log in to Facebook in your normal browser, confirm your feed loads, and re-export the cookie jar. Ensure all three (`c_user`, `xs`, `datr`) are present.

### 2. `AuthenticationError: Facebook rejected the session — home.php returned the logged-out page`
* **Cause**: Facebook accepted your cookies at the HTTP layer but served the logged-out SSR splash screen (`MqttWebConfig` with `"fbid":"0"`). Your AppState no longer represents a logged-in session — expired, revoked, or the account was restricted (often after failed automation).
* **Fix**: Log in to Facebook in your browser with the same account, solve any checkpoint, then re-export `appstate.json`. If the account was restricted, you must appeal in a browser — no library can bypass that. The error context and log line include `mqttWebConfigEmpty=true` and friends, so you can tell this apart from a page-format change by reading them.

### 3. `AuthenticationError: Facebook returned no profile for ...`
* **Cause**: Facebook invalidated the session, or the account encountered an interactive security challenge (checkpoint/verification prompt).
* **Fix**: Open Facebook in your browser using the same IP / machine. Complete any security prompts, solve any required checkpoint, and export a fresh `appstate.json`.

### 4. MQTT Reconnection Loops / Drops
* **Cause**: High network latency, unstable local internet, or aggressive local firewall blocking WebSocket ports (`443`).
* **Fix**: 
  - Check the client's `warning` events for specific disconnection reasons:
    ```ts
    client.on("warning", (event) => console.warn(event.message));
    ```
  - If your hosting provider or ISP throttles WebSocket connections, route the client through a reliable residential or SOCKS5 proxy via the `httpProxy` option.

### 5. `AuthenticationError: Facebook rejected the session — Not logged in while calling "home" (status=200 …)` 
* **Cause**: Facebook's response was not a page at all — it was a tiny JSON error envelope (seen in production as `status=200 path=/home.php bytes=249`). Facebook serves this envelope when it considers the session unusable for HTML navigations. The `Accept` header this library sends (`text/html,…`) does not guarantee a real page in return — treat the envelope as authoritative.
* **Fix**: The error now tells you exactly what Facebook answered. Re-export your cookies from a browser where the account is confirmed logged in, switch to a non-restricted account if the current one was flagged, and redeploy. If Facebook still rejects the session on a confirmed-fresh export, the account itself is blocked — no library can bypass that; appeal to Meta, or run the bot from an account Facebook trusts.

### 6. `AuthenticationError: Facebook rejected the session — session is too stale to reuse (error 1357004)`
* **Cause**: Facebook answers `/home.php` with a tiny JSON error envelope (`{"error":1357004,…}`, seen in production as `status=200 bytes=249`) instead of serving the page. The client attempts an in-flight `fb_dtsg` rotation across several surfaces (mobile, touch, desktop) before giving up; when every surface answers with the same envelope or a logged-out page, the error is thrown. Note: `1357004` is Facebook's signal that this session may not be reused for home-page navigations — it is not something the library can rotate its way around.
* **Fix**:
  1. Open Facebook in your browser, confirm you can see your feed (do not rely on a browser tab that was left open for days — it may already be dead).
  2. Export fresh `appstate.json` (EditThisCookie / Cookie-Editor) from that live session and redeploy. Since 0.1.9, a fresh export always beats the stale persisted session (see `[0.1.9]` in CHANGELOG); on 0.1.8 and earlier the persisted jar silently masked fresh exports, which is why re-exporting "did nothing".
  3. If the error persists on a confirmed-fresh export from a residential connection, the account is restricted — check facebook.com for restriction notices; no library can bypass an account-level block. Appeal to Meta or use another account.
* **Why it keeps happening**: cookies age and `fb_dtsg` rotates frequently; a heavily automated account can be forced to re-export weekly. The library keeps `fb_dtsg`/`jazoest` rotated automatically, but only while the underlying cookies are accepted by Facebook.

### 7. `AuthenticationError: Facebook rejected the message edit`
* **Cause**: Trying to edit a message that:
  - Was sent by another user (you can only edit your own messages).
  - Was sent more than 15 minutes ago (Facebook's native edit window limit).

---

## Inspecting Runtime Diagnostics

You can inspect the client's live performance and connection telemetry at any time without external tools:

```ts
const snapshot = client.diagnostics.getSnapshot();

console.log("MQTT Latency (ms):", snapshot.mqtt.heartbeat.avgMs);
console.log("HTTP Requests Total:", snapshot.http.requests.total);
console.log("Cache Hit Rate:", snapshot.cache.hitRate);
console.log("Process Memory (MB):", Math.round(snapshot.process.heapUsed / 1024 / 1024));
```

---

## Enabling Verbose Debug Logs

If you encounter an unexpected behavior, set `logLevel: "debug"` or `"trace"`:

```ts
import { login } from "panindigan-automate";

const client = await login("./appstate.json", {
  logLevel: "debug",
  prettyPrint: false, // machine-parsed JSON (colorized output is the default)
});
```
This logs detailed request payloads, topic subscriptions, and MQTT sequence IDs while masking secret tokens and raw cookie values.
