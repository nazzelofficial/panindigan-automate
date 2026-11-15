// Patch script: replaces the scrapeTokens block in src/client/index.ts
// with the improved multi-pattern extraction version.
import fs from "node:fs";
const FILE = "src/client/index.ts";

let src = fs.readFileSync(FILE, "utf8");

// Locate the block: from "/** Scrapes the session tokens …" to end of scrapeTokens function
const startMarker = "/** Scrapes the session tokens Facebook embeds in `home.php`. */";
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error("ERROR: cannot find scrapeTokens marker");
  process.exit(1);
}

// Find the closing } of the function (after the marker)
// Count braces from function opening
let braceDepth = 0;
let funcStart = src.indexOf("function scrapeTokens(", startIdx);
let funcBodyStart = src.indexOf("{", funcStart);
let i = funcBodyStart;
while (i < src.length) {
  if (src[i] === "{") braceDepth++;
  else if (src[i] === "}") {
    braceDepth--;
    if (braceDepth === 0) break;
  }
  i++;
}
const endIdx = i + 1; // inclusive of closing }

const oldBlock = src.slice(startIdx, endIdx);
console.log("Found block to replace, length:", oldBlock.length);
console.log("First 80 chars:", JSON.stringify(oldBlock.slice(0, 80)));

const newBlock = `/**
 * Extracts \`fb_dtsg\` from any of the known boot-payload patterns Facebook
 * has used across different surface generations.
 *
 * Priority order (most-to-least current):
 *   1. \`"DTSGInitialData",[],{"token":"…"}\` — modern requireLazy SPA format
 *   2. \`"DTSGInitData",[],{"token":"…"}\`    — older variant (pre-2024)
 *   3. Relaxed scan: \`DTSGInit*Data\` near \`"token"\` within 160 chars
 *   4. \`fb_dtsg" value="…"\`                 — legacy server-rendered form field
 *   5. \`"async_get_token":"…"\`               — async-loaded variant
 */
function extractFbDtsg(html: string): string | undefined {
  // 1. Modern requireLazy: ["DTSGInitialData",[],"token":"…"}
  let m = html.match(/"DTSGInitialData"\\s*,\\s*\\[\\s*\\]\\s*,\\s*\\{\\s*"token"\\s*:\\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 2. Older key variant
  m = html.match(/"DTSGInitData"\\s*,\\s*\\[\\s*\\]\\s*,\\s*\\{\\s*"token"\\s*:\\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 3. Relaxed scan — key anywhere before "token" within 160 chars
  m = html.match(/DTSGInit(?:ial)?Data[^}]{0,160}?"token"\\s*:\\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 4. Server-rendered hidden input (name before value and vice-versa)
  m = html.match(/name="fb_dtsg"\\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\\s+name="fb_dtsg"/);
  if (m?.[1]) return m[1];
  // 5. async_get_token variant
  m = html.match(/"async_get_token"\\s*:\\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  return undefined;
}

/**
 * Extracts the \`lsd\` token from the boot payload.
 * Facebook embeds this in the \`requireLazy("LSD", …)\` call.
 */
function extractLsd(html: string): string | undefined {
  // 1. requireLazy array — \`["LSD",[],{"token":"…"},…]\`
  let m = html.match(/\\["LSD"\\s*,\\s*\\[\\s*\\]\\s*,\\s*\\{\\s*"token"\\s*:\\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 2. Relaxed scan — "LSD" key near "token" within 80 chars
  m = html.match(/"LSD"[^}]{0,80}?"token"\\s*:\\s*"([^"]+)"/);
  if (m?.[1]) return m[1];
  // 3. Server-rendered hidden input
  m = html.match(/name="lsd"\\s+value="([^"]+)"/) ?? html.match(/value="([^"]+)"\\s+name="lsd"/);
  if (m?.[1]) return m[1];
  return undefined;
}

/**
 * Returns a human-readable, non-sensitive diagnostic object describing which
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

/** Scrapes the session tokens Facebook embeds in \`home.php\`. */
function scrapeTokens(html: string, userId: string): ScrapedTokens | null {
  const fbDtsg = extractFbDtsg(html);
  const lsd = extractLsd(html);
  if (fbDtsg === undefined || lsd === undefined) {
    return null;
  }
  const revisionMatch = html.match(/"revision":(\\d+)/);
  const clientMatch = html.match(/"clientID":"(.*?)"/) ?? html.match(/"client_id":"(.*?)"/);
  return {
    fbDtsg,
    lsd,
    revision: revisionMatch?.[1] ?? null,
    clientId: clientMatch?.[1] !== undefined && clientMatch[1] !== "" ? clientMatch[1] : randomClientId(),
    region: extractRegion(html),
    irisSeqId: extractIrisSeqId(html),
  };
}`;

const patched = src.slice(0, startIdx) + newBlock + src.slice(endIdx);

// sanity checks
if (!patched.includes("extractFbDtsg")) throw new Error("missing extractFbDtsg");
if (!patched.includes("extractLsd")) throw new Error("missing extractLsd");
if (!patched.includes("diagnoseScrapeFailure")) throw new Error("missing diagnoseScrapeFailure");
const count = (patched.match(/function scrapeTokens/g) || []).length;
if (count !== 1) throw new Error("duplicate scrapeTokens: " + count);

fs.writeFileSync(FILE, patched, "utf8");
console.log("OK – scrapeTokens block patched successfully");
