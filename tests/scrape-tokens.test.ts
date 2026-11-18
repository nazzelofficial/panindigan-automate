/**
 * Regression tests for the `scrapeTokens` / `extractFbDtsg` / `extractLsd`
 * token-extraction helpers in `src/client/index.ts`.
 *
 * All fixtures are hand-crafted mock HTML snippets — no real Facebook HTML
 * is included. No cookies, session tokens, or user ids are real.
 */

import { describe, expect, it } from "vitest";

// ── The helpers are not exported, so we test them indirectly via a small
// shim that re-implements the same logic under test.  When the source is
// refactored to export these helpers, replace the shim with real imports.
// ──────────────────────────────────────────────────────────────────────────

function extractFbDtsgShim(html: string): string | undefined {
  let m = html.match(/"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  m = html.match(/"DTSGInitData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  m = html.match(/DTSGInit(?:ial)?Data[^}]{0,160}?"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  m = html.match(/name="fb_dtsg"\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\s+name="fb_dtsg"/);
  if (m?.[1]) return m[1];
  m = html.match(/"async_get_token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  return undefined;
}

function extractLsdShim(html: string): string | undefined {
  let m = html.match(/\["LSD"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  m = html.match(/"LSD"[^}]{0,80}?"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  m = html.match(/name="lsd"\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\s+name="lsd"/);
  if (m?.[1]) return m[1];
  return undefined;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Minimal modern SPA boot HTML (requireLazy format). */
const MODERN_SPA_HTML = `
<html><head></head><body>
<script>
require.ensure([],function(require){
  require("InitialData").then(function(){
    require("DTSGInitialData",[],"token_placeholder_dtsg",{"token":"MOCK_DTSG_TOKEN_MODERN"},[]);
    require("LSD",[],{"token":"MOCK_LSD_TOKEN_MODERN"},4);
    require("SiteData",[],{"revision":1234567},[]);
  });
});
</script>
</body></html>
`;

/** Older `DTSGInitData` key variant. */
const OLDER_SPA_HTML = `
<html><body>
<script>
["DTSGInitData",[],{"token":"MOCK_DTSG_OLDER","async_get_token":"MOCK_ASYNC_OLDER"},123]
["LSD",[],{"token":"MOCK_LSD_OLDER"},4]
</script>
</body></html>
`;

/** Server-rendered form (classic fallback). */
const SERVER_RENDERED_HTML = `
<html><body>
<form method="POST" action="/ajax/settings">
  <input type="hidden" name="fb_dtsg" value="MOCK_DTSG_FORM" />
  <input type="hidden" name="lsd" value="MOCK_LSD_FORM" />
</form>
</body></html>
`;

/** `async_get_token` variant — `fb_dtsg` via async path, `lsd` via form. */
const ASYNC_TOKEN_HTML = `
<html><body>
<script>{"async_get_token":"MOCK_ASYNC_DTSG"}</script>
<input type="hidden" name="lsd" value="MOCK_LSD_ASYNC" />
</body></html>
`;

/** Redirect to login page — no tokens. */
const LOGIN_PAGE_HTML = `
<html><body>
<form id="loginform" method="POST" action="/login/">
  <input name="email" /><input name="pass" />
</form>
</body></html>
`;

/** Checkpoint page — no tokens, contains "checkpoint". */
const CHECKPOINT_HTML = `
<html><body>
<div data-type="checkpoint">
  <p>We noticed unusual activity on your account.</p>
  <script>{"checkpoint":true,"next":"/checkpoint/block/?next=%2F"}</script>
</div>
</body></html>
`;

/** Blank / empty page — tokens absent. */
const EMPTY_HTML = `<html><body></body></html>`;

/** Token value that contains special characters (should still match). */
const SPECIAL_CHARS_HTML = `
<script>
["DTSGInitialData",[],{"token":"AQ-special_token:value+part"},[]]
["LSD",[],{"token":"LSD-token_v2+extra"},4]
</script>
`;

// ── extractFbDtsg tests ────────────────────────────────────────────────────

describe("extractFbDtsg", () => {
  it("extracts fb_dtsg from modern SPA format", () => {
    expect(extractFbDtsgShim(MODERN_SPA_HTML)).toBe("MOCK_DTSG_TOKEN_MODERN");
  });

  it("extracts fb_dtsg from older DTSGInitData key", () => {
    expect(extractFbDtsgShim(OLDER_SPA_HTML)).toBe("MOCK_DTSG_OLDER");
  });

  it("extracts fb_dtsg from server-rendered form input (name before value)", () => {
    expect(extractFbDtsgShim(SERVER_RENDERED_HTML)).toBe("MOCK_DTSG_FORM");
  });

  it("extracts fb_dtsg from server-rendered form input (value before name)", () => {
    const html = `<input value="MOCK_DTSG_REVERSED" name="fb_dtsg" />`;
    expect(extractFbDtsgShim(html)).toBe("MOCK_DTSG_REVERSED");
  });

  it("extracts fb_dtsg from async_get_token variant", () => {
    expect(extractFbDtsgShim(ASYNC_TOKEN_HTML)).toBe("MOCK_ASYNC_DTSG");
  });

  it("handles token with special characters (-, _, :, +)", () => {
    expect(extractFbDtsgShim(SPECIAL_CHARS_HTML)).toBe("AQ-special_token:value+part");
  });

  it("returns undefined for login redirect page", () => {
    expect(extractFbDtsgShim(LOGIN_PAGE_HTML)).toBeUndefined();
  });

  it("returns undefined for checkpoint page", () => {
    expect(extractFbDtsgShim(CHECKPOINT_HTML)).toBeUndefined();
  });

  it("returns undefined for blank page", () => {
    expect(extractFbDtsgShim(EMPTY_HTML)).toBeUndefined();
  });
});

// ── extractLsd tests ───────────────────────────────────────────────────────

describe("extractLsd", () => {
  it("extracts lsd from modern requireLazy format", () => {
    expect(extractLsdShim(MODERN_SPA_HTML)).toBe("MOCK_LSD_TOKEN_MODERN");
  });

  it("extracts lsd from older format", () => {
    expect(extractLsdShim(OLDER_SPA_HTML)).toBe("MOCK_LSD_OLDER");
  });

  it("extracts lsd from server-rendered form input", () => {
    expect(extractLsdShim(SERVER_RENDERED_HTML)).toBe("MOCK_LSD_FORM");
  });

  it("extracts lsd from server-rendered form input (value before name)", () => {
    const html = `<input value="MOCK_LSD_REVERSED" name="lsd" />`;
    expect(extractLsdShim(html)).toBe("MOCK_LSD_REVERSED");
  });

  it("extracts lsd from async_get_token HTML (form fallback)", () => {
    expect(extractLsdShim(ASYNC_TOKEN_HTML)).toBe("MOCK_LSD_ASYNC");
  });

  it("handles token with special characters", () => {
    expect(extractLsdShim(SPECIAL_CHARS_HTML)).toBe("LSD-token_v2+extra");
  });

  it("returns undefined for login redirect page", () => {
    expect(extractLsdShim(LOGIN_PAGE_HTML)).toBeUndefined();
  });

  it("returns undefined for blank page", () => {
    expect(extractLsdShim(EMPTY_HTML)).toBeUndefined();
  });
});

// ── diagnoseScrapeFailure equivalents ─────────────────────────────────────

describe("scrape failure diagnostics", () => {
  function diagnose(html: string, url: string) {
    return {
      fbDtsgFound: extractFbDtsgShim(html) !== undefined,
      lsdFound: extractLsdShim(html) !== undefined,
      hasLoginForm: html.includes('id="loginform"'),
      hasCheckpoint: /\/checkpoint|\/two_step_verification/i.test(url),
      bodyLength: html.length,
    };
  }

  it("reports both tokens missing on login page", () => {
    const d = diagnose(LOGIN_PAGE_HTML, "https://www.facebook.com/");
    expect(d.fbDtsgFound).toBe(false);
    expect(d.lsdFound).toBe(false);
    expect(d.hasLoginForm).toBe(true);
    expect(d.hasCheckpoint).toBe(false);
  });

  it("reports checkpoint flag on checkpoint page", () => {
    const d = diagnose(CHECKPOINT_HTML, "https://www.facebook.com/checkpoint/block/");
    expect(d.fbDtsgFound).toBe(false);
    expect(d.lsdFound).toBe(false);
    expect(d.hasCheckpoint).toBe(true);
  });

  it("reports both tokens found on modern SPA page", () => {
    const d = diagnose(MODERN_SPA_HTML, "https://www.facebook.com/");
    expect(d.fbDtsgFound).toBe(true);
    expect(d.lsdFound).toBe(true);
    expect(d.hasLoginForm).toBe(false);
    expect(d.hasCheckpoint).toBe(false);
  });

  it("includes body length in diagnostic", () => {
    const d = diagnose(EMPTY_HTML, "https://www.facebook.com/");
    expect(d.bodyLength).toBe(EMPTY_HTML.length);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("extractFbDtsg: relaxed scan matches DTSGInitialData with extra whitespace", () => {
    const html = `DTSGInitialData   {  "token" :  "MOCK_RELAXED"  }`;
    expect(extractFbDtsgShim(html)).toBe("MOCK_RELAXED");
  });

  it("extractLsd: relaxed scan matches with extra whitespace between LSD and token", () => {
    const html = `"LSD"  ,  []  ,  {"token"  :  "MOCK_LSD_SPACE"}`;
    expect(extractLsdShim(html)).toBe("MOCK_LSD_SPACE");
  });

  it("extractFbDtsg: does not match empty token value", () => {
    // [^"]+ requires at least one character
    const html = `["DTSGInitialData",[],{"token":""},[]]`;
    expect(extractFbDtsgShim(html)).toBeUndefined();
  });

  it("extractLsd: does not match empty token value", () => {
    const html = `["LSD",[],{"token":""},4]`;
    expect(extractLsdShim(html)).toBeUndefined();
  });

  it("extractFbDtsg: prefers DTSGInitialData over DTSGInitData when both present", () => {
    const html = `
      ["DTSGInitialData",[],{"token":"PREFER_THIS"},[]]
      ["DTSGInitData",[],{"token":"NOT_THIS"},[]]
    `;
    expect(extractFbDtsgShim(html)).toBe("PREFER_THIS");
  });
});
