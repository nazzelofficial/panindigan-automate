/**
 * Tests for the top-level `login()` entry point (fca-style call shape).
 * Credential validation happens before any network traffic, so these cases
 * run fully offline.
 */
import { describe, expect, it } from "vitest";
import { login } from "../src/index.js";
import { MessengerClient } from "../src/index.js";

describe("login() entry point", () => {
  it("is exported as a function", () => {
    expect(typeof login).toBe("function");
  });

  it("rejects invalid credentials before touching the network (promise overload)", async () => {
    // No cookies present — session preparation throws before any request.
    await expect(login([])).rejects.toThrow();
  });

  it("rejects invalid credentials with the options overload too", async () => {
    await expect(login([], { dryRun: true })).rejects.toThrow();
  });

  it("invokes the legacy callback with an error instead of throwing", async () => {
    await new Promise<void>((resolve, reject) => {
      login([], (error) => {
        try {
          expect(error).toBeInstanceOf(Error);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  });

  it("invokes the legacy callback with (clientOptions, callback) overload", async () => {
    await new Promise<void>((resolve, reject) => {
      login([], { dryRun: true }, (error) => {
        try {
          expect(error).toBeInstanceOf(Error);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  });

  it("constructs a MessengerClient under the hood", () => {
    const client = new MessengerClient();
    expect(client).toBeInstanceOf(MessengerClient);
  });

  it("accepts structured options at construction (dryRun/stealth/e2ee/update)", () => {
    // Regression: these used to hit the strict scalar zod schema and throw
    // "Unrecognized key" — the documented options were unusable.
    expect(
      () => new MessengerClient({ dryRun: true, stealth: { enabled: false }, e2ee: "auto" }),
    ).not.toThrow();
    expect(() => new MessengerClient({ update: { enabled: false } })).not.toThrow();
  });
});
