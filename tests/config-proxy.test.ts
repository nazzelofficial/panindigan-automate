/**
 * Regression tests for the httpProxy configuration fix (v0.2.5).
 *
 * Root cause: empty strings, whitespace-only values, and undefined
 * environment variables were not normalized to `null` before the
 * `isProxyUrl` validator ran. The result was a confusing:
 *
 *   ValidationError: Invalid option "httpProxy":
 *   httpProxy must be an http://, https://, or socks5:// URL
 *
 * …when the user intended "no proxy". The fix applies a `.transform()`
 * in the zod schema that normalizes empty/whitespace strings to `null`
 * before the `superRefine` runs.
 */

import { describe, expect, it, afterEach } from "vitest";
import { resolveConfig } from "../src/config/index.js";

/** Save and restore PANINDIGAN_HTTP_PROXY between tests. */
function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const saved = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
}

describe("resolveConfig — httpProxy", () => {
  const ENV_KEY = "PANINDIGAN_HTTP_PROXY";

  afterEach(() => {
    // Safety net: ensure the env var is unset after each test
    delete process.env[ENV_KEY];
  });

  // -----------------------------------------------------------------------
  // 1. Missing / omitted / null / undefined — should resolve to null
  // -----------------------------------------------------------------------

  it("defaults httpProxy to null when nothing is set", () => {
    withEnv(ENV_KEY, undefined, () => {
      const config = resolveConfig({});
      expect(config.httpProxy).toBeNull();
    });
  });

  it("resolves httpProxy to null when explicitly set to null", () => {
    withEnv(ENV_KEY, undefined, () => {
      const config = resolveConfig({ httpProxy: null });
      expect(config.httpProxy).toBeNull();
    });
  });

  it("resolves httpProxy to null when explicitly set to undefined", () => {
    withEnv(ENV_KEY, undefined, () => {
      const config = resolveConfig({ httpProxy: undefined });
      expect(config.httpProxy).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 2. Empty strings — the production failure case
  // -----------------------------------------------------------------------

  it("resolves httpProxy to null when set to an empty string (THE PRODUCTION BUG)", () => {
    withEnv(ENV_KEY, undefined, () => {
      const config = resolveConfig({ httpProxy: "" });
      expect(config.httpProxy).toBeNull();
    });
  });

  it("resolves httpProxy to null when set to whitespace only", () => {
    withEnv(ENV_KEY, undefined, () => {
      const config = resolveConfig({ httpProxy: "   " });
      expect(config.httpProxy).toBeNull();
    });
  });

  it("resolves httpProxy to null when PANINDIGAN_HTTP_PROXY is empty", () => {
    withEnv(ENV_KEY, "", () => {
      const config = resolveConfig({});
      expect(config.httpProxy).toBeNull();
    });
  });

  it("resolves httpProxy to null when PANINDIGAN_HTTP_PROXY is whitespace", () => {
    withEnv(ENV_KEY, "   ", () => {
      const config = resolveConfig({});
      expect(config.httpProxy).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 3. Valid proxy URLs — should pass through
  // -----------------------------------------------------------------------

  it("accepts an http:// proxy URL", () => {
    withEnv(ENV_KEY, undefined, () => {
      const config = resolveConfig({ httpProxy: "http://proxy.example.com:8080" });
      expect(config.httpProxy).toBe("http://proxy.example.com:8080");
    });
  });

  it("accepts an https:// proxy URL", () => {
    withEnv(ENV_KEY, undefined, () => {
      const config = resolveConfig({ httpProxy: "https://proxy.example.com:8443" });
      expect(config.httpProxy).toBe("https://proxy.example.com:8443");
    });
  });

  it("accepts a socks5:// proxy URL", () => {
    withEnv(ENV_KEY, undefined, () => {
      const config = resolveConfig({ httpProxy: "socks5://tor.example.com:9050" });
      expect(config.httpProxy).toBe("socks5://tor.example.com:9050");
    });
  });

  it("accepts a proxy URL with embedded credentials", () => {
    withEnv(ENV_KEY, undefined, () => {
      const config = resolveConfig({ httpProxy: "http://user:pass@proxy.example.com:3128" });
      expect(config.httpProxy).toBe("http://user:pass@proxy.example.com:3128");
    });
  });

  it("trims a valid proxy URL with leading/trailing whitespace", () => {
    withEnv(ENV_KEY, undefined, () => {
      const config = resolveConfig({ httpProxy: "  http://proxy.example.com:8080  " });
      expect(config.httpProxy).toBe("http://proxy.example.com:8080");
    });
  });

  it("accepts a proxy URL from PANINDIGAN_HTTP_PROXY env var", () => {
    withEnv(ENV_KEY, "http://env-proxy.example.com:3128", () => {
      const config = resolveConfig({});
      expect(config.httpProxy).toBe("http://env-proxy.example.com:3128");
    });
  });

  // -----------------------------------------------------------------------
  // 4. Invalid / malformed proxy URLs — should throw ValidationError
  // -----------------------------------------------------------------------

  it("rejects a plain hostname (not a URL)", () => {
    withEnv(ENV_KEY, undefined, () => {
      expect(() => resolveConfig({ httpProxy: "proxy.example.com:8080" })).toThrow(
        /httpProxy must be an http:\/\//,
      );
    });
  });

  it("rejects an unsupported scheme (ftp://)", () => {
    withEnv(ENV_KEY, undefined, () => {
      expect(() => resolveConfig({ httpProxy: "ftp://proxy.example.com:21" })).toThrow(
        /httpProxy must be an http:\/\//,
      );
    });
  });

  it("rejects a file:// URL", () => {
    withEnv(ENV_KEY, undefined, () => {
      expect(() => resolveConfig({ httpProxy: "file:///etc/hosts" })).toThrow(
        /httpProxy must be an http:\/\//,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5. Env var overrides — programmatic option takes precedence
  // -----------------------------------------------------------------------

  it("programmatic httpProxy overrides the env var", () => {
    withEnv(ENV_KEY, "http://env-proxy:3128", () => {
      const config = resolveConfig({ httpProxy: "http://cli-proxy:8080" });
      expect(config.httpProxy).toBe("http://cli-proxy:8080");
    });
  });

  it("programmatic httpProxy: null overrides the env var", () => {
    withEnv(ENV_KEY, "http://env-proxy:3128", () => {
      const config = resolveConfig({ httpProxy: null });
      // null explicitly disables the proxy; the env var is overridden
      expect(config.httpProxy).toBeNull();
    });
  });

  it('programmatic httpProxy: "" overrides the env var (normalized to null)', () => {
    withEnv(ENV_KEY, "http://env-proxy:3128", () => {
      const config = resolveConfig({ httpProxy: "" });
      // Empty string is normalized to null, overriding the env var
      expect(config.httpProxy).toBeNull();
    });
  });
});
