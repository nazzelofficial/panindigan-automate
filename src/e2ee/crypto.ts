/**
 * Signal/E2EE cryptographic primitives — ported from
 * bhhoang/fbapi-unofficial (MIT), https://github.com/bhhoang/fbapi-unofficial
 * (src/e2ee/crypto.js), MIT licensed by bhhoang and contributors.
 *
 * Copyright (c) bhhoang and contributors of fbapi-unofficial.
 * Licensed MIT (see their LICENSE-MIT). Ported to TypeScript with only
 * module-syntax adjustments; protocol behaviour is unchanged.
 *
 * Implements X25519 key exchange via Node's crypto, and XEdDSA (Curve25519
 * signatures over the Edwards form of a Montgomery key, as libsignal and
 * Meta require for Signal signed prekeys).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";

const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

const B = BigInt;
const ZERO = B(0);
const ONE = B(1);
const TWO = B(2);
const EIGHT = B(8);

const P = B("57896044618658097711785492504343953926634992332820282019728792003956564819949");
const Q = B("7237005577332262213973186563042994240857116359379907606001950938285454250989");
const D = B("37095705934669439343138083508754565189542113879843219016388785533085940283555");
const BASE_Y = B("46316835694926478169428394003475163141307993866256225615783033603165251855960");
const SQRT_M1 = B("19681161376707505956807079304988542015446066515923890162744021073123829784752");
const MASK_255 = (ONE << B(255)) - ONE;

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r < ZERO ? r + m : r;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = ONE;
  let b = mod(base, m);
  let e = exp;
  while (e > ZERO) {
    if (e & ONE) result = (result * b) % m;
    b = (b * b) % m;
    e >>= ONE;
  }
  return result;
}

function inv(a: bigint): bigint {
  return modPow(a, P - TWO, P);
}

function bytesToBigIntLE(buf: Buffer): bigint {
  let out = ZERO;
  for (let i = buf.length - 1; i >= 0; i--) out = (out << EIGHT) | B(buf[i] as number);
  return out;
}

function bigIntToBytesLE(value: bigint, len: number): Buffer {
  const out = Buffer.alloc(len);
  let v = value;
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & B(0xff));
    v >>= EIGHT;
  }
  return out;
}

function sqrtRatio(a: bigint): bigint {
  let x = modPow(a, (P + B(3)) >> B(3), P);
  if (mod(x * x) !== mod(a)) x = mod(x * SQRT_M1);
  return x;
}

function basePoint(): { x: bigint; y: bigint } {
  const x2 = mod((BASE_Y * BASE_Y - ONE) * inv(D * BASE_Y * BASE_Y + ONE));
  let x = sqrtRatio(x2);
  if (x & ONE) x = P - x;
  return { x, y: BASE_Y };
}

const BASE = basePoint();

function pointNeg(a: { x: bigint; y: bigint }): { x: bigint; y: bigint } {
  return { x: mod(-a.x), y: a.y };
}

const D2 = mod(TWO * D);

function extendedAdd(
  p: { X: bigint; Y: bigint; Z: bigint; T: bigint },
  q: { X: bigint; Y: bigint; Z: bigint; T: bigint },
): { X: bigint; Y: bigint; Z: bigint; T: bigint } {
  const a = mod((p.Y - p.X) * (q.Y - q.X));
  const b = mod((p.Y + p.X) * (q.Y + q.X));
  const c = mod(p.T * D2 * q.T);
  const d = mod(TWO * p.Z * q.Z);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return { X: mod(e * f), Y: mod(g * h), Z: mod(f * g), T: mod(e * h) };
}

function scalarMult(k: bigint, point: { x: bigint; y: bigint }): { x: bigint; y: bigint } | null {
  let result: { X: bigint; Y: bigint; Z: bigint; T: bigint } | null = null;
  let addend = { X: point.x, Y: point.y, Z: ONE, T: mod(point.x * point.y) };
  let n = k;
  while (n > ZERO) {
    if (n & ONE) result = result ? extendedAdd(result, addend) : addend;
    addend = extendedAdd(addend, addend);
    n >>= ONE;
  }
  if (!result) return null;
  const zInv = inv(result.Z);
  return { x: mod(result.X * zInv), y: mod(result.Y * zInv) };
}

function encodePoint(point: { x: bigint; y: bigint }): Buffer {
  const out = bigIntToBytesLE(point.y, 32);
  if (point.x & ONE) out[31] = (out[31] as number) | 0x80;
  return out;
}

function clampScalar(priv: Buffer): Buffer {
  const out = Buffer.from(priv);
  out[0] = (out[0] as number) & 0xf8;
  out[31] = (out[31] as number) & 0x7f;
  out[31] = (out[31] as number) | 0x40;
  return out;
}

function deriveEdwardsKey(priv: Buffer): { scalar: bigint; point: { x: bigint; y: bigint } } {
  let scalar = bytesToBigIntLE(clampScalar(priv));
  const point = scalarMult(scalar, BASE);
  if (point === null) {
    throw new Error("XEdDSA: invalid base point scalar multiplication");
  }
  if (point.x & ONE) {
    scalar = Q - scalar;
    const neg = pointNeg(point);
    return { scalar, point: neg };
  }
  return { scalar, point };
}

function sha512(data: Buffer): Buffer {
  return createHash("sha512").update(data).digest();
}

export function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function hashToScalar(data: Buffer): bigint {
  return mod(bytesToBigIntLE(sha512(data)), Q);
}

/** XEdDSA signature of `message` with an X25519-style Curve25519 private key. */
export function xeddsaSign(priv: Buffer, message: Buffer): Buffer {
  const key = deriveEdwardsKey(priv);
  const prefix = Buffer.alloc(32, 0xff);
  prefix[0] = 0xfe;
  const nonce = hashToScalar(Buffer.concat([prefix, priv, message, randomBytes(64)]));
  const rPoint = scalarMult(nonce, BASE);
  if (rPoint === null) {
    throw new Error("XEdDSA: invalid nonce scalar multiplication");
  }
  const aEncoded = encodePoint(key.point);
  const h = hashToScalar(Buffer.concat([encodePoint(rPoint), aEncoded, message]));
  const s = mod(nonce + h * key.scalar, Q);
  return Buffer.concat([encodePoint(rPoint), bigIntToBytesLE(s, 32)]);
}

/** XEdDSA verification against the Edwards form of the Montgomery public key. */
export function xeddsaVerify(pub: Buffer, message: Buffer, signature: Buffer): boolean {
  if (signature.length !== 64 || pub.length !== 32) return false;
  const sig = Buffer.from(signature);
  const u = bytesToBigIntLE(pub) & MASK_255;
  const aEncoded = bigIntToBytesLE(mod((u - ONE) * inv(u + ONE)), 32);
  aEncoded[31] = (aEncoded[31] as number) | ((sig[63] as number) & 0x80);
  sig[63] = (sig[63] as number) & 0x7f;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, aEncoded]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}

/** Generate an X25519 key pair (raw 32-byte keys). */
export function generateKeyPair(): { priv: Buffer; pub: Buffer } {
  const pair = generateKeyPairSync("x25519");
  const privDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
  const pubDer = pair.publicKey.export({ type: "spki", format: "der" });
  return {
    priv: Buffer.from(privDer.subarray(privDer.length - 32)),
    pub: Buffer.from(pubDer.subarray(pubDer.length - 32)),
  };
}

/** Derive the X25519 public key from a raw 32-byte private key. */
export function publicFromPrivate(priv: Buffer): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, priv]),
    format: "der",
    type: "pkcs8",
  });
  const pubDer = createPublicKey(key).export({ type: "spki", format: "der" });
  return Buffer.from(pubDer.subarray(pubDer.length - 32));
}

/** X25519 Diffie-Hellman between raw 32-byte keys. */
export function dh(priv: Buffer, pub: Buffer): Buffer {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, priv]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_X25519, pub]),
    format: "der",
    type: "spki",
  });
  return diffieHellman({ privateKey, publicKey });
}

/** HMAC-SHA256. */
export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 5869 HKDF-SHA256. */
export function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/** AES-256-CBC encrypt (no padding normalization; matches the reference). */
export function aesCbcEncrypt(key: Buffer, iv: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** AES-256-CBC decrypt. */
export function aesCbcDecrypt(key: Buffer, iv: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-256-GCM encrypt; ciphertext with tag appended. */
export function aesGcmEncrypt(key: Buffer, iv: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad && aad.length) cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([body, tag]);
}

/** AES-256-GCM decrypt; tag is the trailing 16 bytes. */
export function aesGcmDecrypt(key: Buffer, iv: Buffer, ciphertext: Buffer, aad?: Buffer): Buffer {
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad && aad.length) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
