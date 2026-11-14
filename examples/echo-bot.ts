/**
 * Panindigan Automate - Minimal Echo Bot Example
 *
 * Runs an echo bot that replies to messages in 1:1 and group chats.
 * Run with:
 *   pnpm tsx examples/echo-bot.ts
 *   or bun examples/echo-bot.ts
 */

import { MessengerClient } from "../src/index.js";

const client = new MessengerClient({
  logLevel: "info",
  persistSession: true,
});

let myUserId: string | undefined;

// Emitted once login and realtime MQTT connection are ready
client.on("ready", (event) => {
  myUserId = event.userId;
  console.log(`[bot] Logged in successfully as user ${myUserId}`);
});

// Emitted for every incoming message
client.on("message", async (event) => {
  // Ignore messages sent by the bot itself or messages with empty bodies
  if (event.senderId === myUserId || !event.body) {
    return;
  }

  console.log(`[chat] ${event.isGroup ? "Group" : "Direct"} message from ${event.senderId}: ${event.body}`);

  // Reply back to the same thread
  await client.sendMessage(event.threadId, {
    type: "text",
    body: `Echo: ${event.body}`,
  });
});

// Emitted when a connection drop occurs and client is reconnecting
client.on("warning", (event) => {
  console.warn(`[warning] ${event.message}`);
});

// Log in using exported browser cookies/appstate
await client.login("./appstate.json");
