/**
 * E2EE one-to-one demo — ported fbapi-unofficial transport against live FB.
 *
 * Requires a valid appstate (Facebook cookies) and a real one-to-one thread.
 * WARNING: connecting registers an E2EE device under your account on first
 * run. Use a throwaway account. Live behavior has NOT been verified by the
 * authors — treat failures as expected until you confirm it works.
 *
 * Group E2EE threads are not supported (throws NotImplementedError).
 */
import { login } from "panindigan-automate";

const client = await login("./appstate.json", {
  e2ee: "auto", // "off" (default) | "auto" | "require"
});

client.on("e2ee_message", (event) => {
  console.log(`[E2EE] from ${event.senderId}: ${event.body}`);
});
client.on("warning", (event) => {
  if (String(event.message).includes("E2EE")) {
    console.error(`[E2EE warning] ${event.message}`);
  }
});

// The encrypted channel is already connected when e2ee is enabled.
const c = client;

const threadId = process.argv[2];
if (!threadId) {
  console.error("usage: node examples/e2ee-dm.js <threadId> [message]");
  process.exit(1);
}

const result = await c.sendEncryptedMessage(threadId, process.argv[3] ?? "hello over E2EE");
console.log(`Sent (id=${result.messageId}). Waiting for incoming messages — Ctrl+C to quit.`);

setInterval(() => undefined, 60_000);
