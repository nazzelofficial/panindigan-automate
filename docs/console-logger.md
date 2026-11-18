# Console Logger

An opt-in, colorized terminal logger is built into this package. It swaps the default pino JSON logger for a sectioned console output (rich colors, box drawing, icons, connection/message indicators) with the same call-site contract (`logger.info`/`warn`/`error`/`debug`).

## Enabling it (as a client option)

```ts
import { MessengerClient } from "panindigan-automate";

const client = new MessengerClient({ useConsoleLogger: true });
```

Every component inside the library (session, transport, stealth, sync, update, …) then logs through this logger with its own `module:event` prefix instead of raw JSON.

## Enabling it (with a custom logger)

`createRootLogger` is exported at the package root for callers building their own logger tree (e.g. multiple module-scoped loggers, or a bespoke top-level sink):

```ts
import { createRootLogger } from "panindigan-automate";

const logger = createRootLogger({
  level: "info",
  prettyPrint: false,     // ignored when console mode is on
  logFile: null,          // ignored when console mode is on
  transports: [],
  useConsoleLogger: true,
});

logger.startupBanner("0.2.4");
logger.features([
  { name: "HTTP Transport", status: "enabled" },
  { name: "MQTT Realtime", status: "enabled" },
]);

logger.connected("Facebook", 1234);
logger.messageIn("Alice", "hi", false);
logger.metric("Response time", 145, "ms");
```

## Behavior

- Writes to **stdout only** (the pino file path and pretty transports are ignored in console mode).
- Level gates: `silent|fatal|error|warn|info|success|debug|verbose|trace`. `success` sits between `info` and `warn` (value 35).
- `child({ module: "mqtt" })` returns a child with the module suffixed into the displayed name (e.g. `panindigan-automate:mqtt`).
- Secrets are NOT passed through a redaction pipeline in console mode — avoid logging credential-bearing objects. Use the default pino logger (which redacts `cookies`, `appState`, `fb_dtsg`, `token`, …) when the process output may be shipped to an aggregator.

## When to use which

| Situation | Recommendation |
| --- | --- |
| Interactive terminal / dev host | `useConsoleLogger: true` on the client |
| Production with logs shipped off-box | default (pino JSON, redacted) |
| Bots writing local log files | default (pino JSON, redacted) |
| Demos / examples | console logger |

See `examples/console-logger-demo.mjs` for a runnable walkthrough.
