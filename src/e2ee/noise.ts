/**
 * Noise Protocol (XX) handshake + encrypted frame transport over WebSocket —
 * ported from bhhoang/fbapi-unofficial (MIT), https://github.com/bhhoang/fbapi-unofficial
 * (src/e2ee/noise.js), MIT licensed by bhhoang and contributors.
 *
 * Copyright (c) bhhoang and contributors of fbapi-unofficial.
 * Licensed MIT. Ported to TypeScript with only module-syntax and
 * type-annotation adjustments; wire behaviour is unchanged.
 *
 * The prefix byte of every frame is 0x00; handshake messages are protobuf
 * `HandshakeMessage`s carried in 0x00-prefixed marshalled WA stanzas.
 */

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import {
  generateKeyPair,
  publicFromPrivate,
  dh,
  hkdf,
  sha256,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from "./crypto.js";
import { marshal, unmarshal } from "./wa-binary.js";

const NOISE_PATTERN = Buffer.from("Noise_XX_25519_AESGCM_SHA256\0\0\0\0", "binary");
const WA_HEADER = Buffer.from([87, 65, 6, 3]); // "WA" + version

function encodeVarint(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0;
  while (v > 127) {
    out.push((v & 127) | 128);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function encodeLenDelim(field: number, data: Buffer): Buffer {
  return Buffer.concat([
    encodeVarint((field << 3) | 2),
    encodeVarint(data.length),
    data,
  ]);
}

function readByteAt(data: Buffer, pos: number): number {
  const b = data[pos];
  if (b === undefined) {
    throw new Error("Unexpected end of protobuf buffer");
  }
  return b;
}

function decodeLenDelim(data: Buffer, targetField: number): Buffer {
  let pos = 0;
  while (pos < data.length) {
    const tag = readByteAt(data, pos++);
    const field = tag >> 3;
    const wire = tag & 7;

    if (wire === 2) {
      let len = 0;
      let shift = 0;
      let b: number;
      do {
        b = readByteAt(data, pos++);
        len |= (b & 127) << shift;
        shift += 7;
      } while (b & 128);

      const value = data.subarray(pos, pos + len);
      pos += len;

      if (field === targetField) return Buffer.from(value);
    } else if (wire === 0) {
      while (pos < data.length && (readByteAt(data, pos) & 128) !== 0) pos++;
      pos++;
    } else {
      break;
    }
  }
  throw new Error(`Field ${targetField} not found in handshake message`);
}

function encodeHandshakeMessage(msg: {
  clientHello?: { ephemeral: Uint8Array };
  clientFinish?: { static: Uint8Array; payload: Uint8Array };
}): Buffer {
  const chunks: Buffer[] = [];

  if (msg.clientHello) {
    chunks.push(encodeLenDelim(2, encodeLenDelim(1, Buffer.from(msg.clientHello.ephemeral))));
  }

  if (msg.clientFinish) {
    const finish = Buffer.concat([
      encodeLenDelim(1, Buffer.from(msg.clientFinish.static)),
      encodeLenDelim(2, Buffer.from(msg.clientFinish.payload)),
    ]);
    chunks.push(encodeLenDelim(4, finish));
  }

  return Buffer.concat(chunks);
}

interface ServerHello {
  readonly ephemeral: Buffer;
  readonly static: Buffer;
  readonly payload: Buffer;
}

function decodeServerHello(data: Buffer): ServerHello {
  const raw = decodeLenDelim(data, 3);
  return {
    ephemeral: decodeLenDelim(raw, 1),
    static: decodeLenDelim(raw, 2),
    payload: decodeLenDelim(raw, 3),
  };
}

export class NoiseHandshakeState {
  #h: Buffer;
  #ck: Buffer;
  #k: Buffer | null = null;
  #n = 0;

  constructor() {
    this.#h = Buffer.from(NOISE_PATTERN);
    this.#ck = Buffer.from(NOISE_PATTERN);
    this.mixHash(WA_HEADER);
  }

  mixHash(data: Uint8Array): void {
    this.#h = sha256(Buffer.concat([this.#h, Buffer.from(data)]));
  }

  private mixKey(input: Buffer): void {
    const expanded = hkdf(input, this.#ck, Buffer.alloc(0), 64);
    this.#ck = expanded.subarray(0, 32);
    this.#k = expanded.subarray(32, 64);
    this.#n = 0;
  }

  mixSharedSecret(privateKey: Buffer, publicKey: Buffer): void {
    this.mixKey(dh(privateKey, publicKey));
  }

  private buildNonce(counter: number): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(counter, 8);
    return nonce;
  }

  encrypt(plaintext: Buffer): Buffer {
    if (!this.#k) throw new Error("Noise state not initialized");
    const nonce = this.buildNonce(this.#n++);
    const ciphertext = aesGcmEncrypt(this.#k, nonce, plaintext, this.#h);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decrypt(ciphertext: Buffer): Buffer {
    if (!this.#k) throw new Error("Noise state not initialized");
    const nonce = this.buildNonce(this.#n++);
    const plaintext = aesGcmDecrypt(this.#k, nonce, ciphertext, this.#h);
    this.mixHash(ciphertext);
    return plaintext;
  }

  finish(): { sendKey: Buffer; recvKey: Buffer } {
    const expanded = hkdf(Buffer.alloc(0), this.#ck, Buffer.alloc(0), 64);
    return {
      sendKey: expanded.subarray(0, 32),
      recvKey: expanded.subarray(32, 64),
    };
  }
}

interface Waiter {
  readonly len: number;
  readonly resolve: (data: Buffer) => void;
  readonly reject: (err: Error) => void;
}

type SocketEvent = "data" | "error" | "close";

/** Minimal duplex adapter so the frame layer is transport-agnostic in tests. */
export interface NoiseTransport {
  write(data: Buffer): void;
  end(): void;
  on(event: SocketEvent, listener: (...args: never[]) => void): void;
  once(event: SocketEvent, listener: (...args: never[]) => void): void;
}

class WebSocketTransport implements NoiseTransport {
  readonly #ws: WebSocket;

  constructor(url: string, options?: { headers?: Record<string, string>; perMessageDeflate?: boolean }) {
    this.#ws = new WebSocket(url, options);
  }

  write(data: Buffer): void {
    this.#ws.send(data);
  }

  end(): void {
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
  }

  on(event: SocketEvent, listener: (...args: never[]) => void): void {
    // @ts-expect-error ws event overloads are structurally compatible for data/error/close
    this.#ws.on(event, listener);
  }

  once(event: SocketEvent, listener: (...args: never[]) => void): void {
    // @ts-expect-error ws event overloads are structurally compatible for data/error/close
    this.#ws.once(event, listener);
  }
}

class RawSocket extends EventEmitter {
  private chunks: Buffer[] = [];
  private length = 0;
  private waiters: Waiter[] = [];
  private closed = false;
  private error: Error | null = null;

  constructor(private readonly stream: NoiseTransport) {
    super();
    this.stream.on("data", ((chunk: Buffer) => {
      this.chunks.push(Buffer.from(chunk));
      this.length += chunk.length;
      this.pump();
    }) as never);
    this.stream.on("error", ((err: Error) => {
      this.error = err;
      this.fail(err);
      this.emit("error", err);
    }) as never);
    this.stream.on("close", (() => {
      this.closed = true;
      this.fail(new Error("WebSocket closed"));
      this.emit("close");
    }) as never);
  }

  private pump(): void {
    while (true) {
      const waiter = this.waiters[0];
      if (waiter === undefined || this.length < waiter.len) {
        break;
      }
      this.waiters.shift();
      waiter.resolve(this.take(waiter.len));
    }
  }

  private take(len: number): Buffer {
    const out = Buffer.alloc(len);
    let offset = 0;

    while (offset < len && this.chunks.length) {
      const first = this.chunks[0];
      if (first === undefined) break;
      const remaining = len - offset;

      if (first.length <= remaining) {
        first.copy(out, offset);
        offset += first.length;
        this.chunks.shift();
      } else {
        first.copy(out, offset, 0, remaining);
        this.chunks[0] = first.subarray(remaining);
        offset += remaining;
      }
    }

    this.length -= len;
    return out;
  }

  private fail(err: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
  }

  readRaw(len: number): Promise<Buffer> {
    if (this.length >= len) return Promise.resolve(this.take(len));
    if (this.closed) return Promise.reject(this.error ?? new Error("WebSocket closed"));

    return new Promise((resolve, reject) => {
      this.waiters.push({ len, resolve, reject });
    });
  }

  write(data: Buffer): void {
    this.stream.write(data);
  }

  end(): void {
    try {
      this.stream.end();
    } catch {
      // already closed
    }
  }
}

export class EncryptedFrameSocket {
  #sendCounter = 0;
  #recvCounter = 0;

  constructor(
    private readonly rawSocket: RawSocket,
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
  ) {}

  private buildNonce(counter: number): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(BigInt(counter), 4);
    return nonce;
  }

  encryptFrame(plaintext: Buffer): Buffer {
    const nonce = this.buildNonce(this.#sendCounter++);
    const encrypted = aesGcmEncrypt(this.sendKey, nonce, plaintext, Buffer.alloc(0));
    const header = Buffer.alloc(3);
    header.writeUIntBE(encrypted.length, 0, 3);
    return Buffer.concat([header, encrypted]);
  }

  decryptFrame(data: Buffer): Buffer {
    if (data.length <= 16) return Buffer.alloc(0);
    const nonce = this.buildNonce(this.#recvCounter++);
    return aesGcmDecrypt(this.recvKey, nonce, data, Buffer.alloc(0));
  }

  sendFrame(data: Buffer): void {
    this.rawSocket.write(this.encryptFrame(data));
  }

  /** Write raw bytes without frame encryption — used only for the heartbeat sentinel. */
  writeRaw(data: Buffer): void {
    this.rawSocket.write(data);
  }

  async readFrame(): Promise<Buffer> {
    const header = await this.rawSocket.readRaw(3);
    const len = header.readUIntBE(0, 3);
    if (len === 0) return Buffer.alloc(0);
    const payload = await this.rawSocket.readRaw(len);
    return this.decryptFrame(payload);
  }

  end(): void {
    this.rawSocket.end();
  }
}

/** Test hook: run the handshake against an in-memory transport. */
export async function connectNoiseSocketOverTransport(
  transport: NoiseTransport,
  noiseKeyPriv: Buffer,
  clientPayload: Buffer,
): Promise<EncryptedFrameSocket> {
  const rawSocket = new RawSocket(transport);
  return doHandshake(rawSocket, noiseKeyPriv, clientPayload);
}

async function doHandshake(
  rawSocket: RawSocket,
  noiseKeyPriv: Buffer,
  clientPayload: Buffer,
): Promise<EncryptedFrameSocket> {
  const state = new NoiseHandshakeState();
  const ephemeral = generateKeyPair();

  state.mixHash(ephemeral.pub);
  const clientHello = encodeHandshakeMessage({ clientHello: { ephemeral: ephemeral.pub } });

  const prependLength = (data: Buffer): Buffer => {
    const header = Buffer.alloc(3);
    header.writeUIntBE(data.length, 0, 3);
    return Buffer.concat([header, data]);
  };

  rawSocket.write(Buffer.concat([WA_HEADER, prependLength(clientHello)]));

  const serverHelloHeader = await rawSocket.readRaw(3);
  const serverHelloData = await rawSocket.readRaw(serverHelloHeader.readUIntBE(0, 3));
  const serverHello = decodeServerHello(serverHelloData);

  state.mixHash(serverHello.ephemeral);
  state.mixSharedSecret(ephemeral.priv, serverHello.ephemeral);
  const serverStaticPub = state.decrypt(serverHello.static);
  state.mixSharedSecret(ephemeral.priv, serverStaticPub);
  state.decrypt(serverHello.payload);

  const noisePub = publicFromPrivate(noiseKeyPriv);
  const encNoisePub = state.encrypt(noisePub);
  state.mixSharedSecret(noiseKeyPriv, serverHello.ephemeral);
  const encPayload = state.encrypt(clientPayload);

  const clientFinish = encodeHandshakeMessage({
    clientFinish: { static: encNoisePub, payload: encPayload },
  });
  rawSocket.write(prependLength(clientFinish));

  const keys = state.finish();
  return new EncryptedFrameSocket(rawSocket, keys.sendKey, keys.recvKey);
}

/** Open the encrypted WebSocket channel to Messenger's E2EE endpoint. */
export async function connectNoiseSocket(
  url: string,
  options: { headers?: Record<string, string>; perMessageDeflate?: boolean },
  noiseKeyPriv: Buffer,
  clientPayload: Buffer,
): Promise<EncryptedFrameSocket> {
  return new Promise((resolve, reject) => {
    const rawSocket = new RawSocket(new WebSocketTransport(url, options));
    let settled = false;

    rawSocket.once("error", (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    rawSocket.once("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("WebSocket closed during handshake"));
      }
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("E2EE handshake timed out"));
      }
    }, 15000);

    doHandshake(rawSocket, noiseKeyPriv, clientPayload).then(
      (socket) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          resolve(socket);
        }
      },
      (err: Error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(err);
        }
      },
    );
  });
}

export { marshal, unmarshal };
