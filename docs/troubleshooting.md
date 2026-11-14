# Troubleshooting & Diagnostics

Common questions, error resolutions, and debugging techniques when running Panindigan Automate.

---

## Typed Error Hierarchy

Panindigan Automate throws specific, typed error classes. You can catch them using `instanceof`:

```ts
import { 
  CookieError, 
  AuthenticationError, 
  NetworkError, 
  APIError, 
  ValidationError 
} from "panindigan-automate";

try {
  await client.login("./appstate.json");
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

### 2. `AuthenticationError: Facebook returned no profile for ...`
* **Cause**: Facebook invalidated the session, or the account encountered an interactive security challenge (checkpoint/verification prompt).
* **Fix**: Open Facebook in your browser using the same IP / machine. Complete any security prompts, solve any required checkpoint, and export a fresh `appstate.json`.

### 3. MQTT Reconnection Loops / Drops
* **Cause**: High network latency, unstable local internet, or aggressive local firewall blocking WebSocket ports (`443`).
* **Fix**: 
  - Check the client's `warning` events for specific disconnection reasons:
    ```ts
    client.on("warning", (event) => console.warn(event.message));
    ```
  - If your hosting provider or ISP throttles WebSocket connections, route the client through a reliable residential or SOCKS5 proxy via the `httpProxy` option.

### 4. `APIError: Facebook rejected the message edit`
* **Cause**: Trying to edit a message that:
  - Was sent by another user (you can only edit your own messages).
  - Was sent more than 15 minutes ago (Facebook's native edit window limit).

---

## Inspecting Runtime Diagnostics

You can inspect the client's live performance and connection telemetry at any time without external tools:

```ts
const snapshot = client.diagnostics.getSnapshot();

console.log("MQTT Latency (ms):", snapshot.mqtt.heartbeat.avgMs);
console.log("HTTP Requests Total:", snapshot.http.requestsTotal);
console.log("Cache Hit Rate:", snapshot.cache.hitRate);
console.log("Process Memory (MB):", Math.round(snapshot.process.memoryUsage.heapUsed / 1024 / 1024));
```

---

## Enabling Verbose Debug Logs

If you encounter an unexpected behavior, set `logLevel: "debug"` or `"trace"`:

```ts
const client = new MessengerClient({
  logLevel: "debug",
  prettyPrint: true, // Needs pino-pretty installed
});
```
This logs detailed request payloads, topic subscriptions, and MQTT sequence IDs while masking secret tokens and raw cookie values.
