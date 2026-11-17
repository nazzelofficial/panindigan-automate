/**
 * Group manager — inspect and rename a group.
 *
 * Demonstrates the group APIs and the static thread-color registry.
 * The bot must be a group participant to change anything.
 */
import { login } from "panindigan-automate";

const GROUP_ID = process.argv[2];

if (!GROUP_ID) {
  console.error("usage: node examples/group-manager.js <groupThreadId>");
  process.exit(1);
}

const client = await login("./appstate.json");

client.on("error", (event) => {
  console.error("[error]", event.error.message);
});

{
  const info = await client.getThread(GROUP_ID);
  console.log("thread:", info.name, `(${info.isGroup ? "group" : "direct"})`);

  console.log("\nknown thread colors:");
  for (const entry of client.getThreadColorList()) {
    console.log(`  ${entry.name.padEnd(16)} ${entry.themeId}`);
  }

  // Rename is allowed inside the guard's pacing/caps; check diagnostics after.
  await client.changeGroupName(GROUP_ID, `${info.name} (mod)`);

  console.log("\ndiagnostics:");
  console.log(JSON.stringify(client.diagnostics.getSnapshot().stealth, null, 2));
  process.exit(0);
}
