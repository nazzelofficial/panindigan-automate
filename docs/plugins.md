# Plugin Architecture

Panindigan Automate plugins run in a sandboxed context: a child logger, namespaced cache and storage scopes, scoped middleware, and event listeners that are removed automatically when the plugin is disabled or destroyed.

---

## Plugin Interface

```ts
import type { Plugin, PluginContext } from "panindigan-automate";

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
```

All lifecycle hooks except `name`/`version` are optional:

| Hook | Called when |
| :--- | :--- |
| `onLoad(context)` | The plugin is registered. |
| `onEnable()` | The plugin becomes active (default at construction). |
| `onDisable()` | The plugin is disabled. |
| `onReload()` | The plugin is reloaded. |
| `onDestroy()` | The plugin is destroyed permanently. |

Registering a plugin name twice throws `PluginError`.

---

## Sandboxed Context (`PluginContext`)

| Resource | Description |
| :--- | :--- |
| `context.name` | The plugin's name. |
| `context.logger` | Child logger tagged with the plugin name. |
| `context.cache` | Namespaced `CacheAdapter` (async `get`/`set`). |
| `context.storage` | Namespaced `StorageAdapter`. |
| `context.on(event, listener)` | Registers a typed event listener; removed with the plugin. |
| `context.use(phase, hook, options?)` | Registers middleware scoped to the plugin. |

The plugin never sees the cookie jar, the transports, or another plugin's state.

---

## Registering Plugins

Plugins are registered at construction:

```ts
import { MessengerClient } from "panindigan-automate";
import { messageCounter } from "./message-counter.js";

const client = new MessengerClient({
  plugins: [
    { plugin: messageCounter },
    // Disable a plugin initially:
    { plugin: anotherPlugin, options: { enabled: false } },
  ],
});
```

The client awaits plugin `onLoad`/`onEnable` before `login()` resolves, so listeners and middleware are active before the first event.

---

## Example: Auto-Responder

```ts
import type { MessengerClient, Plugin } from "panindigan-automate";

export function createAutoResponder(getClient: () => MessengerClient): Plugin {
  return {
    name: "auto-responder",
    version: "1.0.0",

    async onLoad(context) {
      context.on("message", async (event) => {
        if (!event.body || event.isSelf) return;
        if (event.body.trim().toLowerCase() === "!ping") {
          await getClient().sendMessage(event.threadId, {
            type: "text",
            body: "Pong!",
          });
        }
      });
    },
  };
}

const client = new MessengerClient({
  plugins: [{ plugin: createAutoResponder(() => client) }],
});
```

The plugin context also exposes `context.use(phase, hook, options?)` for middleware scoped to the plugin; see [Middleware](middleware.md) for the hook signature.
