/**
 * Regression tests for the home-page diagnostics used by the login flow.
 *
 * The fixtures are trimmed down from the real pages observed against
 * Facebook in November 2026 — no cookies, tokens, or account ids are real.
 */

import { describe, expect, it } from "vitest";
import {
  isLoggedOutHomePage,
  safeHomeDiagnostics,
  summarizeHomeDiagnostics,
} from "../src/client/home.js";

/** Facebook's logged-out SSR splash: empty MqttWebConfig with fbid "0". */
const LOGGED_OUT_SPLASH = `<html><body><script>require("Bootloader")(["MqttWebConfig",[],{"fbid":"0","appID":219994525426954,"endpoint":""}])</script></body></html>`;

/** A minimal page carrying the modern requireLazy token payload (as served live). */
const AUTHENTICATED_SPA = `<html><body><script>{"require":[["DTSGInitialData",[],{"token":"MOCK_TOKEN"}],["LSD",[],{"token":"MOCK_LSD"}]]}</script></body></html>`;

/** A page with no identifiers at all. */
const UNKNOWN_PAGE = `<html><body></body></html>`;

/** A checkpoint challenge page. */
const CHECKPOINT_PAGE = `<html><body><script>{"checkpoint":true}</script></body></html>`;

describe("isLoggedOutHomePage", () => {
  it("detects Facebook's logged-out splash screen", () => {
    expect(isLoggedOutHomePage(LOGGED_OUT_SPLASH)).toBe(true);
  });

  it("does not misfire on an authenticated boot page", () => {
    expect(isLoggedOutHomePage(AUTHENTICATED_SPA)).toBe(false);
  });

  it("does not misfire on an empty page", () => {
    expect(isLoggedOutHomePage(UNKNOWN_PAGE)).toBe(false);
  });
});

describe("safeHomeDiagnostics", () => {
  it("reports no token markers on the logged-out splash", () => {
    const diag = safeHomeDiagnostics(LOGGED_OUT_SPLASH, "https://www.facebook.com/home.php", 200);

    expect(diag.status).toBe(200);
    expect(diag.path).toBe("/home.php");
    expect(diag.contentLength).toBe(LOGGED_OUT_SPLASH.length);
    expect(diag.mqttWebConfigEmpty).toBe(true);
    expect(diag.fbDtsgPresent).toBe(false);
    expect(diag.lsdPresent).toBe(false);
    expect(diag.hasLoginForm).toBe(false);
    expect(diag.hasCheckpoint).toBe(false);
  });

  it("reports token payloads present on an authenticated boot page", () => {
    const diag = safeHomeDiagnostics(AUTHENTICATED_SPA, "https://www.facebook.com/home.php", 200);

    expect(diag.mqttWebConfigEmpty).toBe(false);
    expect(diag.fbDtsgPresent).toBe(true);
    expect(diag.lsdPresent).toBe(true);
  });

  it("detects checkpoint pages", () => {
    const diag = safeHomeDiagnostics(CHECKPOINT_PAGE, "https://www.facebook.com/checkpoint/block/", 200);
    expect(diag.hasCheckpoint).toBe(true);
  });

  it("keeps an unknown path when the URL cannot be parsed", () => {
    const diag = safeHomeDiagnostics(UNKNOWN_PAGE, "not a url", 200);
    expect(diag.path).toBe("unknown");
  });
});

describe("summarizeHomeDiagnostics", () => {
  it("produces a single-line safe summary that leaks nothing", () => {
    const diag = safeHomeDiagnostics(LOGGED_OUT_SPLASH, "https://www.facebook.com/home.php", 200);
    const summary = summarizeHomeDiagnostics(diag);

    expect(summary).toContain("status=200");
    expect(summary).toContain("mqttWebConfigEmpty=true");
    expect(summary).toContain("path=/home.php");
  });
});
