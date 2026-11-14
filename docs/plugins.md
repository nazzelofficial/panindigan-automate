# Plugin Architecture

Panindigan Automate features a sandboxed plugin system that enables developers to package and reuse reusable bot capabilities, integrations, and event listeners.

---

## Plugin Interface

A plugin is an object implementing the `Plugin` contract:

```ts
import type { Plugin, PluginContext } from "panindigan-automate";

export interface Plugin {
  readonly name: string;
  readonly version: string;
  init(context: PluginContext): Promise<void> | void;
  destroy?(): Promise<void> | void;
}
```

---

## Sandboxed Context (`PluginContext`)

Each plugin receives an isolated `PluginContext` with dedicated resources:

| Resource | Description |
| :--- | :--- |
| `context.client` | The parent `MessengerClient` instance. |
| `context.logger` | A child logger namespaced to the plugin name (`[plugin:my-plugin]`). |
| `context.cache` | A namespaced cache adapter so key collisions with other plugins are impossible. |
| `context.storage` | A namespaced persistent storage adapter. |
| `context.on(event, handler)` | Registers event listeners that are **automatically unregistered** when the plugin is destroyed. |

---

## Writing a Plugin Example

Here is a self-contained Auto-Responder plugin:

```ts
import type { Plugin, PluginContext } from "panindigan-automate";

export function createAutoResponderPlugin(triggers: Record<string, string>): Plugin {
  return {
    name: "auto-responder",
    version: "1.0.0",

    async init(context: PluginContext) {
      context.logger.info("Initializing auto-responder plugin...");

      // Listen to incoming messages using context.on
      context.on("message", async (event) => {
        if (!event.body) return;

        const replyText = triggers[event.body.trim().toLowerCase()];
        if (replyText) {
          context.logger.info(`Auto-replying to trigger: "${event.body}"`);
          await context.client.sendMessage(event.threadId, {
            type: "text",
            body: replyText,
          });
        }
      });
    },

    async destroy() {
      // Clean up background timers or external database connections here
    },
  };
}
```

---

## Registering and Managing Plugins

### At Construction

```ts
import { MessengerClient } from "panindigan-automate";
import { createAutoResponderPlugin } from "./auto-responder.js";

const client = new MessengerClient({
  plugins: [
    { plugin: createAutoResponderPlugin({ "!help": "Available commands: !ping, !info" }) }
  ]
});
```

### Dynamically at Runtime

```ts
const plugin = createAutoResponderPlugin({ "!hello": "Hello there!" });

// Register and activate
await client.plugins.register(plugin);

// Disable or enable
await client.plugins.disable("auto-responder");
await client.plugins.enable("auto-responder");

// Unload and clean up listeners
await client.plugins.unregister("auto-responder");
```
