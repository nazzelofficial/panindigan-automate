/**
 * Regression tests for the home-page diagnostics used by the login flow.
 *
 * The fixtures are trimmed down from the real pages observed against
 * Facebook in November 2026 — no cookies, tokens, or account ids are real.
 */

import { describe, expect, it } from "vitest";
import {
  extractFacebookApiError,
  extractSessionTokens,
  isLoggedOutHomePage,
  safeHomeDiagnostics,
  summarizeHomeDiagnostics,
} from "../src/client/index.js";

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

  it("reports the literal URL when it cannot be parsed (no vague 'unknown')", () => {
    const diag = safeHomeDiagnostics(UNKNOWN_PAGE, "not a url", 200);
    expect(diag.path).toBe("not a url");
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

describe("extractFacebookApiError", () => {
  it("maps Facebook's small unauthenticated error envelope to an AuthenticationError", () => {
    const error = extractFacebookApiError(
      '{"error":1357001,"errorSummary":"Not logged in","errorDescription":"Not logged in","errorIsRetryable":false}',
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain("Not logged in");
    expect(error?.code).toBe("AUTH_LOGIN_REJECTED");
  });

  it("strips Facebook's anti-hijacking prefix before interpreting", () => {
    const error = extractFacebookApiError(
      'for (;;);{"error":1357001,"errorSummary":"Not logged in","errorIsRetryable":false}',
    );

    expect(error?.message).toContain("Not logged in");
  });

  it("returns null for HTML pages (they are not API errors)", () => {
    expect(extractFacebookApiError(LOGGED_OUT_SPLASH)).toBeNull();
    expect(extractFacebookApiError(AUTHENTICATED_SPA)).toBeNull();
  });

  it("returns null for JSON payloads without an error marker", () => {
    expect(extractFacebookApiError('{"ok":true}')).toBeNull();
  });

  it("maps a checkpoint-ish error envelope to a permission-style error", () => {
    const error = extractFacebookApiError('{"error":1357031}');
    expect(error).not.toBeNull();
    expect(error?.code).toBe("PERMISSION_BLOCKED");
  });

  it("maps the exact production envelope (error 1357004) to AUTH_REFRESH_REQUIRED", () => {
    const error = extractFacebookApiError(
      '{"error":1357004,"errorSummary":"Please Refresh","errorDescription":"Please try closing and re-opening your browser window.","errorIsRetryable":true}',
    );

    expect(error).not.toBeNull();
    expect(error?.code).toBe("AUTH_REFRESH_REQUIRED");
    expect(error?.message).toContain("Session needs refresh");
  });

  it("maps error 1357004 even with Facebook's anti-hijacking prefix", () => {
    const error = extractFacebookApiError('for (;;);{"error":1357004}');
    expect(error?.code).toBe("AUTH_REFRESH_REQUIRED");
  });
});

describe("extractSessionTokens", () => {
  it("scrapes fb_dtsg from the server-rendered hidden inputs", () => {
    const html =
      '<html><body><form><input type="hidden" name="fb_dtsg" value="AbCdEf123_TOKEN" autocomplete="off" />' +
      '<input type="hidden" name="jazoest" value="28911" autocomplete="off" /></form></body></html>';

    const tokens = extractSessionTokens(html);
    expect(tokens).not.toBeNull();
    expect(tokens?.fbDtsg).toBe("AbCdEf123_TOKEN");
    // jazoest is always derived from fb_dtsg, never scraped
    expect(tokens?.jazoest).toMatch(/^2\d+$/);
  });

  it("derives jazoest from fb_dtsg (sum of char codes, prefixed with 2)", () => {
    const html = '<input type="hidden" name="fb_dtsg" value="abc123XYZ_TOKEN" />';

    const tokens = extractSessionTokens(html);
    expect(tokens).not.toBeNull();
    expect(tokens?.fbDtsg).toBe("abc123XYZ_TOKEN");
    expect(tokens?.jazoest).toMatch(/^2\d+$/);
  });

  it("returns null when there is no fb_dtsg hidden input", () => {
    expect(extractSessionTokens("<html><body>nothing</body></html>")).toBeNull();
  });

  it("returns null when fb_dtsg is present but empty", () => {
    expect(extractSessionTokens('<input type="hidden" name="fb_dtsg" value="" />')).toBeNull();
  });

  it("scrapes fb_dtsg from the modern DTSGInitialData requireLazy payload", () => {
    const html =
      '<script>{"require":[["DTSGInitialData",[],{"token":"26031076_MOCK_DTSG_TOKEN_1234567890"}]]}</script>';

    const tokens = extractSessionTokens(html);
    expect(tokens).not.toBeNull();
    expect(tokens?.fbDtsg).toBe("26031076_MOCK_DTSG_TOKEN_1234567890");
  });

  it("scrapes fb_dtsg from the older DTSGInitData key variant", () => {
    const html = '<script>["DTSGInitData",[],{"token":"26031076_MOCK_DTSG_TOKEN_1234567890"}]</script>';

    const tokens = extractSessionTokens(html);
    expect(tokens).not.toBeNull();
    expect(tokens?.fbDtsg).toBe("26031076_MOCK_DTSG_TOKEN_1234567890");
  });

  it("returns null for a bare token-shaped value with no DTSG context", () => {
    // Regression: an earlier implementation matched any `"token": "<20+ chars>"`
    // anywhere in the page, which reported a successful refresh on pages that
    // carried no session tokens at all.
    const html =
      '<html><body><script>{"require":[["SomeOtherModule",[],{"token":"AAsfQkpTOVjFBBWtGLesU0QY1gX9XYZ123"}]]}</script></body></html>';

    expect(extractSessionTokens(html)).toBeNull();
  });

  it("returns null for the exact production 1357004 error envelope", () => {
    // The response Facebook actually served the deployment: HTTP 200,
    // ~249 bytes, JSON error envelope. No tokens exist in it.
    const envelope =
      '{"error":1357004,"errorSummary":"Please Refresh","errorDescription":"Please try closing and re-opening your browser window.","errorIsRetryable":true}';

    expect(extractSessionTokens(envelope)).toBeNull();
    expect(extractFacebookApiError(envelope)?.code).toBe("AUTH_REFRESH_REQUIRED");
  });

  it("handles real-world mobile surface HTML structure", () => {
    // Trimmed from actual m.facebook.com response observed Nov 2026
    const html = `
      <form method="post" action="/login/?next&ref=dbl" id="login_form">
        <input type="hidden" name="lsd" value="AVpU_LSD" autocomplete="off" />
        <input type="hidden" name="jazoest" value="21234" autocomplete="off" />
        <input type="hidden" name="m_ts" value="1700000000" />
        <input type="hidden" name="li" value="xyz" />
        <input type="hidden" name="try_number" value="0" />
        <input type="hidden" name="unrecognized_tries" value="0" />
        <input type="hidden" name="bi_xrwh" value="0" />
        <input type="hidden" name="fb_dtsg" value="RealToken123_456_7890:abc:def" />
      </form>
    `;

    const tokens = extractSessionTokens(html);
    expect(tokens).not.toBeNull();
    expect(tokens?.fbDtsg).toBe("RealToken123_456_7890:abc:def");
    expect(tokens?.jazoest).toMatch(/^2\d+$/);
  });
});
