/**
 * Redirect handling for the login GET.
 *
 * The deployment failure "Redirect limit (5) exceeded during login" was a
 * session refused by Facebook, but the message sent users chasing a network
 * bug. These tests pin the corrected classification and the larger budget.
 */

import { describe, expect, it } from "vitest";
import {
  isLoginRedirect,
  redirectKey,
  redirectFailure,
} from "../src/transport/http/index.js";
import { AuthenticationError, TransportError } from "../src/errors/index.js";
import { resolveConfig } from "../src/config/index.js";

describe("HTTP redirect handling", () => {
  it("uses a budget that tolerates legitimate multi-hop logins", () => {
    expect(resolveConfig().httpMaxRedirects).toBe(10);
  });

  it("recognizes login and checkpoint redirect targets", () => {
    expect(isLoginRedirect("https://www.facebook.com/login.php?next=%2F")).toBe(true);
    expect(isLoginRedirect("https://www.facebook.com/checkpoint/")).toBe(true);
    expect(isLoginRedirect("https://www.facebook.com/")).toBe(false);
  });

  it("ignores churning query strings when detecting loops", () => {
    expect(redirectKey("https://www.facebook.com/?a=1")).toBe(
      redirectKey("https://www.facebook.com/?a=2"),
    );
  });

  it("classifies a login redirect loop as session expired", () => {
    const error = redirectFailure("login", 10, "https://www.facebook.com/login.php", true, false, true);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.code).toBe("AUTH_SESSION_EXPIRED");
    expect(error.message).toContain("Session is no longer valid");
    expect(error.message).not.toContain("Redirect limit");
  });

  it("keeps a benign exhausted chain as a transport error", () => {
    const error = redirectFailure("login", 10, "https://www.facebook.com/home", false, false, false);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toContain("Redirect limit (10)");
  });

  it("reports loops distinctly from exhausted limits", () => {
    const error = redirectFailure("stream", 10, "https://www.facebook.com/", false, true, true);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.message).toContain("Redirect loop");
  });
});
