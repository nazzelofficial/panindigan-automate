"""
Patch script: replaces the scrapeTokens block in src/client/index.ts
with the improved multi-pattern extraction version.
"""

import re, sys

FILE = r"src\client\index.ts"

with open(FILE, encoding="utf-8") as f:
    src = f.read()

# ── locate the block we are replacing ─────────────────────────────────────────
# From "/** Scrapes the session tokens …" through the closing "}" of scrapeTokens
START_MARKER = "/** Scrapes the session tokens Facebook embeds in `home.php`. */"
END_PATTERN  = re.compile(
    r"/\*\* Scrapes the session tokens Facebook embeds in `home\.php`\. \*/\n"
    r"function scrapeTokens\(html: string, userId: string\): ScrapedTokens \| null \{.*?\n\}",
    re.DOTALL,
)

m = END_PATTERN.search(src)
if not m:
    print("ERROR: could not find scrapeTokens block – aborting", file=sys.stderr)
    sys.exit(1)

REPLACEMENT = """\
/**
 * Extracts `fb_dtsg` from any of the known boot-payload patterns Facebook
 * has used across different surface generations.
 *
 * Priority order (most-to-least current):
 *   1. `"DTSGInitialData",[],{"token":"…"}` — modern requireLazy SPA format
 *   2. `"DTSGInitData",[],{"token":"…"}`    — older variant (pre-2024)
 *   3. Relaxed scan: `DTSGInit*Data` near `"token"` within 160 chars
 *   4. `fb_dtsg" value="…"`                 — legacy server-rendered form field
 *   5. `"async_get_token":"…"`               — async-loaded variant
 */
function extractFbDtsg(html: string): string | undefined {
  // 1. Modern requireLazy: ["DTSGInitialData",[],"token":"…"}
  let m = html.match(/"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 2. Older key variant
  m = html.match(/"DTSGInitData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 3. Relaxed scan — key anywhere before "token" within 160 chars
  m = html.match(/DTSGInit(?:ial)?Data[^}]{0,160}?"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 4. Server-rendered hidden input (name before value and vice-versa)
  m = html.match(/name="fb_dtsg"\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\s+name="fb_dtsg"/);
  if (m?.[1]) return m[1];
  // 5. async_get_token variant
  m = html.match(/"async_get_token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  return undefined;
}

/**
 * Extracts the `lsd` token from the boot payload.
 * Facebook embeds this in the `requireLazy("LSD", …)` call.
 */
function extractLsd(html: string): string | undefined {
  // 1. requireLazy array — `["LSD",[],{"token":"…"},…]`
  let m = html.match(/\["LSD"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 2. Relaxed scan — "LSD" key near "token" within 80 chars
  m = html.match(/"LSD"[^}]{0,80}?"token"\s*:\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 3. Server-rendered hidden input
  m = html.match(/name="lsd"\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\s+name="lsd"/);
  if (m?.[1]) return m[1];
  return undefined;
}

/**
 * Returns a human-readable, non-sensitive diagnostic string describing which
 * tokens were absent when extraction failed. No cookie or token values are
 * included — only boolean presence flags and metadata.
 */
function diagnoseScrapeFailure(html: string): Record<string, unknown> {
  return {
    fbDtsgFound: extractFbDtsg(html) !== undefined,
    lsdFound: extractLsd(html) !== undefined,
    hasLoginForm: html.includes('id="loginform"'),
    hasCheckpoint: /checkpoint|two_step_verification/i.test(html),
    bodyLength: html.length,
  };
}

/** Scrapes the session tokens Facebook embeds in `home.php`. */
function scrapeTokens(html: string, userId: string): ScrapedTokens | null {
  const fbDtsg = extractFbDtsg(html);
  const lsd = extractLsd(html);
  if (fbDtsg === undefined || lsd === undefined) {
    return null;
  }
  const revisionMatch = html.match(/"revision":(\d+)/);
  const clientMatch = html.match(/"clientID":"(.*?)"/) ?? html.match(/"client_id":"(.*?)"/);
  return {
    fbDtsg,
    lsd,
    revision: revisionMatch?.[1] ?? null,
    clientId: clientMatch?.[1] !== undefined && clientMatch[1] !== "" ? clientMatch[1] : randomClientId(),
    region: extractRegion(html),
    irisSeqId: extractIrisSeqId(html),
  };
}\
"""

patched = src[: m.start()] + REPLACEMENT + src[m.end() :]

# quick sanity check
assert "extractFbDtsg" in patched, "patch missing extractFbDtsg"
assert "extractLsd" in patched, "patch missing extractLsd"
assert "diagnoseScrapeFailure" in patched, "patch missing diagnoseScrapeFailure"
assert patched.count("function scrapeTokens") == 1, "duplicate scrapeTokens"

with open(FILE, "w", encoding="utf-8") as f:
    f.write(patched)

print("OK – scrapeTokens block patched successfully")
