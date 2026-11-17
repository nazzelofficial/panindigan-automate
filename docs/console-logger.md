# Console Logger

An opt-in, colorized terminal logger is built into this package. It swaps the default pino JSON logger for a sectioned console output (rich colors, box drawing, icons, message in/out indicators) with the same call-site contract (`logger.info`/`warn`/`error`/`debug`).

## Enabling it

```ts
import { createRootLogger } from "panindigan-automate";

const logger = createRootLogger({
  level: "info",
  prettyPrint: false,     // ignored when console mode is on
  logFile: null,          // ignored when console mode is on
  transports: [],
  useConsoleLogger: true,
});

logger.startupBanner("0.1.8");
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
- Same level gates: `silent|fatal|error|warn|info|debug|verbose|trace`. `success` is an additional level routed through `info` handling.
- `error` / `fatal` include the message; `debug`/`verbose`/`trace` are suppressed unless their level is enabled.
- Secrets are NOT passed through a redaction pipeline in console mode — avoid logging credential-bearing objects. Use the default pino logger (which redacts `cookies`, `appState`, `fb_dtsg`, `token`, …) when the process output may be shipped to an aggregator.

## When to use which

| Situation | Recommendation |
| --- | --- |
| Interactive terminal / dev host | `useConsoleLogger: true` |
| Production with logs shipped off-box | default (pino JSON, redacted) |
| Bots writing local log files | default (pino JSON, redacted) |
| Demos / examples | console logger |

See `examples/console-logger-demo.mjs` for a runnable walkthrough.
