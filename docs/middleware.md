# Middleware Pipeline

Middleware hooks into every HTTP-backed operation — before the request is sent, after the response lands, or on failure. Plugins can register scoped hooks too; user hooks and plugin hooks run in a deterministic order around the operation.

---

## Stages

1. **`before`**: Runs before the request is sent. Can modify headers or short-circuit the operation by not calling `next()`.
2. **`after`**: Runs after a successful response. Can inspect the status, headers, and body.
3. **`error`**: Runs when the operation throws. Can log or inspect the `LibraryError`.

---

## Registering Middleware

```ts
import { MessengerClient } from "panindigan-automate";

const client = new MessengerClient();

// Global before hook.
client.use("before", async (context, next) => {
  const start = Date.now();
  await next();
  console.log(`${context.operation} took ${Date.now() - start}ms`);
});

// Operation-scoped before hook.
client.use(
  "before",
  async (context, next) => {
    context.request.headers.set("X-Request-Source", "my-bot");
    await next();
  },
  { operations: ["sendMessage"] },
);

// Error hook.
client.use("error", (context, next) => {
  console.error(context.error);
  return next();
});
```

- `options.operations` restricts the hook to the named operations; omit it to run for every operation.
- `options.name` labels the registration in debug output.

---

## Context Object (`MiddlewareContext`)

| Property | Type | Description |
| :--- | :--- | :--- |
| `operation` | `string` | Operation name, e.g. `"sendMessage"`, `"getThreadList"`. |
| `request` | `{ url, method, headers }` | The request about to be sent. `headers` is a mutable `HeadersView`. |
| `response` | `{ status, headers, body } \| null` | Populated in and after the `after` phase. |
| `error` | `LibraryError \| null` | Populated in the `error` phase. |
| `metadata` | `Record<string, unknown>` | Free-form per-operation metadata. |

`HeadersView` exposes `get`, `set`, `has`, `delete`, `toJSON`, and `snapshot`.

---

## Short-Circuiting

A `before` hook that does not call `next()` cancels the operation. The transport rejects the request with a `TransportError`:

```ts
client.use("before", async (context, next) => {
  if (isRateLimited()) {
    return; // operation is aborted
  }
  await next();
});
```

---

## Execution Order

For a single operation:

1. Global `before` hooks (registration order)
2. Plugin `before` hooks
3. User `before` hooks
4. The operation
5. User `after` hooks
6. Plugin `after` hooks
7. Global `after` hooks

`error` hooks run in reverse order when the operation throws.
