# Middleware Pipeline

Panindigan Automate features an extensible middleware engine inspired by Koa and Express. It allows you to intercept, modify, validate, or log requests and events before and after execution.

---

## Stages

The middleware pipeline supports three execution stages:

1. **`before`**: Runs before the primary operation executes. Can modify the context or short-circuit execution.
2. **`after`**: Runs after a successful operation. Can inspect or transform the resulting output.
3. **`error`**: Runs when an operation throws an exception. Can log, alert, or perform error recovery.

---

## Registering Middleware

Use `client.use(stage, handler, options?)`:

```ts
import { MessengerClient } from "panindigan-automate";

const client = new MessengerClient();

// 1. Global logging middleware (runs before every client action)
client.use("before", async (context, next) => {
  const start = Date.now();
  console.log(`[middleware] Starting operation: ${context.operation}`);
  
  await next(); // Hand control to the next handler
  
  const elapsed = Date.now() - start;
  console.log(`[middleware] Completed ${context.operation} in ${elapsed}ms`);
});

// 2. Operation-scoped middleware (only runs for sendMessage)
client.use("before", async (context, next) => {
  const content = context.args[1];
  
  // Example: Block sending messages that contain profanity or disallowed words
  if (content.type === "text" && content.body.includes("BLOCKED_KEYWORD")) {
    throw new Error("Message rejected by content moderation middleware.");
  }
  
  await next();
}, { operation: "sendMessage" });

// 3. Error-handling middleware
client.use("error", async (context, next) => {
  console.error(`[middleware] Failed operation ${context.operation}:`, context.error);
  await next();
});
```

---

## Context Object (`MiddlewareContext`)

The `context` object provided to handlers contains:

| Property | Type | Description |
| :--- | :--- | :--- |
| `operation` | `string` | The name of the client method (e.g. `"sendMessage"`, `"createPoll"`, `"changeGroupTheme"`). |
| `args` | `any[]` | Array of arguments passed to the method. |
| `client` | `MessengerClient` | Reference to the client instance. |
| `state` | `Record<string, unknown>` | A mutable dictionary shared across handlers for the current execution. |
| `result?` | `any` | The return value of the operation (available in `after` stage). |
| `error?` | `Error` | The thrown error (available in `error` stage). |

---

## Short-Circuiting

If a `before` middleware handler does not call `await next()`, the pipeline halts, and the underlying operation is **not executed**:

```ts
client.use("before", async (context, next) => {
  if (isRateLimited()) {
    console.warn("Rate limited; skipping message send.");
    return; // Will not call next(), operation is aborted
  }
  await next();
});
```

---

## Handler Execution Order

1. Handlers run in the order they were registered.
2. Handlers with explicit `priority` options execute ahead of standard handlers:
   ```ts
   client.use("before", authCheckHandler, { priority: 100 });
   ```
3. Global middleware runs before operation-scoped middleware.
