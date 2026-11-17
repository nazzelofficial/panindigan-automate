/**
 * Panindigan Automate - Group Manager Bot Example
 *
 * Demonstrates group chat automation:
 * - Handling bot commands (!help, !theme, !poll, !info)
 * - Listening to participant join/leave events
 * - Managing group thread settings
 *
 * Run with:
 *   pnpm tsx examples/group-manager.ts
 *   or bun examples/group-manager.ts
 */

import { login, THREAD_COLORS } from "../src/index.js";

const client = await login("./appstate.json", {
  logLevel: "info",
  persistSession: true,
});

console.log("[group-bot] Logged in and listening.");

// Welcome new members joining a group
client.on("participant_join", async (event) => {
  console.log(`[group] New participants joined thread ${event.threadId}:`, event.addedIds);
  await client.sendMessage(event.threadId, {
    type: "text",
    body: "Welcome to the group chat!",
  });
});

// Listen to command messages
client.on("message", async (event) => {
  if (event.isSelf || !event.body || !event.isGroup) {
    return;
  }

  const text = event.body.trim();

  // Command: !ping
  if (text === "!ping") {
    await client.sendReply(event.threadId, event.messageId, {
      type: "text",
      body: "Pong! Active and listening.",
    });
    return;
  }

  // Command: !theme <color>
  if (text.startsWith("!theme ")) {
    const colorName = text.slice(7).trim();
    if (colorName in THREAD_COLORS) {
      await client.changeGroupTheme(event.threadId, colorName);
      await client.sendMessage(event.threadId, {
        type: "text",
        body: `Group theme changed to ${colorName}.`,
      });
    } else {
      await client.sendMessage(event.threadId, {
        type: "text",
        body: `Available preset colors: ${Object.keys(THREAD_COLORS).slice(0, 10).join(", ")}...`,
      });
    }
    return;
  }

  // Command: !poll <question> | <opt1> | <opt2>
  if (text.startsWith("!poll ")) {
    const parts = text.slice(6).split("|").map((p) => p.trim());
    const question = parts[0];
    const options = parts.slice(1);

    if (question && options.length >= 2) {
      await client.createPoll(event.threadId, question, options);
    } else {
      await client.sendMessage(event.threadId, {
        type: "text",
        body: "Usage: !poll Question | Option A | Option B",
      });
    }
  }
});
