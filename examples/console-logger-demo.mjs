/**
 * Console logger demo — shows the opt-in rich console output.
 *
 * Runs against the public API: `useConsoleLogger: true` swaps the default
 * pino JSON logger for a colorized, sectioned terminal logger with the same
 * call-site contract (`logger.info/warn/error/debug…`).
 */
import { createRootLogger } from "panindigan-automate";

const logger = createRootLogger({
  level: "info",
  prettyPrint: false,
  logFile: null,
  transports: [],
  useConsoleLogger: true,
});

logger.startupBanner("0.2.6");
logger.features([
  { name: "HTTP Transport", status: "enabled" },
  { name: "MQTT Realtime", status: "enabled" },
  { name: "E2EE Encryption", status: "ready" },
  { name: "Stealth Guard", status: "enabled" },
  { name: "Auto Updates", status: "disabled" },
]);

logger.section("AUTHENTICATION");
logger.connecting("Facebook", "ash");
await new Promise((r) => setTimeout(r, 400));
logger.connected("Facebook", 1234);

logger.section("BOT ACTIVITY");
logger.messageIn("John Doe", "Hey! How are you?", false);
await new Promise((r) => setTimeout(r, 200));
logger.messageOut("John Doe", "I'm good, thanks!");

logger.section("LOG EXAMPLES");
logger.success("Operation completed successfully");
logger.info("Processing 25 pending messages");
logger.warn("Rate limit approaching (80%)");
logger.error("Failed to send message to user 12345");

logger.section("STATISTICS");
logger.metric("Messages sent", 1234);
logger.metric("Response time", 145, "ms");

console.log("\nDemo complete!\n");
