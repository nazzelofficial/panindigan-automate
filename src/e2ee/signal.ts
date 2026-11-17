/**
 * Signal Protocol session engine for the FB E2EE transport — ported from
 * bhhoang/fbapi-unofficial (MIT), https://github.com/bhhoang/fbapi-unofficial
 * (src/e2ee/signal.js), MIT licensed by bhhoang and contributors.
 *
 * Copyright (c) bhhoang and contributors of fbapi-unofficial.
 * Licensed MIT. Ported to TypeScript with only module-syntax and
 * type-annotation adjustments; protocol behaviour is unchanged.
 *
 * X3DH key agreement (with XEdDSA-signed prekeys) and a Double Ratchet style
 * message layer, matching the format Meta's web E2EE client uses on the wire.
 */

import { timingSafeEqual } from "node:crypto";
import {
  generateKeyPair,
  dh,
  hmacSha256,
  hkdf,
  xeddsaVerify,
  aesCbcEncrypt,
  aesCbcDecrypt,
} from "./crypto.js";
import { ProtoWriter, decodeFields } from "./proto.js";

const ZERO32 = Buffer.alloc(32);
export const MESSAGE_VERSION = 3;
const SERIALIZED_PREFIX = 0x34;
const MAC_LENGTH = 8;

export interface ParsedJid {
  readonly user: string;
  readonly device: number;
  readonly server: string;
}

/** Parse "user.device@server" or "user.0@msgr"-style JIDs. */
export function parseJid(jid: string): ParsedJid {
  const at = jid.indexOf("@");
  const userPart = at === -1 ? jid : jid.slice(0, at);
  const server = at === -1 ? "" : jid.slice(at + 1);
  const dot = userPart.indexOf(".");
  const colon = userPart.indexOf(":");
  const userEnd = dot !== -1 ? dot : colon !== -1 ? colon : userPart.length;
  const user = userPart.slice(0, userEnd) || userPart;
  const devicePart =
    colon !== -1 ? userPart.slice(colon + 1) : dot !== -1 ? userPart.slice(dot + 1) : "0";
  return { user, device: Number(devicePart) || 0, server };
}

export function addressKey(jid: string): string {
  const parsed = parseJid(jid);
  return parsed.user + "." + parsed.device;
}

function concatPublicKey(raw32: Buffer): Buffer {
  return Buffer.concat([Buffer.from([5]), raw32]);
}

export interface PreKeyBundle {
  readonly registrationId: number;
  readonly deviceId: number;
  readonly identityKey: Buffer;
  readonly signedPreKey: {
    readonly keyId: number;
    readonly publicKey: Buffer;
    readonly signature: Buffer;
  };
  readonly preKey?: {
    readonly keyId: number;
    readonly publicKey: Buffer;
  };
}

export interface OutboundSignalMessage {
  readonly type: "pkmsg" | "msg";
  readonly ciphertext: Buffer;
}

export interface SessionState {
  rootKey: string;
  senderRatchetPriv: string;
  senderRatchetPub: string;
  senderChainKey: string;
  senderCounter: number;
  previousCounter: number;
  remoteRatchetKey: string | null;
  receiverChainKey: string | null;
  receiverCounter: number;
  remoteIdentity: string;
  remoteRegistrationId: number;
  skippedKeys?: Record<string, { cipherKey: string; macKey: string; iv: string }>;
  processedPreKeyBaseKey?: string;
  pendingPreKey?: {
    preKeyId: number | null;
    signedPreKeyId: number;
    baseKey: string;
    identityKey: string;
    registrationId: number;
  };
  recentMessageKeys?: Record<string, { cipherKey: string; macKey: string; iv: string; body: string }>;
  recentMessageKeyOrder?: string[];
}

export interface SessionStore {
  sessions: Record<string, SessionState>;
  identities: Record<string, number>;
  identityKeyPair: { priv: Buffer; pub: Buffer };
  registrationId: number;
  getSignedPreKeyById(id: number): { id: number; priv: string; pub: string; signature: string } | null;
  takePreKey(id: number): { priv: string } | null;
  getUsedPreKey(id: number): { priv: string } | null;
  save?(): void;
}

function b64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function toB64(value: Buffer): string {
  return Buffer.from(value).toString("base64");
}

function deriveMasterSecret(identityPriv: Buffer, basePriv: Buffer, bundle: PreKeyBundle): Buffer {
  const theirIdentity = bundle.identityKey;
  const theirSigned = bundle.signedPreKey.publicKey.subarray(1);
  const parts = [
    Buffer.alloc(32, 0xff),
    dh(identityPriv, theirSigned),
    dh(basePriv, theirIdentity),
    dh(basePriv, theirSigned),
  ];
  if (bundle.preKey && bundle.preKey.publicKey) {
    parts.push(dh(basePriv, bundle.preKey.publicKey.subarray(1)));
  }
  return Buffer.concat(parts);
}

function createChain(
  rootKey: Buffer,
  theirRatchetKey: Buffer,
  ourRatchetPriv: Buffer,
): { rootKey: Buffer; chainKey: Buffer } {
  const derived = hkdf(
    dh(ourRatchetPriv, theirRatchetKey),
    rootKey,
    Buffer.from("WhisperRatchet"),
    64,
  );
  return { rootKey: derived.subarray(0, 32), chainKey: derived.subarray(32, 64) };
}

function deriveMessageKeys(messageKey: Buffer): { cipherKey: Buffer; macKey: Buffer; iv: Buffer } {
  const derived = hkdf(messageKey, ZERO32, Buffer.from("WhisperMessageKeys"), 80);
  return {
    cipherKey: derived.subarray(0, 32),
    macKey: derived.subarray(32, 64),
    iv: derived.subarray(64, 80),
  };
}

function advanceChainKey(chainKey: Buffer): { messageKey: Buffer; nextChainKey: Buffer } {
  return {
    messageKey: hmacSha256(chainKey, Buffer.from([1])),
    nextChainKey: hmacSha256(chainKey, Buffer.from([2])),
  };
}

function computeMac(
  macKey: Buffer,
  senderIdentity: Buffer,
  receiverIdentity: Buffer,
  serializedBody: Buffer,
): Buffer {
  return hmacSha256(macKey, Buffer.concat([senderIdentity, receiverIdentity, serializedBody])).subarray(
    0,
    MAC_LENGTH,
  );
}

function stripKeyPrefix(buf: Buffer): Buffer {
  return buf.length === 33 ? Buffer.from(buf.subarray(1)) : Buffer.from(buf);
}

interface DecodedSignalMessage {
  readonly prefix: number;
  readonly body: Buffer;
  readonly mac: Buffer;
  readonly ratchetKey: Buffer | null;
  readonly counter: number;
  readonly previousCounter: number;
  readonly ciphertext: Buffer;
}

function decodeSignalMessage(ciphertext: Buffer): DecodedSignalMessage {
  if (ciphertext.length < 1 + MAC_LENGTH) {
    throw new Error("Signal message is too short");
  }
  const prefix = ciphertext[0] as number;
  if (prefix !== SERIALIZED_PREFIX && prefix !== 0x33) {
    throw new Error(`Unexpected Signal message version ${prefix}`);
  }
  const bodyWithMac = ciphertext.subarray(1);
  const body = bodyWithMac.subarray(0, bodyWithMac.length - MAC_LENGTH);
  const mac = bodyWithMac.subarray(bodyWithMac.length - MAC_LENGTH);
  const fields = decodeFields(body);
  return {
    prefix,
    body,
    mac,
    ratchetKey: fields[1] ? stripKeyPrefix(Buffer.from(fields[1] as Buffer)) : null,
    counter: Number(fields[2] ?? 0),
    previousCounter: Number(fields[3] ?? 0),
    ciphertext: fields[4] ? Buffer.from(fields[4] as Buffer) : Buffer.alloc(0),
  };
}

interface DecodedPreKeySignalMessage {
  readonly prefix: number;
  readonly preKeyId: number | null;
  readonly baseKey: Buffer | null;
  readonly identityKey: Buffer | null;
  readonly message: Buffer | null;
  readonly registrationId: number;
  readonly signedPreKeyId: number;
}

function decodePreKeySignalMessage(bytes: Buffer): DecodedPreKeySignalMessage {
  if (!bytes || bytes.length < 2) throw new Error("PreKeySignalMessage is too short");
  const prefix = bytes[0] as number;
  if (prefix !== SERIALIZED_PREFIX && prefix !== 0x33) {
    throw new Error(`Unexpected PreKeySignalMessage version ${prefix}`);
  }
  const fields = decodeFields(bytes.subarray(1));
  return {
    prefix,
    preKeyId: fields[1] !== undefined ? Number(fields[1]) : null,
    baseKey: fields[2] ? stripKeyPrefix(Buffer.from(fields[2] as Buffer)) : null,
    identityKey: fields[3] ? stripKeyPrefix(Buffer.from(fields[3] as Buffer)) : null,
    message: fields[4] ? Buffer.from(fields[4] as Buffer) : null,
    registrationId: Number(fields[5] ?? 0),
    signedPreKeyId: Number(fields[6] ?? 0),
  };
}

function skipKeyId(ratchetKeyB64: string, counter: number): string {
  return ratchetKeyB64 + ":" + counter;
}

function deriveMessageKeysForKey(
  chainKey: Buffer,
): { keys: { cipherKey: Buffer; macKey: Buffer; iv: Buffer }; nextChainKey: Buffer } {
  const advanced = advanceChainKey(chainKey);
  return { keys: deriveMessageKeys(advanced.messageKey), nextChainKey: advanced.nextChainKey };
}

function storeSkippedKeys(
  session: SessionState,
  ratchetKeyB64: string,
  fromCounter: number,
  toCounter: number,
): void {
  if (toCounter <= fromCounter || !session.receiverChainKey) return;
  session.skippedKeys = session.skippedKeys ?? {};
  let chainKey = b64(session.receiverChainKey);
  for (let index = fromCounter; index < toCounter; index++) {
    const step = deriveMessageKeysForKey(chainKey);
    session.skippedKeys[skipKeyId(ratchetKeyB64, index)] = {
      cipherKey: toB64(step.keys.cipherKey),
      macKey: toB64(step.keys.macKey),
      iv: toB64(step.keys.iv),
    };
    chainKey = step.nextChainKey;
  }
  session.receiverChainKey = toB64(chainKey);
  session.receiverCounter = toCounter;
  const ids = Object.keys(session.skippedKeys);
  if (ids.length > 2000) {
    for (const id of ids.slice(0, ids.length - 2000)) {
      delete session.skippedKeys[id];
    }
  }
}

function sameBuffer(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function rememberRecentMessageKey(
  session: SessionState,
  counterKey: string,
  keys: { cipherKey: Buffer; macKey: Buffer; iv: Buffer },
  body: Buffer,
): void {
  if (!session.recentMessageKeys) session.recentMessageKeys = {};
  if (!session.recentMessageKeyOrder) session.recentMessageKeyOrder = [];
  if (!session.recentMessageKeys[counterKey]) {
    session.recentMessageKeyOrder.push(counterKey);
  }
  session.recentMessageKeys[counterKey] = {
    cipherKey: toB64(keys.cipherKey),
    macKey: toB64(keys.macKey),
    iv: toB64(keys.iv),
    body: toB64(body),
  };
  while (session.recentMessageKeyOrder.length > 50) {
    const shift = session.recentMessageKeyOrder.shift();
    if (shift !== undefined) delete session.recentMessageKeys[shift];
  }
}

function decryptWithSession(
  store: SessionStore,
  jid: string,
  session: SessionState,
  message: DecodedSignalMessage,
  isPreKeyMessage: boolean,
  skipSave = false,
): Buffer {
  if (!message.ratchetKey) throw new Error("Signal message has no ratchet key");
  const ratchetKeyB64 = toB64(message.ratchetKey);
  if (session.remoteRatchetKey !== ratchetKeyB64) {
    if (session.receiverChainKey && session.remoteRatchetKey !== null) {
      const previous = message.previousCounter || 0;
      storeSkippedKeys(session, session.remoteRatchetKey, session.receiverCounter, previous);
    }
    const receive = createChain(
      b64(session.rootKey),
      message.ratchetKey,
      b64(session.senderRatchetPriv),
    );
    session.rootKey = toB64(receive.rootKey);
    session.receiverChainKey = toB64(receive.chainKey);
    session.receiverCounter = 0;
    session.remoteRatchetKey = ratchetKeyB64;

    const ratchet = generateKeyPair();
    const send = createChain(receive.rootKey, message.ratchetKey, ratchet.priv);
    session.rootKey = toB64(send.rootKey);
    session.senderRatchetPriv = toB64(ratchet.priv);
    session.senderRatchetPub = toB64(ratchet.pub);
    session.senderChainKey = toB64(send.chainKey);
    session.previousCounter = session.senderCounter;
    session.senderCounter = 0;
    if (isPreKeyMessage) delete session.pendingPreKey;
  }

  let messageKeys: { cipherKey: Buffer; macKey: Buffer; iv: Buffer };
  const counterKey = skipKeyId(ratchetKeyB64, message.counter);
  if (message.counter < session.receiverCounter) {
    const skipped = session.skippedKeys?.[counterKey];
    const recent = session.recentMessageKeys?.[counterKey];
    if (recent && recent.body === toB64(message.body)) {
      throw new Error(`Duplicate or too old message (counter ${message.counter})`);
    }
    if (recent) {
      messageKeys = { cipherKey: b64(recent.cipherKey), macKey: b64(recent.macKey), iv: b64(recent.iv) };
    } else if (skipped) {
      messageKeys = { cipherKey: b64(skipped.cipherKey), macKey: b64(skipped.macKey), iv: b64(skipped.iv) };
      if (session.skippedKeys) delete session.skippedKeys[counterKey];
      rememberRecentMessageKey(session, counterKey, messageKeys, message.body);
    } else {
      throw new Error(`Duplicate or too old message (counter ${message.counter})`);
    }
  } else {
    storeSkippedKeys(session, ratchetKeyB64, session.receiverCounter, message.counter);
    const step = deriveMessageKeysForKey(b64(session.receiverChainKey as string));
    messageKeys = step.keys;
    session.receiverChainKey = toB64(step.nextChainKey);
    session.receiverCounter = message.counter + 1;
    rememberRecentMessageKey(session, counterKey, messageKeys, message.body);
  }

  const senderIdentity = concatPublicKey(b64(session.remoteIdentity));
  const receiverIdentity = concatPublicKey(store.identityKeyPair.pub);
  const expectedMac = computeMac(
    messageKeys.macKey,
    senderIdentity,
    receiverIdentity,
    Buffer.concat([Buffer.from([message.prefix]), message.body]),
  );
  if (!sameBuffer(expectedMac, message.mac)) {
    throw new Error(`Bad MAC on E2EE message from ${jid}`);
  }

  const plaintext = aesCbcDecrypt(messageKeys.cipherKey, messageKeys.iv, message.ciphertext);
  if (!skipSave) saveSession(store, jid, session);
  return plaintext;
}

function decryptMessageWithSession(
  store: SessionStore,
  senderJid: string,
  session: SessionState,
  message: DecodedSignalMessage,
): Buffer {
  return decryptWithSession(store, senderJid, session, message, false);
}

/** Decrypt a PreKeySignalMessage (first message of a session). */
export function decryptPreKey(
  store: SessionStore,
  senderJid: string,
  ciphertext: Buffer,
): Buffer {
  const preKeyMessage = decodePreKeySignalMessage(ciphertext);
  if (preKeyMessage.baseKey === null || preKeyMessage.identityKey === null || preKeyMessage.message === null) {
    throw new Error("PreKeySignalMessage is missing required fields");
  }
  const existing = store.sessions[addressKey(senderJid)];
  if (existing && existing.processedPreKeyBaseKey === toB64(preKeyMessage.baseKey)) {
    return decryptMessageWithSession(
      store,
      senderJid,
      existing,
      decodeSignalMessage(preKeyMessage.message),
    );
  }

  const signed = store.getSignedPreKeyById(preKeyMessage.signedPreKeyId);
  if (!signed) {
    throw new Error(`No signed prekey ${preKeyMessage.signedPreKeyId} for ${senderJid}`);
  }
  let oneTime: { priv: string } | null = null;
  let replayedPreKey = false;
  if (preKeyMessage.preKeyId !== null) {
    oneTime = store.takePreKey(preKeyMessage.preKeyId);
    if (!oneTime) {
      oneTime = store.getUsedPreKey(preKeyMessage.preKeyId);
      replayedPreKey = oneTime !== null;
    }
    if (!oneTime) {
      throw new Error(`No one-time prekey ${preKeyMessage.preKeyId} for ${senderJid}`);
    }
  }

  const ourSignedPriv = b64(signed.priv);
  const parts = [
    Buffer.alloc(32, 0xff),
    dh(ourSignedPriv, preKeyMessage.identityKey),
    dh(store.identityKeyPair.priv, preKeyMessage.baseKey),
    dh(ourSignedPriv, preKeyMessage.baseKey),
  ];
  if (oneTime) {
    parts.push(dh(b64(oneTime.priv), preKeyMessage.baseKey));
  }
  const derived = hkdf(Buffer.concat(parts), ZERO32, Buffer.from("WhisperText"), 64);

  const session: SessionState = {
    rootKey: toB64(derived.subarray(0, 32)),
    senderRatchetPriv: signed.priv,
    senderRatchetPub: signed.pub,
    senderChainKey: toB64(derived.subarray(32, 64)),
    senderCounter: 0,
    previousCounter: 0,
    remoteRatchetKey: null,
    receiverChainKey: null,
    receiverCounter: 0,
    remoteIdentity: toB64(preKeyMessage.identityKey),
    remoteRegistrationId: preKeyMessage.registrationId,
    skippedKeys: {},
    processedPreKeyBaseKey: toB64(preKeyMessage.baseKey),
  };
  if (replayedPreKey) {
    return decryptWithSession(
      store,
      senderJid,
      session,
      decodeSignalMessage(preKeyMessage.message),
      true,
      true,
    );
  }
  store.sessions[addressKey(senderJid)] = session;
  store.identities[preKeyMessage.identityKey.toString("base64")] = 1;
  store.save?.();

  return decryptWithSession(store, senderJid, session, decodeSignalMessage(preKeyMessage.message), true);
}

/** Decrypt a regular (non-prekey) Signal message. */
export function decryptMessage(store: SessionStore, senderJid: string, ciphertext: Buffer): Buffer {
  const session = store.sessions[addressKey(senderJid)];
  if (!session) throw new Error(`No session for ${senderJid}`);
  return decryptMessageWithSession(store, senderJid, session, decodeSignalMessage(ciphertext));
}

function encodePreKeySignalMessage(session: SessionState, signalMessage: Buffer): Buffer {
  const pending = session.pendingPreKey;
  if (!pending) throw new Error("encodePreKeySignalMessage: session has no pending prekey");
  const writer = new ProtoWriter();
  if (pending.preKeyId !== undefined && pending.preKeyId !== null) {
    writer.varint(1, pending.preKeyId);
  }
  writer
    .bytes(2, Buffer.from(pending.baseKey, "base64"))
    .bytes(3, Buffer.from(pending.identityKey, "base64"))
    .bytes(4, signalMessage)
    .varint(5, pending.registrationId)
    .varint(6, pending.signedPreKeyId);
  return Buffer.concat([Buffer.from([SERIALIZED_PREFIX]), writer.build()]);
}

export function hasSession(store: SessionStore, jid: string): boolean {
  return store.sessions[addressKey(jid)] !== undefined;
}

function saveSession(store: SessionStore, jid: string, session: SessionState): void {
  store.sessions[addressKey(jid)] = session;
  store.save?.();
}

function verifyBundleSignature(bundle: PreKeyBundle): boolean {
  if (!bundle.signedPreKey.signature) return true;
  return xeddsaVerify(bundle.identityKey, bundle.signedPreKey.publicKey, bundle.signedPreKey.signature);
}

/** Establish a session from the recipient's prekey bundle; persists it. */
export function establishSession(store: SessionStore, jid: string, bundle: PreKeyBundle): SessionState {
  if (!verifyBundleSignature(bundle)) {
    throw new Error(`Invalid signed prekey signature for ${jid}`);
  }
  const identity = store.identityKeyPair;
  const base = generateKeyPair();
  const ratchet = generateKeyPair();
  const master = deriveMasterSecret(identity.priv, base.priv, bundle);
  const derived = hkdf(master, ZERO32, Buffer.from("WhisperText"), 64);
  const chain = createChain(derived.subarray(0, 32), bundle.signedPreKey.publicKey.subarray(1), ratchet.priv);
  const session: SessionState = {
    rootKey: toB64(chain.rootKey),
    senderRatchetPriv: toB64(ratchet.priv),
    senderRatchetPub: toB64(ratchet.pub),
    senderChainKey: toB64(chain.chainKey),
    senderCounter: 0,
    previousCounter: 0,
    remoteRatchetKey: toB64(bundle.signedPreKey.publicKey.subarray(1)),
    remoteIdentity: toB64(bundle.identityKey),
    remoteRegistrationId: bundle.registrationId,
    receiverChainKey: null,
    receiverCounter: 0,
    pendingPreKey: {
      preKeyId: bundle.preKey ? bundle.preKey.keyId : null,
      signedPreKeyId: bundle.signedPreKey.keyId,
      baseKey: toB64(concatPublicKey(base.pub)),
      identityKey: toB64(concatPublicKey(identity.pub)),
      registrationId: store.registrationId,
    },
  };
  if (store.identities[bundle.identityKey.toString("base64")] === undefined) {
    store.identities[bundle.identityKey.toString("base64")] = 1;
  }
  saveSession(store, jid, session);
  return session;
}

/** Encrypt a plaintext for a session established with establishSession(). */
export function encrypt(
  store: SessionStore,
  jid: string,
  plaintext: Buffer,
): OutboundSignalMessage {
  const session = store.sessions[addressKey(jid)];
  if (!session) throw new Error(`No session with ${jid}`);
  const chain = advanceChainKey(b64(session.senderChainKey));
  const keys = deriveMessageKeys(chain.messageKey);
  const ciphertext = aesCbcEncrypt(keys.cipherKey, keys.iv, plaintext);
  const ratchetPub = b64(session.senderRatchetPub);
  const body = new ProtoWriter()
    .bytes(1, concatPublicKey(ratchetPub))
    .varint(2, session.senderCounter)
    .varint(3, session.previousCounter)
    .bytes(4, ciphertext)
    .build();
  const identity = store.identityKeyPair;
  const remoteIdentity = b64(session.remoteIdentity);
  const mac = computeMac(
    keys.macKey,
    concatPublicKey(identity.pub),
    concatPublicKey(remoteIdentity),
    Buffer.concat([Buffer.from([SERIALIZED_PREFIX]), body]),
  );
  const signalMessage = Buffer.concat([Buffer.from([SERIALIZED_PREFIX]), body, mac]);

  session.senderChainKey = toB64(chain.nextChainKey);
  session.senderCounter += 1;

  let result: OutboundSignalMessage;
  if (session.pendingPreKey) {
    result = { type: "pkmsg", ciphertext: encodePreKeySignalMessage(session, signalMessage) };
    delete session.pendingPreKey;
  } else {
    result = { type: "msg", ciphertext: signalMessage };
  }
  saveSession(store, jid, session);
  return result;
}
