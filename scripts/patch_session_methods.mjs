// Patch #scrapeTokens and #refreshCookies methods for improved
// checkpoint detection and diagnostic logging.
import fs from "node:fs";
const FILE = "src/client/index.ts";
let src = fs.readFileSync(FILE, "utf8");

// ── Patch 1: #scrapeTokens ─────────────────────────────────────────────────
const OLD_SCRAPE = `  async #scrapeTokens(http: HttpTransport): Promise<ScrapedTokens> {
    const response = await http.get("login", \`\${FB_BASE_URL}/home.php\`);
    if (response.url.includes("/login") || response.body.includes('id="loginform"')) {
      throw new AuthenticationError(
        "Facebook rejected the session and redirected to the login page",
        "AUTH_SESSION_EXPIRED",
        { retryable: false, context: { operation: "login", url: response.url } },
      );
    }
    const tokens = scrapeTokens(response.body, this.#requireUserId());
    if (tokens === null) {
      throw new AuthenticationError(
        "Could not read Facebook's session tokens from the home page",
        "AUTH_LOGIN_REJECTED",
        { retryable: false, context: { operation: "login" } },
      );
    }
    return tokens;
  }`;

const NEW_SCRAPE = `  async #scrapeTokens(http: HttpTransport): Promise<ScrapedTokens> {
    const response = await http.get("login", \`\${FB_BASE_URL}/home.php\`);
    // Detect session-expired and checkpoint redirects without exposing raw HTML.
    const isLoginPage =
      response.url.includes("/login") ||
      response.url.includes("/checkpoint") ||
      response.url.includes("/two_step_verification") ||
      response.body.includes('id="loginform"') ||
      /"checkpoint"/.test(response.body) ||
      /"CHECKPOINT"/.test(response.body);
    if (isLoginPage) {
      const isCheckpoint =
        response.url.includes("/checkpoint") ||
        response.url.includes("/two_step_verification") ||
        /"checkpoint"/i.test(response.body);
      throw new AuthenticationError(
        isCheckpoint
          ? "Facebook requires a security checkpoint — log in via a browser to clear it"
          : "Facebook rejected the session and redirected to the login page",
        "AUTH_SESSION_EXPIRED",
        {
          retryable: false,
          context: {
            operation: "login",
            url: response.url,
            isCheckpoint,
          },
        },
      );
    }
    const tokens = scrapeTokens(response.body, this.#requireUserId());
    if (tokens === null) {
      // Include non-sensitive diagnostics to help diagnose which token was absent.
      const diag = diagnoseScrapeFailure(response.body);
      this.#logger.debug(
        { operation: "login", ...diag },
        "token scrape failed — see context for which tokens were missing",
      );
      throw new AuthenticationError(
        "Could not read Facebook's session tokens from the home page",
        "AUTH_LOGIN_REJECTED",
        {
          retryable: false,
          context: { operation: "login", ...diag },
        },
      );
    }
    this.#logger.debug(
      { operation: "login", region: tokens.region, hasIrisSeqId: tokens.irisSeqId !== null },
      "session tokens scraped",
    );
    return tokens;
  }`;

if (!src.includes(OLD_SCRAPE)) {
  console.error("ERROR: cannot find #scrapeTokens block");
  process.exit(1);
}
src = src.replace(OLD_SCRAPE, NEW_SCRAPE);
console.log("Patched #scrapeTokens");

// ── Patch 2: #refreshCookies checkpoint detection ──────────────────────────
const OLD_REFRESH = `    if (response.url.includes("/login")) {
      this.#handleSessionExpired("expired");
      throw new AuthenticationError(
        "Facebook redirected the session to the login page during cookie refresh",
        "AUTH_SESSION_EXPIRED",
        { retryable: true, context: { operation: "cookieRefresh" } },
      );
    }
    const tokens = scrapeTokens(response.body, this.#requireUserId());
    if (tokens === null) {
      throw new AuthenticationError(
        "Could not refresh Facebook's session tokens",
        "AUTH_LOGIN_REJECTED",
        { retryable: true, context: { operation: "cookieRefresh" } },
      );
    }`;

const NEW_REFRESH = `    const isExpiredPage =
      response.url.includes("/login") ||
      response.url.includes("/checkpoint") ||
      response.url.includes("/two_step_verification") ||
      response.body.includes('id="loginform"');
    if (isExpiredPage) {
      this.#handleSessionExpired("expired");
      throw new AuthenticationError(
        "Facebook redirected the session during cookie refresh",
        "AUTH_SESSION_EXPIRED",
        { retryable: true, context: { operation: "cookieRefresh", url: response.url } },
      );
    }
    const tokens = scrapeTokens(response.body, this.#requireUserId());
    if (tokens === null) {
      const diag = diagnoseScrapeFailure(response.body);
      throw new AuthenticationError(
        "Could not refresh Facebook's session tokens",
        "AUTH_LOGIN_REJECTED",
        { retryable: true, context: { operation: "cookieRefresh", ...diag } },
      );
    }`;

if (!src.includes(OLD_REFRESH)) {
  console.error("ERROR: cannot find #refreshCookies block");
  process.exit(1);
}
src = src.replace(OLD_REFRESH, NEW_REFRESH);
console.log("Patched #refreshCookies");

fs.writeFileSync(FILE, src, "utf8");
console.log("OK – both patches applied");
