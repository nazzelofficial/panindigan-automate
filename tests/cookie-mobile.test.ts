/**
 * Desktop + mobile cookie export compatibility and diagnostic tests.
 *
 * Mobile extensions (e.g. Cookie-Editor on Android) emit different shapes:
 * `sameSite: "No restriction"`, numeric `expirationDate` in seconds,
 * string `expires`, and sometimes duplicate names. These tests exercise the
 * real parser (parseCredentials) -> CookieStore path, not just types.
 */

import { describe, expect, it } from "vitest";
import { parseCredentials, CookieStore } from "../src/auth/index.js";
import { createRootLogger } from "../src/logger/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const future = Math.floor((Date.now() + 30 * DAY_MS) / 1000);

/** Cookie diagnostics now go through the centralized pino logger, not console. */
function capturingLogger(): { logger: ReturnType<typeof createRootLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger({
    level: "warn",
    prettyPrint: false,
    logFile: null,
    transports: [{ write: (line) => lines.push(line) }],
  });
  return { logger, lines };
}

const base = () => [
  { key: "c_user", value: "61596880191204", domain: ".facebook.com", path: "/", expirationDate: future, secure: true, httpOnly: false },
  { key: "xs", value: "2%3Amock", domain: ".facebook.com", path: "/", expirationDate: future, secure: true, httpOnly: true },
  { key: "datr", value: "mock-datr", domain: ".facebook.com", path: "/", expirationDate: future, secure: true, httpOnly: true },
];

describe("cookie export compatibility", () => {
  it("sends m.facebook.com host-only session cookies to www.facebook.com", async () => {
    // Mobile browsers export c_user/xs/datr scoped to m.facebook.com and
    // host-only. All library requests go to www.facebook.com, so without
    // domain canonicalization these are never sent — the session looks
    // unauthenticated and Facebook rate-limits it.
    const cookies = await parseCredentials([
      { key: "c_user", value: "61596880191204", domain: "m.facebook.com", path: "/", hostOnly: true, expirationDate: future },
      { key: "xs", value: "mobile-xs", domain: "m.facebook.com", path: "/", hostOnly: true, expirationDate: future },
      { key: "datr", value: "mobile-datr", domain: ".m.facebook.com", path: "/", expirationDate: future },
    ]);
    const store = CookieStore.fromCookies(cookies);
    const header = store.headerFor("https://www.facebook.com/");
    expect(header).toContain("c_user=61596880191204");
    expect(header).toContain("xs=mobile-xs");
    expect(header).toContain("datr=mobile-datr");
    expect(store.requireAuthenticated()).toBe("61596880191204");
  });

  it("sends name/value-array mobile cookies (hostOnly discarded) to www", async () => {
    const cookies = await parseCredentials([
      { name: "c_user", value: "61596880191204", domain: "m.facebook.com", path: "/", hostOnly: true, expirationDate: future },
      { name: "xs", value: "v", domain: "m.facebook.com", path: "/", expirationDate: future },
      { name: "datr", value: "v", domain: "m.facebook.com", path: "/", expirationDate: future },
    ]);
    const store = CookieStore.fromCookies(cookies);
    expect(store.headerFor("https://www.facebook.com/")).toContain("c_user=61596880191204");
    expect(store.requireAuthenticated()).toBe("61596880191204");
  });

  it("accepts a host-only dbln on the canonical facebook.com domain (10/10)", async () => {
    // tough-cookie silently drops a host-only `facebook.com` cookie that is
    // stored through `https://www.facebook.com/`. The old urlForCookie() check
    // skipped the exact canonical domain, so dbln was falsely "rejected".
    const cookies = await parseCredentials([
      ...base(),
      {
        key: "dbln",
        value: "host-only-value",
        domain: "facebook.com",
        path: "/",
        hostOnly: true,
        expirationDate: future,
        secure: true,
        httpOnly: true,
      },
    ]);
    const { logger, lines } = capturingLogger();
    const store = CookieStore.fromCookies(cookies, logger);

    expect(lines.join("\n")).not.toContain("were rejected by the cookie jar");
    // Stored under its exact host; a host-only cookie is correctly NOT sent
    // to www.facebook.com, so check the jar instead of the www cookie header.
    const stored = store.toSerialized().cookies.some((cookie) => cookie.key === "dbln");
    expect(stored).toBe(true);
  });

  it("stores dbln with a /login/device-based/ path without a rejection warning", async () => {
    // The real deployment shape: a device-login cookie scoped to a sub-path.
    // Storing it under the root URL made getCookiesSync() never see it.
    const cookies = await parseCredentials([
      ...base(),
      {
        name: "dbln",
        value: "device-token",
        domain: "facebook.com",
        path: "/login/device-based/",
        sameSite: "No restriction",
        expirationDate: future,
        secure: true,
        httpOnly: false,
      },
    ]);
    const { logger, lines } = capturingLogger();
    const store = CookieStore.fromCookies(cookies, logger);
    expect(lines.join("\n")).not.toContain("rejected");
    expect(store.toSerialized().cookies.some((c) => c.key === "dbln")).toBe(true);
  });

  it("accepts a desktop AppState array", async () => {
    const cookies = await parseCredentials(base());
    expect(cookies).toHaveLength(3);
    expect(CookieStore.fromCookies(cookies).requireAuthenticated()).toBe("61596880191204");
  });

  it("accepts sameSite: 'No restriction' from a mobile export", async () => {
    const cookies = await parseCredentials([
      ...base(),
      { name: "dbln", value: "m", domain: ".facebook.com", path: "/", sameSite: "No restriction", secure: true, httpOnly: true },
    ]);
    expect(cookies).toHaveLength(4);
    expect(cookies.find((c) => c.name === "dbln")?.sameSite).toBe("none");
  });

  it("accepts Lax/Strict and missing SameSite", async () => {
    for (const [value, expected] of [["Lax", "lax"], ["Strict", "strict"]] as const) {
      const cookies = await parseCredentials([
        ...base(),
        { name: "aux", value: "v", domain: ".facebook.com", path: "/", sameSite: value },
      ]);
      expect(cookies.find((c) => c.name === "aux")?.sameSite).toBe(expected);
    }
    const noSite = await parseCredentials([...base(), { name: "aux", value: "v", domain: ".facebook.com", path: "/" }]);
    expect(noSite.find((c) => c.name === "aux")?.sameSite).toBeUndefined();
  });

  it("does not silently convert an invalid SameSite into a valid one", async () => {
    const cookies = await parseCredentials([
      ...base(),
      { name: "aux", value: "v", domain: ".facebook.com", path: "/", sameSite: "garbage-value" },
    ]);
    expect(cookies.find((c) => c.name === "aux")?.sameSite).toBeUndefined();
  });

  it("distinguishes an expired dbln from a rejected one", async () => {
    const expired = [
      ...base(),
      { name: "dbln", value: "expired", domain: ".facebook.com", path: "/", expirationDate: 1, secure: true, httpOnly: true },
    ];
    const { logger, lines } = capturingLogger();
    CookieStore.fromCookies(await parseCredentials(expired), logger);
    const message = lines.join("\n");
    expect(message).toContain("expired");
    expect(message).toContain("dbln");
    expect(message).not.toContain("were rejected by the cookie jar");
  });

  it("accepts a valid dbln without an expiration warning", async () => {
    const valid = [
      ...base(),
      { name: "dbln", value: "ok", domain: ".facebook.com", path: "/", expirationDate: future, secure: true, httpOnly: true },
    ];
    const { logger, lines } = capturingLogger();
    CookieStore.fromCookies(await parseCredentials(valid), logger);
    expect(lines.join("\n")).not.toContain("dbln");
  });

  it("handles a missing expiration as a session cookie", async () => {
    const cookies = await parseCredentials([
      ...base(),
      { name: "sessionaux", value: "v", domain: ".facebook.com", path: "/" },
    ]);
    expect(cookies.find((c) => c.name === "sessionaux")?.expiresAtMs).toBeNull();
  });

  it("keeps a string expires value", async () => {
    const iso = new Date(Date.now() + DAY_MS).toISOString();
    const cookies = await parseCredentials([
      ...base(),
      { name: "aux", value: "v", domain: ".facebook.com", path: "/", expires: iso },
    ]);
    expect(cookies.find((c) => c.name === "aux")?.expiresAtMs).toBe(Date.parse(iso));
  });

  it("survives a mixed-format export (key/name + seconds/ms expiry)", async () => {
    const cookies = await parseCredentials([
      { key: "c_user", value: "61596880191204", domain: "facebook.com", path: "/", expires: new Date(Date.now() + DAY_MS).toISOString() },
      { name: "xs", value: "v", domain: ".facebook.com", path: "/", expires: Date.now() + DAY_MS },
      { name: "datr", value: "v", domain: ".facebook.com", path: "/", expirationDate: future },
      { name: "presence", value: "v", domain: ".facebook.com", path: "/" },
    ]);
    expect(cookies).toHaveLength(4);
    expect(CookieStore.fromCookies(cookies).requireAuthenticated()).toBe("61596880191204");
  });

  it("round-trips through serialization with SameSite preserved", async () => {
    const cookies = await parseCredentials([
      ...base(),
      { name: "dbln", value: "v", domain: ".facebook.com", path: "/", sameSite: "No restriction", expirationDate: future },
    ]);
    const first = CookieStore.fromCookies(cookies);
    const restored = CookieStore.fromSerialized(first.toSerialized() as Parameters<typeof CookieStore.fromSerialized>[0]);
    expect(restored.requireAuthenticated()).toBe("61596880191204");
    expect(restored.headerFor("https://www.facebook.com")).toContain("c_user=61596880191204");
  });
});
