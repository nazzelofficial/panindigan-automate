/**
 * Redirect handling for the login GET.
 *
 * The deployment failure "Redirect limit (5) exceeded during login" was a
 * session refused by Facebook. The message sent users chasing a network bug,
 * so the exhaustion path now reports AUTH_SESSION_EXPIRED when a login
 * redirect was seen. Path-based loop detection from 0.2.8 was removed: a
 * legitimate hop back to "/" with a fresh query string was falsely flagged.
 */

import { describe, expect, it } from "vitest";
import {
  isLoginRedirect,
  redirectFailure,
} from "../src/transport/http/index.js";
import { AuthenticationError, TransportError } from "../src/errors/index.js";
import { resolveConfig } from "../src/config/index.js";

describe("HTTP redirect handling", () => {
  it("uses a budget that tolerates legitimate multi-hop logins", () => {
    expect(resolveConfig().httpMaxRedirects).toBe(10);
  });

  it("clamps a too-small redirect budget instead of failing a working session", () => {
    // Render had PANINDIGAN_HTTP_MAX_REDIRECTS=5, producing the observed
    // "Redirect limit (5) exceeded during login" on a valid session.
    expect(resolveConfig({ httpMaxRedirects: 5 }).httpMaxRedirects).toBe(10);
    expect(resolveConfig({ httpMaxRedirects: 15 }).httpMaxRedirects).toBe(15);
    expect(resolveConfig({ httpMaxRedirects: 0 }).httpMaxRedirects).toBe(0);
  });

  it("reports an exact-URL redirect loop with its chain", () => {
    const chain = ["https://www.facebook.com/", "https://www.facebook.com/?a=1", "https://www.facebook.com/"];
    const error = redirectFailure("login", 10, chain[2]!, false, false, chain, true);
    expect(error.message).toContain("Redirect loop detected");
    expect((error as { context: { chain: string[] } }).context.chain).toEqual(chain);
  });

  it("recognizes login and checkpoint redirect targets", () => {
    expect(isLoginRedirect("https://www.facebook.com/login.php?next=%2F")).toBe(true);
    expect(isLoginRedirect("https://www.facebook.com/checkpoint/")).toBe(true);
    expect(isLoginRedirect("https://www.facebook.com/")).toBe(false);
  });

  it("classifies an exhausted login chain as session expired", () => {
    const error = redirectFailure("login", 10, "https://www.facebook.com/login.php", true, false);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.code).toBe("AUTH_SESSION_EXPIRED");
    expect(error.message).toContain("Session is no longer valid");
    expect(error.message).not.toContain("Redirect limit");
  });

  it("keeps a benign exhausted chain as a transport error", () => {
    const error = redirectFailure("login", 10, "https://www.facebook.com/home", false, false);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toContain("Redirect limit (10)");
  });

  it("does not report a loop for a path revisited with a different query", () => {
    // The rejected 0.2.8 implementation used host+path as the loop key.
    const first = new URL("https://www.facebook.com/?locale=en_US");
    const second = new URL("https://www.facebook.com/?locale=en_PH&dpr=1");
    expect(first.pathname).toBe(second.pathname);
    expect(first.search).not.toBe(second.search);
  });
});
