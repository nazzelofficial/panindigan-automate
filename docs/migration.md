# Migrating from Outdated Libraries

If you are migrating from legacy Messenger automation libraries (such as the unmaintained `facebook-chat-api` or community forks like `fca-unofficial`), this guide maps common patterns to Panindigan Automate.

---

## Key Conceptual Differences

| Aspect | Legacy FCA Libraries | Panindigan Automate |
| :--- | :--- | :--- |
| **Language & Typings** | Plain JavaScript (callbacks) | Strict TypeScript 5.9 + Zod schemas |
| **API Paradigm** | Error-first callbacks: `(err, api) => ...` | Modern async/await Promises |
| **Realtime Engine** | Outdated MQTT v2 / long-polling | **MQTT over WebSocket with Sync Protocol v11** |
| **Proxying** | Incomplete (HTTP only, WebSocket leaked) | **Full HTTP & WebSocket Tunneling** (`WsProxyAgent`) |
| **Message Editing** | Broken / missing | Modern `/ls_req` Task 742 |
| **Crash Behavior** | Crashes process on unhandled deltas | Emits unknown payloads safely as `raw` events |

---

## Initialization & Login

### Legacy FCA
```js
// Old callback-based pattern
login({ appState: JSON.parse(fs.readFileSync("appstate.json")) }, (err, api) => {
  if (err) return console.error(err);
  api.listenMqtt((err, message) => {
    // ...
  });
});
```

### Panindigan Automate
```ts
import { MessengerClient } from "panindigan-automate";

const client = new MessengerClient();

client.on("message", async (event) => {
  // Strongly typed message event
});

// Awaitable login directly accepts the file path
await client.login("./appstate.json");
```

---

## Method Translation Table

| Legacy Method | Panindigan Automate Equivalent | Notes |
| :--- | :--- | :--- |
| `api.sendMessage(msg, threadID, callback)` | `await client.sendMessage(threadId, content)` | Returns `{ messageId, timestamp }`. Direct/group routing is automatic. |
| `api.setMessageReaction(reaction, messageID)` | `await client.setMessageReaction(messageId, reaction)` | Supports emojis (`"❤️"`) or keywords (`"heart"`). |
| `api.unsendMessage(messageID)` | `await client.unsendMessage(messageId)` | Un-sends a message for everyone. |
| `api.editMessage(text, messageID)` | `await client.editMessage(messageId, text)` | Uses modern Task 742 `/ls_req` protocol. |
| `api.addUserToGroup(userID, threadID)` | `await client.addParticipant(threadId, userIds)` | Accepts a single string or an array of strings. |
| `api.removeUserFromGroup(userID, threadID)` | `await client.removeParticipant(threadId, userId)` | Removes participant from group thread. |
| `api.setTitle(newTitle, threadID)` | `await client.changeGroupName(threadId, name)` | Renames group chat. |
| `api.changeThreadColor(color, threadID)` | `await client.changeGroupTheme(threadId, color)` | Accepts 6-digit hex or preset name. |
| `api.changeNickname(nickname, threadID, userID)`| `await client.changeNickname(threadId, userId, nickname)` | Pass `""` to reset nickname. |
| `api.sendTypingIndicator(threadID, callback)` | `await client.setTyping(threadId, true/false)` | Uses Type-4 `/ls_req` task envelope. |
| `api.markAsRead(threadID)` | `await client.markAsRead(threadId)` | Marks thread messages as read. |
| `api.getThreadInfo(threadID)` | `await client.getThread(threadId)` | Uses modern GraphQL doc `3449967031715030`. |
| `api.getThreadHistory(threadID, amount)` | `await client.getMessages(threadId, { limit })` | Cursor-based message history. |
| `api.getUserInfo(userID)` | `await client.getUser(userId)` | Returns strongly typed `UserInfo`. |

---

## Event Mapping

Instead of the catch-all `api.listenMqtt((err, event) => ...)` switch statement, listen to dedicated event types:

```ts
// Inbound messages
client.on("message", (event) => {
  console.log(event.senderId, event.body, event.isGroup);
});

// Quoted replies
client.on("message_reply", (event) => {
  console.log("Replied to message ID:", event.replyTo.id);
});

// Group additions and leaves
client.on("participant_join", (event) => {
  console.log("Joined:", event.participants);
});
client.on("participant_leave", (event) => {
  console.log("Left/Kicked:", event.participantId);
});

// Live reactions
client.on("reaction", (event) => {
  console.log(`${event.userId} reacted ${event.reaction} on message ${event.messageId}`);
});
```
