/**
 * Proxy-agent unit tests (`parseProxyUrl`, scheme validation) live here.
 *
 * Integration tests that opened local TCP sockets were removed in 0.2.5;
 * the notes called it sandbox-only EACCES avoidance, but 229/229 tests pass
 * here. Treat it as a coverage gap, not a platform requirement.
 */

import { describe, expect, it } from "vitest";
import { createWsProxyAgent } from "../src/transport/mqtt/proxy-agent.js";
import { parseProxyUrl } from "../src/transport/mqtt/proxy-agent.js";

describe("WsProxyAgent", () => {
  it("rejects unsupported proxy schemes", () => {
    expect(() => createWsProxyAgent("ftp://example.com:21")).toThrow(/httpProxy must use/);
  });

  it("rejects non-URL strings", () => {
    expect(() => createWsProxyAgent("not-a-url")).toThrow(/not a valid URL/);
  });

  it("rejects a URL without a host", () => {
    expect(() => createWsProxyAgent("http://")).toThrow(/not a valid URL|missing a host/);
  });
});

describe("parseProxyUrl", () => {
  it("parses an http:// proxy", () => {
    const parsed = parseProxyUrl("http://proxy.example.com:3128");
    expect(parsed.protocol).toBe("http");
    expect(parsed.host).toBe("proxy.example.com");
    expect(parsed.port).toBe(3128);
    expect(parsed.username).toBeNull();
    expect(parsed.password).toBeNull();
  });

  it("parses an https:// proxy", () => {
    const parsed = parseProxyUrl("https://secure-proxy.example.com:8443");
    expect(parsed.protocol).toBe("https");
    expect(parsed.host).toBe("secure-proxy.example.com");
    expect(parsed.port).toBe(8443);
  });

  it("parses a socks5:// proxy", () => {
    const parsed = parseProxyUrl("socks5://tor.example.com:9050");
    expect(parsed.protocol).toBe("socks5");
    expect(parsed.host).toBe("tor.example.com");
    expect(parsed.port).toBe(9050);
  });

  it("extracts embedded credentials", () => {
    const parsed = parseProxyUrl("http://user:p%40ss@proxy.example.com:3128");
    expect(parsed.username).toBe("user");
    expect(parsed.password).toBe("p@ss");
  });

  it("uses default ports when the URL omits one", () => {
    expect(parseProxyUrl("http://proxy.example.com").port).toBe(80);
    expect(parseProxyUrl("https://proxy.example.com").port).toBe(443);
    expect(parseProxyUrl("socks5://proxy.example.com").port).toBe(1080);
  });

  it("rejects unsupported schemes", () => {
    expect(() => parseProxyUrl("ftp://example.com:21")).toThrow(/httpProxy must use/);
  });

  it("rejects non-URL strings", () => {
    expect(() => parseProxyUrl("not-a-url")).toThrow(/not a valid URL/);
  });
});
