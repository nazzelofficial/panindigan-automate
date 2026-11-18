/**
 * Regression tests for the AppState → HTTP cookie jar pipeline.
 *
 * These tests prove that a cookie set exported from a browser (AppState)
 * survives parsing, is stored under the right Facebook domain, passes the
 * required-cookie validation, and is emitted as a `Cookie` header for
 * `www.facebook.com` — the exact path the login flow uses.
 */

import { describe, expect, it, vi } from "vitest";
import { CookieError } from "../src/errors/index.js";
import { CookieStore } from "../src/auth/index.js";

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

const APP_STATE_COOKIES = [
  {
    name: "c_user",
    value: "100000000000001",
    domain: ".facebook.com",
    path: "/",
    expiresAtMs: NOW + 30 * DAY_MS,
    hostOnly: false,
    httpOnly: false,
    secure: true,
    sameSite: undefined,
  },
  {
    name: "xs",
    value: "2%3Amock-xs-token",
    domain: ".facebook.com",
    path: "/",
    expiresAtMs: NOW + 30 * DAY_MS,
    hostOnly: false,
    httpOnly: true,
    secure: true,
    sameSite: undefined,
  },
  {
    name: "datr",
    value: "mock-datr-token",
    domain: ".facebook.com",
    path: "/",
    expiresAtMs: NOW + 30 * DAY_MS,
    hostOnly: false,
    httpOnly: true,
    secure: true,
    sameSite: undefined,
  },
  {
    name: "presence",
    value: "mock-presence",
    domain: ".facebook.com",
    path: "/",
    expiresAtMs: NOW + 30 * DAY_MS,
    hostOnly: false,
    httpOnly: false,
    secure: true,
    sameSite: undefined,
  },
] as const;

describe("CookieStore", () => {
  it("passes the required-cookie validation for AppState cookies", () => {
    const store = CookieStore.fromCookies(APP_STATE_COOKIES);
    expect(store.requireAuthenticated()).toBe("100000000000001");
  });

  it("exposes the user id via getUserId()", () => {
    const store = CookieStore.fromCookies(APP_STATE_COOKIES);
    expect(store.getUserId()).toBe("100000000000001");
  });

  it("names the silently rejected cookie instead of just counting them", () => {
    const rejected = [
      ...APP_STATE_COOKIES,
      {
        // __Host- cookies must be Secure with Path=/ and NO Domain attribute;
        // this export carries a Domain, so tough-cookie rejects it silently.
        name: "__Host-bad-export",
        value: "value",
        domain: ".facebook.com",
        path: "/",
        expiresAtMs: NOW + 30 * DAY_MS,
        hostOnly: false,
        httpOnly: false,
        secure: true,
        sameSite: undefined,
      },
    ];
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    CookieStore.fromCookies(rejected);

    spy.mockRestore();
    expect(warnings.join("\n")).toContain("__Host-bad-export");
  });

  it("emits every AppState cookie as a Cookie header for www.facebook.com", () => {
    const store = CookieStore.fromCookies(APP_STATE_COOKIES);
    const header = store.headerFor("https://www.facebook.com/home.php");

    expect(header).toContain("c_user=100000000000001");
    expect(header).toContain("xs=2%3Amock-xs-token");
    expect(header).toContain("datr=mock-datr-token");
    expect(header).toContain("presence=mock-presence");
  });

  it("produces a Cookie header for other facebook.com paths too", () => {
    const store = CookieStore.fromCookies(APP_STATE_COOKIES);
    const header = store.headerFor("https://www.facebook.com/api/graphql/");

    expect(header).toContain("c_user=100000000000001");
    expect(header).not.toBe("");
  });

  it("throws CookieError when a required AppState cookie is missing", () => {
    const missingDatr = APP_STATE_COOKIES.filter((cookie) => cookie.name !== "datr");
    const store = CookieStore.fromCookies(missingDatr);

    expect(() => store.requireAuthenticated()).toThrow(CookieError);
    expect(() => store.requireAuthenticated()).toThrow(/datr/);
  });

  it("throws CookieError when a required AppState cookie is expired", () => {
    const expired = [
      ...APP_STATE_COOKIES.slice(0, 2),
      {
        ...APP_STATE_COOKIES[2],
        expiresAtMs: NOW - DAY_MS,
      },
    ];
    const store = CookieStore.fromCookies(expired);

    expect(() => store.requireAuthenticated()).toThrow(CookieError);
    expect(() => store.requireAuthenticated()).toThrow(/datr/);
  });
});
