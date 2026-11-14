/**
 * Proxy tunneling agent for the MQTT WebSocket.
 *
 * mqtt's built-in proxy support only covers the raw TCP and TLS transport
 * builders. For `ws://` and `wss://` brokers it silently ignores the proxy and
 * dials the endpoint directly, which would leak the caller's real IP on a
 * proxied setup. This agent plugs the hole: it is a custom `http.Agent` handed
 * to `ws` through `mqtt`'s `wsOptions.agent`, and every WebSocket connection
 * is tunneled through the configured HTTP or SOCKS5 proxy before being
 * upgraded to TLS.
 *
 * Hand-off mechanics matter here: a proxy CONNECT response (or SOCKS reply)
 * can be followed immediately by TLS handshake bytes on the same socket. The
 * surplus bytes are buffered during the handshake, then re-emitted on the
 * socket after `tls.connect()` has attached its plumbing, mirroring the
 * approach used by the battle-tested `socks` client. Empirically verified on
 * Node 20+: `tls.connect({ socket })` also forwards underlying-socket errors
 * onto the TLSSocket, so late tunnel failures surface as TLS errors instead
 * of unhandled `error` events.
 */

import type { ClientRequestArgs } from "node:http";
import { Agent as HttpAgent } from "node:http";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { SocksClient } from "socks";
import { DEFAULT_USER_AGENT } from "../../constants.js";
import { NetworkError, TimeoutError, ValidationError } from "../../errors/index.js";

/** Options for {@link createWsProxyAgent}. */
export interface WsProxyAgentOptions {
  /** Milliseconds allowed for each phase: proxy dial, tunnel, TLS handshake. */
  readonly timeoutMs?: number | undefined;
  /**
   * Extra options merged into the target TLS upgrade. Defaults enforce
   * certificate verification; callers may override `ca` for endpoints behind
   * a trusted corporate proxy or `servername` for exotic routing.
   */
  readonly tlsOptions?: tls.ConnectionOptions | undefined;
}

/** Proxy schemes the agent understands. */
type ProxyProtocol = "http" | "https" | "socks5" | "socks5h";

interface ParsedProxyUrl {
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  readonly username: string | null;
  readonly password: string | null;
}

/** Default ports for each proxy scheme, used when the URL omits one. */
const DEFAULT_PROXY_PORTS: Readonly<Record<ProxyProtocol, number>> = {
  http: 80,
  https: 443,
  socks5: 1080,
  socks5h: 1080,
};

/** Maps URL schemes onto supported proxy protocols. */
const PROTOCOL_BY_SCHEME: Readonly<Record<string, ProxyProtocol | undefined>> = {
  "http:": "http",
  "https:": "https",
  "socks:": "socks5",
  "socks5:": "socks5",
  "socks5h:": "socks5h",
};

/** Default per-phase timeout. */
const DEFAULT_PROXY_TIMEOUT_MS = 10_000;

/** CONNECT response heads larger than this are treated as a broken proxy. */
const MAX_CONNECT_HEAD_BYTES = 8_192;

/** Decodes a URL component, tolerating malformed percent sequences. */
function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parses and validates a proxy URL. */
export function parseProxyUrl(proxyUrl: string): ParsedProxyUrl {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch (cause) {
    throw new ValidationError(`httpProxy is not a valid URL: "${proxyUrl}"`, {
      context: { proxyUrl },
      cause,
    });
  }
  const protocol = PROTOCOL_BY_SCHEME[parsed.protocol];
  if (protocol === undefined) {
    throw new ValidationError(
      `httpProxy must use http://, https://, or socks5://, got "${parsed.protocol}"`,
      { context: { scheme: parsed.protocol } },
    );
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host === "") {
    throw new ValidationError("httpProxy URL is missing a host", { context: { proxyUrl } });
  }
  const port =
    parsed.port === "" ? DEFAULT_PROXY_PORTS[protocol] : Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new ValidationError(`httpProxy port is invalid: "${parsed.port}"`, {
      context: { port: parsed.port },
    });
  }
  return {
    protocol,
    host,
    port,
    username: parsed.username === "" ? null : decodeUrlPart(parsed.username),
    password: parsed.password === "" ? null : decodeUrlPart(parsed.password),
  };
}

/** Extracts the target host and port from a `ws` request options object. */
function targetFrom(options: ClientRequestArgs): { host: string; port: number } {
  const rawHost =
    typeof options.host === "string" && options.host !== "" ? options.host : "localhost";
  const host = rawHost.replace(/^\[(.*)\]$/, "$1");
  const rawPort =
    typeof options.port === "number" ? options.port : Number.parseInt(String(options.port), 10);
  const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 443;
  return { host, port };
}

/** Normalizes unknown thrown values into `Error`s. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Wraps unknown thrown values into `NetworkError`s. */
function toNetworkError(value: unknown, label: string): NetworkError {
  if (value instanceof NetworkError) {
    return value;
  }
  const detail = value instanceof Error ? value.message : String(value);
  return new NetworkError(`${label}: ${detail}`, { cause: value });
}

/** SNI-safe server name: hostnames only, never raw IP addresses. */
function servernameFor(host: string): string | undefined {
  return net.isIP(host) === 0 ? host : undefined;
}

/**
 * Arms a watchdog that destroys the socket after `timeoutMs`. Destroying with
 * an error makes any pending handshake step reject instead of hanging.
 */
function armWatchdog(
  socket: net.Socket | tls.TLSSocket,
  timeoutMs: number,
  label: string,
): () => void {
  const timer = setTimeout(() => {
    socket.destroy(new TimeoutError(`${label} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Resolves when the socket emits `successEvent`; rejects when `error` or
 * `close` arrives first, or when the watchdog fires.
 */
function waitFor(
  socket: net.Socket | tls.TLSSocket,
  successEvent: "connect" | "secureConnect",
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const disarmWatchdog = armWatchdog(socket, timeoutMs, label);
    const cleanup = (): void => {
      disarmWatchdog();
      socket.off(successEvent, onSuccess);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onSuccess = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(toNetworkError(error, label));
    };
    const onClose = (): void => {
      cleanup();
      reject(new NetworkError(`${label}: socket closed before completion`));
    };
    socket.once(successEvent, onSuccess);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/** Result of a finished HTTP CONNECT negotiation with a proxy. */
interface HttpTunnelResult {
  readonly socket: net.Socket;
  /** Bytes the proxy sent after the CONNECT response head. */
  readonly surplus: Buffer;
}

/**
 * Establishes an HTTP CONNECT tunnel to `host:port` through the proxy. Any
 * bytes following the response head are captured and returned as `surplus`;
 * the socket is left paused and listener-free for the TLS upgrade.
 */
function establishHttpTunnel(
  proxy: ParsedProxyUrl,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<HttpTunnelResult> {
  return new Promise<HttpTunnelResult>((resolve, reject) => {
    const socket: net.Socket =
      proxy.protocol === "https"
        ? tls.connect({
            host: proxy.host,
            port: proxy.port,
            servername: servernameFor(proxy.host),
            rejectUnauthorized: true,
          })
        : net.connect({ host: proxy.host, port: proxy.port });

    const connectEvent = proxy.protocol === "https" ? "secureConnect" : "connect";
    // One watchdog spans both phases; it is disarmed once the response head
    // has been parsed or the connection fails.
    const disarmWatchdog = armWatchdog(socket, timeoutMs, "the proxy tunnel");

    const cleanupConnectPhase = (): void => {
      socket.off(connectEvent, onConnected);
      socket.off("error", onConnectError);
      socket.off("close", onConnectClose);
    };
    const fail = (error: unknown): void => {
      cleanupConnectPhase();
      socket.off("data", onData);
      disarmWatchdog();
      socket.destroy();
      reject(toNetworkError(error, "establishing the proxy tunnel"));
    };

    const onConnected = (): void => {
      cleanupConnectPhase();
      const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        `User-Agent: ${DEFAULT_USER_AGENT}`,
      ];
      if (proxy.username !== null || proxy.password !== null) {
        const credentials = `${proxy.username ?? ""}:${proxy.password ?? ""}`;
        lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials, "utf8").toString("base64")}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      socket.on("data", onData);
      socket.once("error", onConnectError);
      socket.once("close", onConnectClose);
    };
    const onConnectError = (error: Error): void => {
      fail(error);
    };
    const onConnectClose = (): void => {
      fail(new NetworkError("proxy closed the connection during the tunnel setup"));
    };

    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const joined = Buffer.concat(chunks);
      const headEnd = joined.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        if (joined.length > MAX_CONNECT_HEAD_BYTES) {
          fail(new NetworkError("proxy CONNECT response head exceeded 8 KiB"));
        }
        return;
      }
      socket.off("data", onData);
      socket.off("error", onConnectError);
      socket.off("close", onConnectClose);
      socket.pause();
      disarmWatchdog();

      const head = joined.subarray(0, headEnd).toString("latin1");
      const statusLine = head.split("\r\n", 1)[0] ?? "";
      const match = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine);
      if (match === null) {
        socket.destroy();
        reject(new NetworkError(`malformed proxy CONNECT response: "${statusLine}"`, {
          context: { proxyHost: proxy.host },
        }));
        return;
      }
      const code = Number.parseInt(match[1]!, 10);
      if (code < 200 || code > 299) {
        socket.destroy();
        reject(
          new NetworkError(`proxy CONNECT failed with status ${code}`, {
            retryable: true,
            context: { proxyHost: proxy.host, status: code },
          }),
        );
        return;
      }
      resolve({ socket, surplus: joined.subarray(headEnd + 4) });
    };

    socket.once(connectEvent, onConnected);
    socket.once("error", onConnectError);
    socket.once("close", onConnectClose);
  });
}

/**
 * An `http.Agent` that tunnels WebSocket connections through an HTTP or
 * SOCKS5 proxy. Used as `wsOptions.agent` on the MQTT transport so the MQTT
 * WebSocket never leaves the proxy.
 */
export class WsProxyAgent extends HttpAgent {
  /**
   * Fixed at `https:`. Both `https.request` and `ws` reject custom agents
   * whose `protocol` does not match the request protocol
   * (`ERR_INVALID_PROTOCOL`); the base `http.Agent` hardcodes `http:` at
   * runtime without exposing it through the typings, so the property is
   * declared here and reassigned in the constructor.
   */
  declare protocol: string;

  readonly #proxy: ParsedProxyUrl;
  readonly #timeoutMs: number;
  readonly #tlsOptions: tls.ConnectionOptions;

  constructor(proxyUrl: string, options: WsProxyAgentOptions = {}) {
    super({ keepAlive: false });
    this.protocol = "https:";
    this.#proxy = parseProxyUrl(proxyUrl);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;
    this.#tlsOptions = options.tlsOptions ?? {};

    // `http.Agent.prototype.createSocket` calls `this.createConnection`
    // with the merged request options; `ws` reaches it through
    // `https.request({ agent })`. The callback form lets the handshake run
    // asynchronously; node only reads the returned socket once the callback
    // reports success. Node's `createSocket` always supplies the callback,
    // hence the non-null assertions on delivery.
    this.createConnection = (options, oncreate): undefined => {
      void this.#open(options).then(
        (socket) => {
          oncreate?.(null, socket);
        },
        (error: unknown) => {
          // Node ignores the socket argument once `err` is set; the
          // typings demand one, so an unusable placeholder is passed.
          oncreate?.(toError(error), undefined as unknown as Duplex);
        },
      );
      return undefined;
    };
  }

  /** Opens one tunneled, TLS-upgraded socket for the given request. */
  async #open(options: ClientRequestArgs): Promise<tls.TLSSocket> {
    const { host, port } = targetFrom(options);
    const proxy = this.#proxy;
    const label = `tunneling to ${host}:${port}`;

    let tunnel: net.Socket;
    let surplus: Buffer = Buffer.alloc(0);

    if (proxy.protocol === "socks5" || proxy.protocol === "socks5h") {
      try {
        const proxySpec = {
          host: proxy.host,
          port: proxy.port,
          type: 5 as const,
          ...(proxy.username !== null ? { userId: proxy.username } : {}),
          ...(proxy.password !== null ? { password: proxy.password } : {}),
        };
        const established = await SocksClient.createConnection({
          command: "connect",
          destination: { host, port },
          proxy: proxySpec,
          timeout: this.#timeoutMs,
        });
        // The socks client pauses the socket and re-emits its own surplus
        // bytes on a `setImmediate`, after the caller has attached the TLS
        // plumbing below.
        tunnel = established.socket;
      } catch (cause) {
        throw toNetworkError(cause, label);
      }
    } else {
      const result = await establishHttpTunnel(proxy, host, port, this.#timeoutMs);
      tunnel = result.socket;
      surplus = result.surplus;
    }

    const secure = tls.connect({
      socket: tunnel,
      servername: servernameFor(host),
      ALPNProtocols: ["http/1.1"],
      rejectUnauthorized: true,
      ...this.#tlsOptions,
    });

    // Hand the surplus back before the handshake starts. Node's TLSSocket
    // constructor schedules `initRead` on `process.nextTick`, and that
    // routine drains whatever sits in the wrapped socket's readable buffer
    // straight into the TLS parser. Unshifting synchronously here means
    // initRead feeds the surplus to OpenSSL first; re-emitting it later on
    // `setImmediate` (the `socks` client's approach) is too late on modern
    // Node, because the wrap bypasses the raw stream's data events entirely
    // and late bytes are silently dropped.
    if (surplus.length > 0) {
      tunnel.unshift(surplus);
    }

    // Resume flow so the handle keeps reading once initRead kicks in.
    setImmediate(() => {
      tunnel.resume();
    });

    try {
      await waitFor(secure, "secureConnect", this.#timeoutMs, `TLS handshake with ${host}`);
    } catch (error) {
      secure.destroy();
      throw error;
    }
    return secure;
  }
}

/**
 * Creates a WebSocket proxy agent for the given proxy URL. Accepts
 * `http://`, `https://`, `socks5://`, and `socks5h://` URLs, with optional
 * embedded credentials.
 */
export function createWsProxyAgent(
  proxyUrl: string,
  options: WsProxyAgentOptions = {},
): WsProxyAgent {
  return new WsProxyAgent(proxyUrl, options);
}
