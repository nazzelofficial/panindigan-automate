/**
 * Warmup-aware broadcast — demonstrates the Stealth Guard's pacing rules.
 *
 * The Stealth Guard is ON by default and paces every outbound operation.
 * This example simply sends a small list of announcements at the guard's
 * own comfortable pace; if the guard is halted it throws AccountRestrictedError
 * and we stop — never bypass it.
 */
import { login, AccountRestrictedError } from "panindigan-automate";

const TARGETS = (process.argv[2] ?? "").split(",").filter(Boolean);
const MESSAGE = process.argv[3] ?? "hello from the warmed-up bot";

if (TARGETS.length === 0) {
  console.error("usage: node examples/warmup-broadcast.js <threadId1,threadId2,...> [message]");
  process.exit(1);
}

const client = await login("./appstate.json", {
  stealth: {
    // day-zero sessions ramp automatically; nothing to configure for warmup itself.
  },
});

client.on("suspension_halt", (event) => {
  console.error("GUARD HALTED:", event.reason);
});

client.on("suspension_warning", (event) => {
  console.warn("guard:", event.signal.message);
});

{
  for (const target of TARGETS) {
    try {
      await client.sendMessage(target, { type: "text", body: MESSAGE });
      console.log("sent to", target);
    } catch (error) {
      if (error instanceof AccountRestrictedError) {
        console.error("guard blocked the send — stop and wait:", error.message);
        process.exit(1);
      }
      throw error;
    }
  }
  console.log("done");
  process.exit(0);
}
