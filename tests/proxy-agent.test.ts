/**
 * Proxy-agent integration tests against a local fake HTTP CONNECT proxy and a
 * local TLS endpoint.
 *
 * The fake endpoint uses a self-signed certificate generated in-process; the
 * agent's target TLS upgrade is configured with it as a trusted `ca` (through
 * the agent's `tlsOptions`), so strict certificate verification still runs and
 * passes. The proxy dial itself stays plain TCP, as with a real HTTP proxy.
 */

import { describe, expect, it } from "vitest";
import tls from "node:tls";
import net from "node:net";
import https from "node:https";
import type { ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { createWsProxyAgent } from "../src/transport/mqtt/proxy-agent.js";
import type { WsProxyAgent } from "../src/transport/mqtt/proxy-agent.js";

// ---------------------------------------------------------------------------
// Minimal self-signed certificate machinery (pure-JS DER encoding).
// ---------------------------------------------------------------------------

/** Flattens arbitrarily nested byte-part arrays. */
function flat(parts: readonly unknown[]): number[] {
  const out: number[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) {
      out.push(...flat(part));
    } else {
      out.push(part as number);
    }
  }
  return out;
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let value = n;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: readonly unknown[]): number[] {
  const flatContent = flat(content);
  return [tag, ...derLength(flatContent.length), ...flatContent];
}

function encodeOid(dotString: string): number[] {
  const parts = dotString.split(".").map(Number);
  const content = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const stack: number[] = [part & 0x7f];
    let value = part >> 7;
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value >>= 7;
    }
    content.push(...stack);
  }
  return tlv(0x06, content);
}

interface GeneratedCert {
  readonly keyPem: string;
  readonly certPem: string;
}

/** Generates a self-signed ECDSA P-256 certificate for `localhost`. */
function generateCertificate(): GeneratedCert {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = [...publicKey.export({ type: "spki", format: "der" })];
  const signatureAlgorithm = encodeOid("1.2.840.10045.4.3.2"); // ecdsa-with-SHA256
  const algorithmId = tlv(0x30, [signatureAlgorithm]);
  const name = tlv(0x30, [
    tlv(0x31, [tlv(0x30, [encodeOid("2.5.4.3"), tlv(0x0c, [...Buffer.from("localhost")])])]),
  ]);
  const validity = tlv(0x30, [
    tlv(0x17, [...Buffer.from("250101000000Z")]),
    tlv(0x17, [...Buffer.from("331231000000Z")]),
  ]);
  // Subject Alternative Name: DNS:localhost, IP:127.0.0.1.
  const san = tlv(0x30, [[0x82, 0x09, ...Buffer.from("localhost")], [0x87, 0x04, 127, 0, 0, 1]]);
  const extensions = tlv(0xa3, [tlv(0x30, [tlv(0x30, [encodeOid("2.5.29.17"), tlv(0x04, san)])])]);
  const tbsCertificate = tlv(0x30, [
    [0xa0, 0x03, 0x02, 0x01, 0x02], // version: v3
    tlv(0x02, [1]), // serial number
    algorithmId,
    name, // issuer
    validity,
    name, // subject
    spki,
    extensions,
  ]);
  // Node's sign() already returns a DER-encoded ECDSA-SIG (SEQUENCE of two
  // INTEGERs) for EC keys — exactly the signature format X.509 expects. The
  // BIT STRING merely needs the leading "0 unused bits" byte in front of it.
  const signature = sign("sha256", Buffer.from(flat(tbsCertificate)), privateKey);
  const signatureBitString = tlv(0x03, [0x00, ...signature]);
  const certificate = tlv(0x30, [tbsCertificate, algorithmId, signatureBitString]);
  const base64 = Buffer.from(flat(certificate)).toString("base64");
  return {
    keyPem: privateKey.export({ type: "sec1", format: "pem" }) as string,
    certPem: `-----BEGIN CERTIFICATE-----\n${base64.replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`,
  };
}

// ---------------------------------------------------------------------------
// Fake TLS endpoint and fake HTTP CONNECT proxy.
// ---------------------------------------------------------------------------

interface Closable {
  close(): Promise<void>;
}

/**
 * Destroys every accepted socket so `server.close()` cannot hang on live
 * connections. Node 26 no longer exposes `closeAllConnections()`, so the
 * sockets are tracked through the raw `connection` event, which both
 * `net.Server` and `tls.Server` emit before any TLS handshake.
 */
function trackSockets(server: net.Server): () => void {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return () => {
    for (const socket of sockets) {
      socket.destroy();
    }
  };
}

/** Starts a TLS server that answers any request with `200 hello`. */
async function startFakeEndpoint(cert: GeneratedCert): Promise<{ port: number } & Closable> {
  const server = tls.createServer({ key: cert.keyPem, cert: cert.certPem }, (socket) => {
    socket.once("data", () => {
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
      );
    });
  });
  const destroyClients = trackSockets(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        destroyClients();
        server.close(() => resolve());
      }),
  };
}

interface FakeProxyOptions {
  /** Extra bytes glued to the CONNECT response head. */
  readonly surplusAfterHead?: string;
  /** Non-200 status makes the proxy refuse the CONNECT. */
  readonly connectStatus?: number;
  /** Target port the proxy forwards to. */
  readonly targetPort: number;
  /** Simulates a proxy that accepts CONNECT but never relays. */
  readonly silentRelay?: boolean;
}

/** Starts an HTTP CONNECT proxy that tunnels to the target. */
async function startFakeProxy(
  options: FakeProxyOptions,
): Promise<{ port: number; connectRequests: string[] } & Closable> {
  const connectRequests: string[] = [];
  const server = net.createServer((clientSocket) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("latin1");
      const requestEnd = buffer.indexOf("\r\n\r\n");
      if (requestEnd === -1) {
        return;
      }
      clientSocket.off("data", onData);
      const requestHead = buffer.slice(0, requestEnd);
      const requestLine = requestHead.split("\r\n", 1)[0] ?? "";
      connectRequests.push(requestLine);
      const status = options.connectStatus ?? 200;
      if (status !== 200) {
        clientSocket.end(`HTTP/1.1 ${status} Forbidden\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      clientSocket.write(`HTTP/1.1 200 Connection established\r\n\r\n${options.surplusAfterHead ?? ""}`);
      if (options.silentRelay === true) {
        return;
      }
      const head = Buffer.from(buffer.slice(requestEnd + 4), "latin1");
      // A real CONNECT proxy relays raw bytes only — the TLS session belongs
      // to the client and the target, end to end.
      const upstream = net.connect({ host: "127.0.0.1", port: options.targetPort }, () => {
        if (head.length > 0) {
          upstream.write(head);
        }
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      clientSocket.on("error", () => upstream.destroy());
      upstream.on("error", () => clientSocket.destroy());
    };
    clientSocket.on("data", onData);
  });
  const destroyClients = trackSockets(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    connectRequests,
    close: () =>
      new Promise<void>((resolve) => {
        destroyClients();
        server.close(() => resolve());
      }),
  };
}

/** Issues one GET through the agent, resolving the status, body, or error. */
function requestThroughAgent(
  agent: WsProxyAgent,
  port: number,
): Promise<{ readonly status: number | null; readonly body: string; readonly error: Error | null }> {
  return new Promise((resolve) => {
    // `https.request` throws synchronously for agents it rejects outright,
    // so the call itself is guarded as well.
    let req: ClientRequest;
    try {
      req = https.request(
        { host: "localhost", port, agent, method: "GET", path: "/" },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
          });
          res.on("end", () => {
            resolve({ status: res.statusCode, body, error: null });
          });
        },
      );
    } catch (error) {
      resolve({ status: null, body: "", error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    req.setTimeout(6000, () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", (error: Error) => {
      resolve({ status: null, body: "", error });
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WsProxyAgent", () => {
  it("tunnels HTTPS requests through an HTTP CONNECT proxy", async () => {
    const cert = generateCertificate();
    const endpoint = await startFakeEndpoint(cert);
    const proxy = await startFakeProxy({ targetPort: endpoint.port });

    const agent = createWsProxyAgent(`http://127.0.0.1:${proxy.port}`, {
      timeoutMs: 3000,
      tlsOptions: { ca: cert.certPem },
    });

    const result = await requestThroughAgent(agent, endpoint.port);
    expect(result.error).toBeNull();
    expect(result.status).toBe(200);
    expect(result.body).toBe("hello");
    expect(proxy.connectRequests).toEqual([`CONNECT localhost:${endpoint.port} HTTP/1.1`]);

    await proxy.close();
    await endpoint.close();
  }, 10_000);

  it("delivers surplus bytes after the CONNECT head into the TLS handshake", async () => {
    const cert = generateCertificate();
    const endpoint = await startFakeEndpoint(cert);
    const proxy = await startFakeProxy({
      targetPort: endpoint.port,
      // Bytes glued to the CONNECT response head must reach the TLS layer
      // instead of being dropped; plaintext garbage makes the handshake fail
      // fast rather than hanging.
      surplusAfterHead: "GARBAGE-NOT-TLS",
    });

    const agent = createWsProxyAgent(`http://127.0.0.1:${proxy.port}`, {
      timeoutMs: 3000,
      tlsOptions: { ca: cert.certPem },
    });

    const result = await requestThroughAgent(agent, endpoint.port);
    expect(result.status).toBeNull();
    expect(result.error).not.toBeNull();

    await proxy.close();
    await endpoint.close();
  }, 10_000);

  it("surfaces proxy CONNECT rejection as an error", async () => {
    const cert = generateCertificate();
    const endpoint = await startFakeEndpoint(cert);
    const proxy = await startFakeProxy({ targetPort: endpoint.port, connectStatus: 403 });

    const agent = createWsProxyAgent(`http://127.0.0.1:${proxy.port}`, {
      timeoutMs: 3000,
      tlsOptions: { ca: cert.certPem },
    });

    const result = await requestThroughAgent(agent, endpoint.port);
    expect(result.status).toBeNull();
    expect(result.error?.message).toContain("proxy CONNECT failed with status 403");

    await proxy.close();
    await endpoint.close();
  }, 10_000);

  it("times out when the proxy accepts CONNECT but never relays", async () => {
    const cert = generateCertificate();
    const endpoint = await startFakeEndpoint(cert);
    const proxy = await startFakeProxy({ targetPort: endpoint.port, silentRelay: true });

    const agent = createWsProxyAgent(`http://127.0.0.1:${proxy.port}`, {
      timeoutMs: 500,
      tlsOptions: { ca: cert.certPem },
    });

    const result = await requestThroughAgent(agent, endpoint.port);
    expect(result.status).toBeNull();
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/timed out|TLS handshake/i);

    await proxy.close();
    await endpoint.close();
  }, 15_000);

  it("rejects unsupported proxy schemes", () => {
    expect(() => createWsProxyAgent("ftp://example.com:21")).toThrow(/httpProxy must use/);
  });
});
