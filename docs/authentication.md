# Authentication & Session Management

Panindigan Automate connects to Facebook using valid browser session tokens rather than email and password credentials. This approach avoids automated bot checkpoints, 2FA bypass hurdles, and CAPTCHAs while maintaining maximum reliability.

---

## Supported Credential Formats

The `client.login()` method automatically detects six different input formats without requiring flags or configuration:

### 1. AppState Array (Standard JSON export)
The standard output produced by browser cookie exporter extensions:
```ts
const appState = [
  { key: "c_user", value: "1000123456789", domain: ".facebook.com", path: "/" },
  { key: "xs", value: "2%3Aabc123xyz...", domain: ".facebook.com", path: "/" },
  { key: "datr", value: "xyz_abc...", domain: "facebook.com", path: "/" }
];
await client.login(appState);
```

### 2. JSON File Path
Direct path to a `.json` file containing any supported cookie format:
```ts
await client.login("./appstate.json");
```

### 3. Environment Variable Name
Points to an environment variable containing JSON cookies:
```ts
// Reads from process.env.FB_APPSTATE
await client.login("FB_APPSTATE");
```

### 4. AppState Object Format
A dictionary keyed by cookie name:
```ts
const appStateObj = {
  c_user: { value: "1000123456789" },
  xs: { value: "2%3Aabc123xyz..." },
  datr: { value: "xyz_abc..." }
};
await client.login(appStateObj);
```

### 5. Simple Cookie Entry Array
A plain array with `name` and `value` fields:
```ts
const cookies = [
  { name: "c_user", value: "1000123456789" },
  { name: "xs", value: "2%3Aabc123xyz..." },
  { name: "datr", value: "xyz_abc..." }
];
await client.login(cookies);
```

### 6. Raw Cookie Header String
The verbatim `Cookie` header string copied from a browser request:
```ts
await client.login("c_user=1000123456789; xs=2%3Aabc123xyz...; datr=xyz_abc...");
```

---

## Required Cookies

Before making any outbound HTTP or WebSocket request, the client strictly validates that the following three core cookies are present and unexpired:

1. **`c_user`**: The authenticated Facebook User ID (numeric string).
2. **`xs`**: The primary session token with its cryptographic signature.
3. **`datr`**: The browser identification token bound to the session.

If any of these cookies are absent or expired, the client will immediately throw a `CookieError` to fail fast and prevent suspicious network activity.

---

## Automatic Cookie Refresh

Facebook session tokens (`xs` and `datr`) periodically rotate or approach expiration. 

When `persistSession: true` is configured (the default):
1. The client monitors the expiration timestamps of your cookies.
2. When a cookie approaches its expiration deadline, a background task requests a refreshed cookie set from Facebook's web endpoints.
3. The updated cookie jar is atomically saved to your persistent storage adapter (`./panindigan-session`).
4. **Benefit**: You do not need to manually re-export browser cookies every week. The session stays alive indefinitely as long as you do not explicitly log out from the browser.

---

## Session Persistence Across Restarts

```ts
const client = new MessengerClient({
  persistSession: true,
  storageDirectory: "./panindigan-session",
});
```

When session persistence is active:
- After the first login, the full session state (validated cookies, latest MQTT sequence IDs, and `syncToken`) is saved locally in `./panindigan-session/`.
- On subsequent startups, `client.login("./appstate.json")` restores the cursor, sync token, and region from storage, so the realtime connection can be created immediately; the home page is still loaded to rotate `fb_dtsg`/`lsd` tokens.
- The `LoginResult` reflects whether the state was restored:
  ```ts
  const { userId, restored } = await client.login("./appstate.json");
  console.log(`Restored existing session: ${restored}`);
  ```

---

## Two-Factor Authentication (2FA)

If your Facebook account has 2FA enabled (recommended):
1. Log in to Facebook normally in your browser.
2. Complete the 2FA verification (SMS or Authenticator App).
3. Check the "Remember this browser" option.
4. Export the resulting cookies.

Because the exported cookies already contain the cryptographic proof of completed 2FA, Panindigan Automate connects directly without prompting for additional codes.
