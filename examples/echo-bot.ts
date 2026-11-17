/**
 * Panindigan Automate - Minimal Echo Bot Example
 *
 * Runs an echo bot that replies to messages in 1:1 and group chats.
 * Run with:
 *   pnpm tsx examples/echo-bot.ts
 *   or bun examples/echo-bot.ts
 */

import { login } from "../src/index.js";

const client = await login("./appstate.json", {
  logLevel: "info",
  persistSession: true, // Persists session cookies and sync cursor across restarts
});

// Emitted for every incoming message
client.on("message", async (event) => {
  // Ignore messages sent by the bot itself or messages with empty bodies
  if (event.isSelf || !event.body) {
    return;
  }

  console.log(`[chat] ${event.isGroup ? "Group" : "Direct"} message from ${event.senderId}: ${event.body}`);

  // Reply back to the same thread
  await client.sendMessage(event.threadId, {
    type: "text",
    body: `Echo: ${event.body}`,
  });
});

// Catch warning and error events
client.on("warning", (event) => {
  console.warn(`[warning] ${event.message}`);
});
