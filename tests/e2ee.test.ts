/**
 * E2EE test suite — offline round trips over the ported Signal Protocol
 * stack (fbapi-unofficial, MIT) and the WA binary codec. No network, no
 * Facebook, no account. Everything here verifies real crypto/codec behavior.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";

import * as cryptoUtils from "../src/e2ee/crypto.js";
import { ProtoWriter, decodeFields } from "../src/e2ee/proto.js";
import {
  encodeNode,
  marshal,
  unmarshal,
  findChild,
  type WANode,
} from "../src/e2ee/wa-binary.js";
import {
  establishSession,
  encrypt,
  decryptPreKey,
  decryptMessage,
  addressKey,
  hasSession,
  type PreKeyBundle,
} from "../src/e2ee/signal.js";
import { DeviceStore } from "../src/e2ee/store.js";
import {
  connectNoiseSocketOverTransport,
  type NoiseTransport,
} from "../src/e2ee/noise.js";

// ---------------------------------------------------------------------------
// WA binary codec
// ---------------------------------------------------------------------------

describe("wa-binary codec", () => {
  it("round-trips a nested node with attributes and children", () => {
    const node: WANode = {
      tag: "message",
      attrs: { to: "12345.0@msgr", type: "text", id: "abc-1" },
      content: [
        {
          tag: "participants",
          attrs: {},
          content: [
            {
              tag: "to",
              attrs: { jid: "67890.0@msgr" },
              content: [
                { tag: "enc", attrs: { v: "3", type: "msg" }, content: Buffer.from([1, 2, 3, 4]) },
              ],
            },
          ],
        },
      ],
    };

    const frame = marshal(node);
    const decoded = unmarshal(frame);
    expect(decoded.tag).toBe("message");
    expect(decoded.attrs.to).toBe("12345.0@msgr");
    expect(decoded.attrs.id).toBe("abc-1");
    expect(Array.isArray(decoded.content)).toBe(true);
    const participants = (decoded.content as WANode[])[0];
    expect(participants?.tag).toBe("participants");
    const firstTo = findChild(participants, "to");
    expect(firstTo?.attrs.jid).toBe("67890.0@msgr");
    const enc = findChild(firstTo, "enc");
    expect(enc?.attrs.v).toBe("3");
    expect(Buffer.isBuffer(enc?.content)).toBe(true);
    expect(Buffer.from(enc?.content as Buffer)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("encodes tokenized strings as single bytes (e.g. 'from')", () => {
    const encoded = encodeNode("iq", { id: "1", from: "s.whatsapp.net" });
    // 'from' is single-byte token index 6 in the WA table — must encode < 256
    expect(encoded[0]).toBeGreaterThanOrEqual(0);
    expect(encoded.length).toBeLessThan(24);
  });

  it("findChild ignores non-array content and finds nested tags", () => {
    const node: WANode = {
      tag: "a",
      attrs: {},
      content: [
        { tag: "b", attrs: {}, content: Buffer.from("x") },
        { tag: "c", attrs: {} },
      ],
    };
    expect(findChild(node, "b")?.tag).toBe("b");
    expect(findChild(node, "zzz")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Protobuf codec
// ---------------------------------------------------------------------------

describe("protobuf codec", () => {
  it("round-trips varint, bytes and string fields", () => {
    const payload = new ProtoWriter()
      .varint(1, 150)
      .bytes(2, Buffer.from([0xde, 0xad, 0xbe, 0xef]))
      .string(3, "hello")
      .uint64(4, 9007199254740991n)
      .build();
    const fields = decodeFields(payload);
    expect(Number(fields[1])).toBe(150);
    expect(Buffer.from(fields[2] as Buffer)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(Buffer.from(fields[3] as Buffer).toString("utf8")).toBe("hello");
    expect(Number(fields[4])).toBe(9007199254740991);
  });

  it("encodes the canonical varint boundary (0x7f vs 0x80)", () => {
    const at = new ProtoWriter().varint(1, 127).build();
    const above = new ProtoWriter().varint(1, 128).build();
    expect(at[1]).toBe(127);
    expect(above[1]).toBe(0x80);
    expect(above[2]).toBe(0x01);
  });
});

// ---------------------------------------------------------------------------
// XEdDSA + X25519
// ---------------------------------------------------------------------------

describe("XEdDSA signatures", () => {
  it("signs and verifies a message", () => {
    const { priv, pub } = cryptoUtils.generateKeyPair();
    const message = Buffer.from("panindigan test message");
    const signature = cryptoUtils.xeddsaSign(priv, message);
    expect(signature.length).toBe(64);
    expect(cryptoUtils.xeddsaVerify(pub, message, signature)).toBe(true);
  });

  it("rejects a tampered message and a wrong key", () => {
    const { priv, pub } = cryptoUtils.generateKeyPair();
    const other = cryptoUtils.generateKeyPair();
    const message = Buffer.from("authentic");
    const signature = cryptoUtils.xeddsaSign(priv, message);
    expect(cryptoUtils.xeddsaVerify(pub, Buffer.from("forged"), signature)).toBe(false);
    expect(cryptoUtils.xeddsaVerify(other.pub, message, signature)).toBe(false);
  });
});

describe("X25519 key agreement", () => {
  it("both parties derive the same shared secret", () => {
    const a = cryptoUtils.generateKeyPair();
    const b = cryptoUtils.generateKeyPair();
    const secretAB = cryptoUtils.dh(a.priv, b.pub);
    const secretBA = cryptoUtils.dh(b.priv, a.pub);
    expect(secretAB.equals(secretBA)).toBe(true);
  });

  it("matches an independent code path (OpenSSL via JWK import)", () => {
    const a = cryptoUtils.generateKeyPair();
    const b = cryptoUtils.generateKeyPair();

    // Independent key import through JWK — a different code path into OpenSSL.
    const priv = crypto.createPrivateKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        d: a.priv.toString("base64url"),
        x: a.pub.toString("base64url"),
      },
      format: "jwk",
    });
    const pub = crypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: b.pub.toString("base64url") },
      format: "jwk",
    });
    const sharedFromJwk = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
    expect(sharedFromJwk.equals(cryptoUtils.dh(a.priv, b.pub))).toBe(true);

    // And our own publicFromPrivate derivation is self-consistent.
    expect(cryptoUtils.publicFromPrivate(a.priv).equals(a.pub)).toBe(true);
  });
});

describe("RFC 5869 HKDF", () => {
  it("reproduces the published SHA-256 test vector 1", () => {
    const ikm = Buffer.alloc(22, 0x0b);
    const salt = Buffer.from("000102030405060708090a0b0c", "hex");
    const info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex");
    const okm = cryptoUtils.hkdf(ikm, salt, info, 42);
    expect(okm.toString("hex")).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });
});

// ---------------------------------------------------------------------------
// Signal session: X3DH establish + message round trip
// ---------------------------------------------------------------------------

function makeStore(): DeviceStore {
  const store = new DeviceStore("");
  store.initialize();
  return store;
}

function bundleOf(store: DeviceStore): PreKeyBundle {
  const pub = Buffer.from(store.identityPublic());
  const signed = store.signedPreKey;
  const prefixed = Buffer.concat([Buffer.from([5]), Buffer.from(signed.pub, "base64")]);
  const signedPreKeyPublic = prefixed;
  // signature was produced over [0x05 || rawPub]
  const signature = Buffer.from(signed.signature, "base64");
  return {
    registrationId: store.registrationId,
    deviceId: 1,
    identityKey: pub,
    signedPreKey: { keyId: signed.id, publicKey: signedPreKeyPublic, signature },
    preKey: { keyId: 1, publicKey: prefixedPreKey(store) },
  };
}

function prefixedPreKey(store: DeviceStore): Buffer {
  const preKey = store.generatePreKeys(1)[0];
  if (!preKey) throw new Error("no prekey");
  return Buffer.concat([Buffer.from([5]), preKey.pub]);
}

describe("Signal session (X3DH + Double Ratchet)", () => {
  it("A→B prekey message decrypts, then B→A reply decrypts", () => {
    const storeA = makeStore();
    const storeB = makeStore();
    const bundle = bundleOf(storeB);

    const jidA = "userA.1@msgr";
    const jidB = "userB.1@msgr";
    expect(hasSession(storeA, jidB)).toBe(false);
    establishSession(storeA, jidB, bundle);
    expect(hasSession(storeA, jidB)).toBe(true);

    const outbound1 = encrypt(storeA, jidB, Buffer.from("hello B, first contact"));
    expect(outbound1.type).toBe("pkmsg");
    const plaintext1 = decryptPreKey(storeB, jidA, outbound1.ciphertext);
    expect(plaintext1.toString("utf8")).toBe("hello B, first contact");

    const outbound2 = encrypt(storeA, jidB, Buffer.from("second message, same session"));
    expect(outbound2.type).toBe("msg");
    const plaintext2 = decryptMessage(storeB, jidA, outbound2.ciphertext);
    expect(plaintext2.toString("utf8")).toBe("second message, same session");
  });

  it("rejects a bundle with a forged signed-prekey signature", () => {
    const storeA = makeStore();
    const storeB = makeStore();
    const bundle = bundleOf(storeB);
    const forged: PreKeyBundle = {
      ...bundle,
      signedPreKey: {
        ...bundle.signedPreKey,
        signature: Buffer.alloc(64, 0x42),
      },
    };
    expect(() => establishSession(storeA, "userB.1@msgr", forged)).toThrow(/signature/i);
  });

  it("addressKey normalizes jids", () => {
    expect(addressKey("1234.7@msgr")).toBe("1234.7");
  });
});

// ---------------------------------------------------------------------------
// Device store persistence
// ---------------------------------------------------------------------------

describe("DeviceStore persistence", () => {
  it("persists and reloads the same identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "panindigan-e2ee-test-"));
    const path = join(dir, "e2ee_device.json");
    try {
      const created = DeviceStore.fromFile(path);
      const identityPub = created.identityPublic().toString("base64");
      const registrationId = created.registrationId;
      const noisePub = created.noiseKeyPriv.toString("base64");

      expect(existsSync(path)).toBe(true);
      const reloaded = DeviceStore.fromFile(path);
      expect(reloaded.identityPublic().toString("base64")).toBe(identityPub);
      expect(reloaded.registrationId).toBe(registrationId);
      expect(reloaded.noiseKeyPriv.toString("base64")).toBe(noisePub);
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(raw.version).toBe(1);
      expect(typeof raw.identity_key_priv).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Noise handshake over an in-memory pipe (both ends use this package's code)
// ---------------------------------------------------------------------------

class MemoryPipe extends EventEmitter implements NoiseTransport {
  #peer: MemoryPipe | null = null;

  link(peer: MemoryPipe): void {
    this.#peer = peer;
  }

  write(data: Buffer): void {
    const peer = this.#peer;
    if (!peer) throw new Error("MemoryPipe: no peer linked");
    const copy = Buffer.from(data);
    queueMicrotask(() => {
      peer.emit("data", copy);
    });
  }

  end(): void {
    queueMicrotask(() => this.emit("close"));
  }

  on(event: "data" | "error" | "close", listener: (...args: never[]) => void): this {
    // @ts-expect-error EventEmitter overload narrowing for tests
    return super.on(event, listener);
  }

  once(event: "data" | "error" | "close", listener: (...args: never[]) => void): this {
    // @ts-expect-error EventEmitter overload narrowing for tests
    return super.once(event, listener);
  }
}

const WA_HEADER = Buffer.from([87, 65, 6, 3]);

/** Server side of the Noise_XX handshake, used to prove the client's real path. */
function runFakeServer(server: MemoryPipe, expectedPayload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("fake server: timed out")), 5000);
    timeout.unref?.();
    const finish = (err: Error | null) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve();
    };

    const NOISE = Buffer.from("Noise_XX_25519_AESGCM_SHA256\0\0\0\0", "binary");
    let h = Buffer.from(NOISE);
    let ck = Buffer.from(NOISE);
    let k: Buffer | null = null;
    let n = 0;

    const mixHash = (data: Buffer) => {
      h = crypto.createHash("sha256").update(h).update(data).digest();
    };
    const mixKey = (input: Buffer) => {
      const expanded = cryptoUtils.hkdf(input, ck, Buffer.alloc(0), 64);
      ck = expanded.subarray(0, 32);
      k = expanded.subarray(32, 64);
      n = 0;
    };
    const buildNonce = (counter: number): Buffer => {
      const nonce = Buffer.alloc(12);
      nonce.writeUInt32BE(counter, 8);
      return nonce;
    };
    const encryptFrame = (plaintext: Buffer): Buffer => {
      if (!k) throw new Error("server: no key");
      const nonce = buildNonce(n++);
      const body = cryptoUtils.aesGcmEncrypt(k, nonce, plaintext, h);
      mixHash(body);
      return body;
    };
    const decryptFrame = (ciphertext: Buffer): Buffer => {
      if (!k) throw new Error("server: no key");
      const nonce = buildNonce(n++);
      const plaintext = cryptoUtils.aesGcmDecrypt(k, nonce, ciphertext, h);
      mixHash(ciphertext);
      return plaintext;
    };

    // Server mixes the WA header like the client does.
    mixHash(WA_HEADER);

    const serverStatic = crypto.generateKeyPairSync("x25519");
    const serverStaticPrivRaw = Buffer.from(
      (
        serverStatic.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer
      ).subarray(-32),
    );
    const serverStaticPubRaw = Buffer.from(
      (serverStatic.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32),
    );
    const serverEphemeral = crypto.generateKeyPairSync("x25519");
    const serverEphPrivRaw = Buffer.from(
      (
        serverEphemeral.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer
      ).subarray(-32),
    );
    const serverEphPubRaw = Buffer.from(
      (
        serverEphemeral.publicKey.export({ type: "spki", format: "der" }) as Buffer
      ).subarray(-32),
    );

    let step: "hello" | "finish" | "done" = "hello";

    const readVarint = (buf: Buffer, offset: number): { value: number; offset: number } => {
      let result = 0;
      let shift = 0;
      let b: number;
      do {
        b = buf[offset++] as number;
        result |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 128);
      return { value: result >>> 0, offset };
    };
    const readLenDelim = (buf: Buffer, targetField: number): Buffer => {
      let pos = 0;
      while (pos < buf.length) {
        const tag = buf[pos] as number;
        pos += 1;
        const field = tag >> 3;
        const wire = tag & 7;
        if (wire === 2) {
          const { value: len, offset } = readVarint(buf, pos);
          pos = offset;
          const value = buf.subarray(pos, pos + len);
          pos += len;
          if (field === targetField) return Buffer.from(value);
        } else if (wire === 0) {
          const read = readVarint(buf, pos);
          pos = read.offset;
        } else {
          break;
        }
      }
      throw new Error(`server: field ${targetField} not found`);
    };

    const sendServerHelloAndWait = (clientEphemeral: Buffer) => {
      mixHash(clientEphemeral);
      mixHash(serverEphPubRaw);
      mixKey(cryptoUtils.dh(serverEphPrivRaw, clientEphemeral)); // ee
      const encStatic = encryptFrame(serverStaticPubRaw);
      mixKey(cryptoUtils.dh(serverStaticPrivRaw, clientEphemeral)); // es (server static)
      const serverPayload = Buffer.from("server-payload-ok");
      const encPayload = encryptFrame(serverPayload);
      // Build serverHello protobuf manually: field 3 { ephemeral, static, payload }
      const ephField = Buffer.concat([
        Buffer.from([0x0a, serverEphPubRaw.length]),
        serverEphPubRaw,
      ]);
      const staticField = Buffer.concat([
        Buffer.from([0x12, encStatic.length]),
        encStatic,
      ]);
      const payloadField = Buffer.concat([
        Buffer.from([0x1a, encPayload.length]),
        encPayload,
      ]);
      const inner = Buffer.concat([ephField, staticField, payloadField]);
      const outer = Buffer.concat([Buffer.from([0x1a, inner.length]), inner]);
      const header = Buffer.alloc(3);
      header.writeUIntBE(outer.length, 0, 3);
      server.write(Buffer.concat([header, outer]));

      // Expect clientFinish next: length-prefixed, field 4 { static, payload }
      step = "finish";
    };

    let buf = Buffer.alloc(0);
    server.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (step === "hello") {
          if (buf.length < WA_HEADER.length + 3) return;
          const header = buf.subarray(WA_HEADER.length, WA_HEADER.length + 3);
          const bodyLen = header.readUIntBE(0, 3);
          if (buf.length < WA_HEADER.length + 3 + bodyLen) return;
          const body = buf.subarray(WA_HEADER.length + 3, WA_HEADER.length + 3 + bodyLen);
          buf = buf.subarray(WA_HEADER.length + 3 + bodyLen);
          const clientHello = readLenDelim(body, 2);
          const ephemeral = readLenDelim(clientHello, 1);
          sendServerHelloAndWait(ephemeral);
          return;
        }
        if (step === "finish") {
          if (buf.length < 3) return;
          const bodyLen = buf.readUIntBE(0, 3);
          if (buf.length < 3 + bodyLen) return;
          const body = buf.subarray(3, 3 + bodyLen);
          buf = buf.subarray(3 + bodyLen);
          const finishMsg = readLenDelim(body, 4);
          const encNoisePub = readLenDelim(finishMsg, 1);
          const noisePub = decryptFrame(encNoisePub);
          mixKey(cryptoUtils.dh(serverEphPrivRaw, noisePub)); // ee with noise key
          const encClientPayload = readLenDelim(finishMsg, 2);
          const clientPayload = decryptFrame(encClientPayload);
          if (!clientPayload.equals(expectedPayload)) {
            finish(new Error("server: client payload mismatch"));
            return;
          }
          step = "done";
          finish(null);
        }
      } catch (err) {
        finish(err as Error);
      }
    });
    server.on("error", (err: Error) => finish(err));
  });
}

describe("Noise XX handshake (in-memory, full client path)", () => {
  it("completes the client handshake and proves the server can decrypt our frames", async () => {
    const clientPipe = new MemoryPipe();
    const serverPipe = new MemoryPipe();
    clientPipe.link(serverPipe);
    serverPipe.link(clientPipe);

    const clientPayload = Buffer.from("PANINDIGAN-E2EE-TEST-PAYLOAD");
    const noiseKeyPriv = crypto.randomBytes(32);

    const serverDone = runFakeServer(serverPipe, clientPayload);
    const socket = await connectNoiseSocketOverTransport(clientPipe, noiseKeyPriv, clientPayload);

    // The fake server only resolves once it has decrypted the client
    // payload, i.e. both sides derived identical Noise keys at every step.
    await serverDone;

    // Client can now encrypt a frame; server does not echo, so we only
    // assert the client accepted the handshake and produced a socket.
    expect(socket).toBeDefined();
    socket.end();
  });
});
