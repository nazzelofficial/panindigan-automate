/**
 * Dry-run demo — see exactly what the bot would send, without touching the network.
 *
 * With `dryRun: true`, no outbound request leaves the process. Every mutation
 * (sends, reactions, polls, group ops …) is logged with the payload summary
 * it would have used, and returns synthetic results. Read-only calls still
 * happen — a bot that can't read anything would be useless for testing.
 *
 * Run: node examples/dry-run.js   (with ./appstate.json present)
 */
import { login } from "panindigan-automate";

const client = await login("./appstate.json", { dryRun: true, logLevel: "info" });

await client.sendMessage("100000123456", { type: "text", body: "this is only logged, never sent" });

console.log(JSON.stringify(client.diagnostics.getSnapshot(), null, 2));
process.exit(0);
