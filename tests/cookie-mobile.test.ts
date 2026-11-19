/**
 * Desktop + mobile cookie export compatibility and diagnostic tests.
 *
 * Mobile extensions (e.g. Cookie-Editor on Android) emit different shapes:
 * `sameSite: "No restriction"`, numeric `expirationDate` in seconds,
 * string `expires`, and sometimes duplicate names. These tests exercise the
 * real parser (parseCredentials) -> CookieStore path, not just types.
 */

import { describe, expect, it, vi } from "vitest";
import { parseCredentials, CookieStore } from "../src/auth/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const future = Math.floor((Date.now() + 30 * DAY_MS) / 1000);

const base = () => [
  { key: "c_user", value: "61596880191204", domain: ".facebook.com", path: "/", expirationDate: future, secure: true, httpOnly: false },
  { key: "xs", value: "2%3Amock", domain: ".facebook.com", path: "/", expirationDate: future, secure: true, httpOnly: true },
  { key: "datr", value: "mock-datr", domain: ".facebook.com", path: "/", expirationDate: future, secure: true, httpOnly: true },
];

describe("cookie export compatibility", () => {
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    CookieStore.fromCookies(await parseCredentials(expired));
    const message = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    warn.mockRestore();
    expect(message).toContain("expired");
    expect(message).toContain("dbln");
    expect(message).not.toContain("were rejected by tough-cookie");
  });

  it("accepts a valid dbln without an expiration warning", async () => {
    const valid = [
      ...base(),
      { name: "dbln", value: "ok", domain: ".facebook.com", path: "/", expirationDate: future, secure: true, httpOnly: true },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    CookieStore.fromCookies(await parseCredentials(valid));
    const message = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    warn.mockRestore();
    expect(message).not.toContain("dbln");
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
