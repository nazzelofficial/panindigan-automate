#!/usr/bin/env node
/**
 * panindigan-automate — environment doctor.
 *
 *   panindigan-automate doctor            environment + network checks
 *   panindigan-automate doctor --login    also performs a real login attempt
 *
 * Everything here is read-only except the optional --login flag (which logs
 * in with the credentials you point it at and then logs out). Exit code is
 * 0 when every required check passes, 1 otherwise.
 */
import { connect as tlsConnect } from "node:tls";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const command = args[0];

if (command !== "doctor") {
  console.log("usage: panindigan-automate doctor [--login]");
  process.exit(command === undefined ? 0 : 2);
}

const wantLogin = args.includes("--login");
const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("panindigan-automate doctor\n");

// 1. Node version
const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
record("node >= 22", major >= 22, `node ${process.versions.node}`);

// 2. Credentials present and minimally valid
const envState = process.env.APPSTATE;
const appstatePath = join(process.cwd(), "appstate.json");
let cookies = null;
if (envState) {
  try {
    cookies = JSON.parse(envState);
    record("APPSTATE env parses", true, "");
  } catch {
    record("APPSTATE env parses", false, "not valid JSON");
  }
} else if (existsSync(appstatePath)) {
  try {
    cookies = JSON.parse(readFileSync(appstatePath, "utf8"));
    record("appstate.json parses", true, "");
  } catch {
    record("appstate.json parses", false, "not valid JSON");
  }
} else {
  record("credentials found (APPSTATE env or ./appstate.json)", false, "none found — login will fail");
}
if (cookies !== null) {
  const list = Array.isArray(cookies) ? cookies : Object.values(cookies);
  const names = new Set(list.map((c) => c && (c.key ?? c.name)));
  const missing = ["c_user", "xs", "datr"].filter((n) => !names.has(n));
  record("required cookies (c_user, xs, datr)", missing.length === 0, missing.length === 0 ? "all present" : `missing: ${missing.join(", ")}`);
}

// 3. Storage directory is writable
try {
  const dir = process.cwd();
  const probe = join(dir, `.panindigan-doctor-${process.pid}`);
  writeFileSync(probe, "ok");
  unlinkSync(probe);
  record("storage directory writable", true, dir);
} catch (error) {
  record("storage directory writable", false, String(error && error.message ? error.message : error));
}

// 4. HTTPS reachability of facebook.com
const httpsReachable = await (async () => {
  try {
    const response = await fetch("https://www.facebook.com/", {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: response.status < 500, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: String(error && error.message ? error.message : error) };
  }
})();
record("facebook.com reachable (HTTPS)", httpsReachable.ok, httpsReachable.detail);

// 5. MQTT edge endpoint reachable (TLS handshake, then close)
const mqttReachable = await new Promise((resolve) => {
  const start = Date.now();
  const socket = tlsConnect(
    { host: "edge-chat.facebook.com", port: 443, servername: "edge-chat.facebook.com" },
    () => {
      const ms = Date.now() - start;
      socket.destroy();
      resolve({ ok: true, detail: `TLS handshake in ${ms}ms` });
    },
  );
  socket.setTimeout(8_000, () => {
    socket.destroy();
    resolve({ ok: false, detail: "timed out after 8000ms" });
  });
  socket.on("error", (error) => {
    resolve({ ok: false, detail: error.message });
  });
});
record("edge-chat.facebook.com:443 reachable (MQTT)", mqttReachable.ok, mqttReachable.detail);

// 6. Optional: real login
if (wantLogin) {
  if (cookies === null) {
    record("login attempt", false, "no credentials available");
  } else {
    try {
      const { MessengerClient } = await import("panindigan-automate");
      const client = new MessengerClient({ storageAdapter: "memory", logLevel: "silent" });
      await client.login(Array.isArray(cookies) ? cookies : cookies);
      await client.logout();
      record("login attempt (real)", true, "authenticated and logged out cleanly");
    } catch (error) {
      record("login attempt (real)", false, String(error && error.message ? error.message : error));
    }
  }
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
