/**
 * `login()` — the compatibility entry point (fca-style call shape).
 *
 * This gives the classic pattern everyone knows from facebook-chat-api:
 *
 * ```js
 * const login = require("panindigan-automate");
 * login(appState, (err, client) => {
 *   if (err) { ... }
 *   client.on("message", ...);
 * });
 * ```
 *
 * …and the modern promise pattern:
 *
 * ```ts
 * import { login } from "panindigan-automate";
 * const client = await login("./appstate.json");
 * ```
 *
 * Both module systems get both styles: `require()` returns this same function
 * (with every named export attached), and `import login from ...` /
 * `import { login } from ...` both resolve to it in ESM.
 *
 * Deliberately **not** a drop-in clone of the old fca `api` object —
 * `sendMessage` here is promise-based and typed, events are typed, and there
 * is no global callback API. Migrating an fca-era bot means a thin local
 * wrapper for the exact methods it calls (see the migration guide), not a
 * giant pretend-compatible surface that lies about what this library can do.
 *
 * For full control use `new MessengerClient(options)` and `client.login(...)`,
 * which this function is a thin convenience over.
 */
import { MessengerClient } from "./client/index.js";
import type { ClientOptions, Credentials } from "./types/index.js";

/** fca-style callback: receives the error (or `null`) and the logged-in client. */
export type LoginCallback = (error: Error | null, client?: MessengerClient) => void;

export function login(credentials: Credentials): Promise<MessengerClient>;
export function login(
  credentials: Credentials,
  options: ClientOptions,
): Promise<MessengerClient>;
export function login(
  credentials: Credentials,
  callback: LoginCallback,
): void;
export function login(
  credentials: Credentials,
  options: ClientOptions,
  callback: LoginCallback,
): void;
export function login(
  credentials: Credentials,
  options?: ClientOptions | LoginCallback,
  callback?: LoginCallback,
): Promise<MessengerClient> | void {
  const cb = typeof options === "function" ? options : callback;
  const clientOptions = typeof options === "function" ? undefined : options;

  const client = new MessengerClient(clientOptions);
  const attempt = client.login(credentials);

  if (cb !== undefined) {
    attempt.then(
      () => cb(null, client),
      (error: unknown) => cb(error instanceof Error ? error : new Error(String(error))),
    );
    return undefined;
  }
  return attempt.then(() => client);
}
