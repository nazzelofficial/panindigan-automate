/**
 * Echo bot — replies to every text message sent to the account.
 * Credentials come from APPSTATE (Resend's getCookie pattern) or ./appstate.json.
 * Uses the main `login()` entry.
 */
import { login } from "panindigan-automate";

const client = await login("./appstate.json");

client.on("message", async (event) => {
  if (event.isSelf || !event.body) return;

  try {
    await client.sendMessage(event.threadId, { type: "text", body: event.body });
  } catch (error) {
    // Stealth Guard halted (account restriction risk)? Back off, never bypass.
    console.error("send failed:", error instanceof Error ? error.message : error);
  }
});
