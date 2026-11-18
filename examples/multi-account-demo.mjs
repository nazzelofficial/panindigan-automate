/**
 * Concurrent Bot Instances Demo
 *
 * Demonstrates running multiple MessengerClient instances concurrently.
 * Each Facebook account requires its own separate bot instance with:
 * - Isolated sessions (one MessengerClient per account)
 * - Different proxies per instance
 * - Separate storage directories
 * - Independent rate limits and stealth configs
 *
 * Note: This is NOT multi-account management within a single instance.
 * Each account needs its own MessengerClient. For account orchestration,
 * load balancing, or rotation, build your own wrapper around these instances.
 *
 * Run: node examples/multi-account-demo.mjs
 */

import { login } from "panindigan-automate";

// Each Facebook account configuration with isolated settings
const accounts = [
  {
    name: "Bot Instance 1 (Account A)",
    appstate: "./account1.json",
    proxy: "socks5://proxy1.example.com:1080",
    storageDir: "./session/account1",
    stealth: {
      caps: {
        perThreadHourly: 30,
        globalHourly: 100,
        globalDaily: 200,
      },
      warmupDays: 7,
    },
  },
  {
    name: "Bot Instance 2 (Account B)",
    appstate: "./account2.json",
    proxy: "socks5://user:pass@proxy2.example.com:1080", // With auth
    storageDir: "./session/account2",
    stealth: {
      caps: {
        perThreadHourly: 20, // More conservative
        globalHourly: 80,
        globalDaily: 150,
      },
      warmupDays: 10, // Longer warmup
    },
  },
  {
    name: "Bot Instance 3 (Account C)",
    appstate: "./account3.json",
    proxy: null, // No proxy
    storageDir: "./session/account3",
    stealth: {
      caps: {
        perThreadHourly: 40,
        globalHourly: 120,
        globalDaily: 250,
      },
      warmupDays: 5,
    },
  },
];

/**
 * Initialize a single bot instance (one MessengerClient per Facebook account)
 */
async function initializeBot(config) {
  console.log(`\n🤖 Initializing ${config.name}...`);

  try {
    // Each Facebook account gets its own MessengerClient instance
    const client = await login(config.appstate, {
      // Isolated proxy per account
      httpProxy: config.proxy,

      // Isolated storage per account
      storageDirectory: config.storageDir,
      persistSession: true,

      // Per-account stealth configuration
      stealth: {
        antiDetection: true,
        ...config.stealth,
      },

      // Optional: Different update policies per account
      update: {
        enabled: true,
        policy: "minor",
      },

      logLevel: "info",
    });

    console.log(`✅ ${config.name} logged in successfully`);
    console.log(`   User ID: ${client.getSession()?.userId || "unknown"}`);
    console.log(`   Proxy: ${config.proxy || "Direct connection"}`);
    console.log(`   Storage: ${config.storageDir}`);

    // Set up message handler for this account
    client.on("message", async (event) => {
      if (event.isSelf || !event.body) return;

      console.log(
        `📩 ${config.name} received: "${event.body}" from ${event.senderId}`
      );

      // Each instance has independent rate limiting
      try {
        await client.sendMessage(event.threadId, {
          type: "text",
          body: `[${config.name}] Echo: ${event.body}`,
        });
      } catch (error) {
        console.error(`❌ ${config.name} send failed:`, error.message);
      }
    });

    // Monitor health independently per account
    client.on("health_warning", (event) => {
      console.warn(
        `⚠️  ${config.name} health warning: ${event.score}/100 - ${event.reason}`
      );
    });

    client.on("suspension_halt", (event) => {
      console.error(
        `🛑 ${config.name} GUARD HALTED: ${event.reason}`
      );
    });

    return client;
  } catch (error) {
    console.error(`❌ ${config.name} initialization failed:`, error.message);
    return null;
  }
}

/**
 * Main: Initialize all bot instances concurrently (one per Facebook account)
 */
async function main() {
  console.log("🚀 Starting Concurrent Bot Instances Manager");
  console.log(`📊 Managing ${accounts.length} Facebook accounts (${accounts.length} separate instances)\n`);

  // Initialize all bots in parallel
  const clients = await Promise.all(accounts.map(initializeBot));

  // Filter out failed initializations
  const activeClients = clients.filter((client) => client !== null);

  console.log(
    `\n✅ Successfully initialized ${activeClients.length}/${accounts.length} accounts`
  );

  if (activeClients.length === 0) {
    console.error("❌ No accounts initialized successfully. Exiting.");
    process.exit(1);
  }

  // Example: Broadcast message from all accounts
  async function broadcastToAll(threadId, message) {
    console.log(`\n📢 Broadcasting to thread ${threadId}...`);

    const results = await Promise.allSettled(
      activeClients.map((client, index) =>
        client.sendMessage(threadId, {
          type: "text",
          body: `[Account ${index + 1}] ${message}`,
        })
      )
    );

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        console.log(`✅ Account ${index + 1} sent successfully`);
      } else {
        console.error(`❌ Account ${index + 1} failed:`, result.reason.message);
      }
    });
  }

  // Example usage (uncomment to test)
  // await broadcastToAll("100000000000000", "Hello from all bots!");

  // Keep running
  console.log("\n✅ All bots are running. Press Ctrl+C to exit.\n");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n\n🛑 Shutting down all bots...");

    await Promise.all(
      activeClients.map(async (client, index) => {
        try {
          await client.logout();
          console.log(`✅ Account ${index + 1} logged out`);
        } catch (error) {
          console.error(
            `⚠️  Account ${index + 1} logout failed:`,
            error.message
          );
        }
      })
    );

    console.log("👋 All bots shut down. Goodbye!");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});
