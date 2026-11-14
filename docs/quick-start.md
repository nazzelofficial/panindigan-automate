# Quick Start Guide

Get up and running with Panindigan Automate in less than 5 minutes.

---

## 1. Prerequisites

- **Node.js 22 LTS or newer** (Node 26 recommended) or **Bun >= 1.1**.
- **pnpm** (recommended), **bun**, or **npm**.
- Exported session cookies (`c_user`, `xs`, `datr`) from an active Facebook session in your browser.

---

## 2. Installation

Install the package in your project:

```bash
# Using pnpm (Recommended)
pnpm add panindigan-automate

# Using Bun
bun add panindigan-automate

# Using npm
npm install panindigan-automate
```

---

## 3. Exporting Your Session Cookies

Panindigan Automate connects to Facebook as an authorized browser session, so you don't need to enter your email and password.

1. Log in to Facebook in your normal browser (Google Chrome, Brave, Edge, etc.).
2. Export your cookies using an extension like **EditThisCookie**, **Cookie-Editor**, or copy them from the DevTools Network tab.
3. Save the JSON array into a local file named `appstate.json` in your project root:

```json
[
  { "key": "c_user", "value": "1000123456789", "domain": ".facebook.com", "path": "/" },
  { "key": "xs", "value": "2%3Aabc123xyz...", "domain": ".facebook.com", "path": "/" },
  { "key": "datr", "value": "xyz_abc...", "domain": ".facebook.com", "path": "/" }
]
```

> **Security Tip**: Always add `appstate*.json` to your `.gitignore` to prevent committing your credentials to GitHub.

---

## 4. Writing Your First Bot (`bot.ts`)

Create a `bot.ts` file with an echo bot implementation:

```ts
import { MessengerClient } from "panindigan-automate";

// Initialize client
const client = new MessengerClient({
  logLevel: "info",
  persistSession: true, // Persists session cookies and sequences across restarts
});

let botUserId: string;

// 1. Ready event fires once authenticated and MQTT socket is connected
client.on("ready", (event) => {
  botUserId = event.userId;
  console.log(`[ready] Connected as user: ${botUserId}`);
});

// 2. Listen to incoming messages in direct and group chats
client.on("message", async (event) => {
  // Prevent replying to the bot's own messages or empty notifications
  if (event.senderId === botUserId || !event.body) {
    return;
  }

  console.log(`[message] Received from ${event.senderId}: "${event.body}"`);

  // Handle a basic !ping command
  if (event.body.trim() === "!ping") {
    await client.sendReply(event.threadId, event.id, {
      type: "text",
      body: "Pong! 🏓 Panindigan Automate is online.",
    });
    return;
  }

  // Echo any other message
  await client.sendMessage(event.threadId, {
    type: "text",
    body: `Echo: ${event.body}`,
  });
});

// 3. Catch background warnings and non-fatal network reconnects
client.on("warning", (event) => {
  console.warn(`[warning] ${event.message}`);
});

// 4. Catch fatal connection drops
client.on("error", (event) => {
  console.error(`[error]`, event.error);
});

// 5. Authenticate and start
await client.login("./appstate.json");
```

---

## 5. Running the Bot

Run directly using `tsx` or `bun`:

```bash
# Using pnpm with tsx
pnpm dlx tsx bot.ts

# Using Bun
bun bot.ts
```

When you see:
```
[ready] Connected as user: 1000123456789
```
Your bot is online and ready to receive messages!

---

## Next Steps

- Explore the complete [API Reference](api-reference.md) for reactions, attachments, and polls.
- Learn about the [Authentication](authentication.md) system and automatic cookie refresh.
- Check [Middleware](middleware.md) to intercept incoming messages and commands.
