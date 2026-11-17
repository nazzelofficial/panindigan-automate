/**
 * Safe home-page diagnostics for the login flow.
 *
 * These helpers exist so the login path can say *exactly* what Facebook
 * served without ever exposing cookie values, session tokens, or raw HTML.
 * The reported deployment hit `AuthenticationError: Could not read Facebook's
 * session tokens from the home page` with no further detail — because the
 * logged-out page carries no tokens and the old logging only ran at `debug`
 * level. Everything here is always observable.
 */

import { computeJazoest, interpretFacebookError, parseFacebookJson } from "../transport/http/index.js";
import type { LibraryError } from "../errors/index.js";

/** Boolean summary of what the home page contains. Never includes values. */
export interface HomePageDiagnostics {
  /** HTTP status code of the home/refresh request. */
  readonly status: number;
  /** Path component of the final URL only (no query string, no tokens). */
  readonly path: string;
  /** Response body length in bytes. */
  readonly contentLength: number;
  /** True when MqttWebConfig is empty (`fbid:"0"`) — Facebook's logged-out splash screen. */
  readonly mqttWebConfigEmpty: boolean;
  /** True when the page mentions an `fb_dtsg` token payload. */
  readonly fbDtsgPresent: boolean;
  /** True when the page mentions an `LSD` token payload. */
  readonly lsdPresent: boolean;
  /** True when the page carries a login form marker. */
  readonly hasLoginForm: boolean;
  /** True when the page carries a checkpoint marker. */
  readonly hasCheckpoint: boolean;
}

/**
 * Detects Facebook's logged-out splash screen, which carries an empty
 * `MqttWebConfig` (`"fbid":"0"`). A valid session always gets a non-zero
 * fbid, so this is a reliable, value-free session-rejection signal.
 */
export function isLoggedOutHomePage(html: string): boolean {
  return /"MqttWebConfig"\s*,\s*\[\s*\]\s*,\s*\{\s*"fbid"\s*:\s*"0"/.test(html);
}

/** Collects the safe boolean summary of a home page response. */
export function safeHomeDiagnostics(
  html: string,
  url: string,
  status: number,
): HomePageDiagnostics {
  let path = "unknown";
  try {
    path = new URL(url).pathname;
  } catch {
    // Keep the pathname fallback readable and value-free.
  }

  return {
    status,
    path,
    contentLength: html.length,
    mqttWebConfigEmpty: isLoggedOutHomePage(html),
    fbDtsgPresent:
      /DTSGInit(?:ial)?Data"\s*,\s*\[\s*\]\s*,/.test(html) || /name="fb_dtsg"/i.test(html),
    lsdPresent: /\["LSD"\s*,\s*\[\s*\]\s*,/.test(html) || /name="lsd"/i.test(html),
    hasLoginForm:
      /id="loginform"/i.test(html) ||
      /id="login_form"/i.test(html) ||
      /id="loginForm"/i.test(html),
    hasCheckpoint: /checkpoint|two_step_verification/i.test(html),
  };
}

/** One-line, safe summary suitable for log lines and error messages. */
export function summarizeHomeDiagnostics(diagnostics: HomePageDiagnostics): string {
  return [
    `status=${diagnostics.status}`,
    `path=${diagnostics.path}`,
    `bytes=${diagnostics.contentLength}`,
    `mqttWebConfigEmpty=${diagnostics.mqttWebConfigEmpty}`,
    `fbDtsg=${diagnostics.fbDtsgPresent}`,
    `lsd=${diagnostics.lsdPresent}`,
    `loginForm=${diagnostics.hasLoginForm}`,
    `checkpoint=${diagnostics.hasCheckpoint}`,
  ].join(" ");
}

/**
 * Detects Facebook's structured JSON error envelope (`{"error":1357001,…}`).
 *
 * Unauthenticated requests to `www.facebook.com/home.php` that are not
 * treated as browser HTML navigations come back as a small JSON error
 * document instead of a page — an actual response body seen in production.
 * Returns the mapped `LibraryError` when the body carries one, or `null`
 * otherwise (e.g. a real HTML page). Never throws.
 */
export function extractFacebookApiError(body: string): LibraryError | null {
  const parsed = parseFacebookJson(body);
  if (parsed === null) {
    return null;
  }
  return interpretFacebookError("home", parsed);
}

/** Shape of the fresh tokens scraped from the mobile surface. */
export interface MobileTokens {
  readonly fbDtsg: string;
  readonly jazoest: string;
}

/**
 * @deprecated This function is no longer used internally as of v0.1.7.
 * Mobile token refresh does not work for expired sessions in modern Facebook.
 * Kept for backward compatibility only.
 * 
 * Scrapes `fb_dtsg` and `jazoest` from the server-rendered mobile surface
 * (`m.facebook.com/`). Facebook renders these as hidden inputs, which is how
 * the web/mobile clients refresh stale sessions (error 1357004).
 */
export function extractMobileTokens(html: string): MobileTokens | null {
  const fbDtsg = html.match(/name="fb_dtsg"\s+value="([^"]+)"/)?.[1];
  if (fbDtsg === undefined || fbDtsg === "") {
    return null;
  }
  const jazoest =
    html.match(/name="jazoest"\s+value="([^"]+)"/)?.[1] ?? computeJazoest(fbDtsg);
  return { fbDtsg, jazoest };
}
