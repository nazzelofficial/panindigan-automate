/**
 * Persistent E2EE device store — ported from bhhoang/fbapi-unofficial (MIT),
 * https://github.com/bhhoang/fbapi-unofficial (src/e2ee/store.js),
 * MIT licensed by bhhoang and contributors.
 *
 * Copyright (c) bhhoang and contributors of fbapi-unofficial.
 * Licensed MIT. Persisted shape is compatible with upstream's device file;
 * writes are atomic (tmp + rename) with owner-only permissions.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPair, xeddsaSign } from "./crypto.js";
import type { SessionState } from "./signal.js";

function b64(buf: Buffer): string {
  return Buffer.from(buf).toString("base64");
}

function unb64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

export interface SignedPreKeyRecord {
  id: number;
  priv: string;
  pub: string;
  signature: string;
}

export interface PreKeyRecord {
  priv: string;
  pub: string;
}

export interface E2EEDeviceFile {
  version: 1;
  noise_key_priv: string;
  identity_key_priv: string;
  identity_key_pub: string;
  signed_pre_key: SignedPreKeyRecord;
  signed_pre_keys: Record<number, SignedPreKeyRecord>;
  registration_id: number;
  facebook_uuid: string;
  jid_user: string;
  jid_device: number;
  next_pre_key_id: number;
  pre_keys: Record<number, PreKeyRecord>;
  used_pre_keys: Record<number, PreKeyRecord>;
  used_pre_key_order: number[];
  sessions: Record<string, unknown>;
  identities: Record<string, number>;
  e2ee_threads: Record<string, boolean>;
  e2ee_history: Record<string, E2EEHistoryMessage[]>;
  backup: unknown;
}

export interface E2EEHistoryMessage {
  readonly messageID: string | null;
  readonly threadID: string;
  readonly senderID: string;
  readonly timestamp: number;
  readonly body: string;
}

function generateSignedPreKey(identityPriv: Buffer, id: number): SignedPreKeyRecord {
  const pair = generateKeyPair();
  const signature = xeddsaSign(identityPriv, Buffer.concat([Buffer.from([5]), pair.pub]));
  return { id, priv: b64(pair.priv), pub: b64(pair.pub), signature: b64(signature) };
}

export class DeviceStore {
  static readonly MAX_HISTORY_PER_THREAD = 200;

  /** Path the store persists to; empty string disables persistence. */
  readonly path: string;
  noiseKeyPriv: Buffer = Buffer.alloc(0);
  identityKeyPair: { priv: Buffer; pub: Buffer } = { priv: Buffer.alloc(0), pub: Buffer.alloc(0) };
  signedPreKey: SignedPreKeyRecord = { id: 0, priv: "", pub: "", signature: "" };
  registrationId = 0;
  facebookUUID = "";
  jidUser = "";
  jidDevice = 0;
  nextPreKeyId = 1;
  preKeys: Record<number, PreKeyRecord> = {};
  usedPreKeys: Record<number, PreKeyRecord> = {};
  usedPreKeyOrder: number[] = [];
  signedPreKeys: Record<number, SignedPreKeyRecord> = {};
  sessions: Record<string, SessionState> = {};
  identities: Record<string, number> = {};
  threads: Record<string, boolean> = {};
  history: Record<string, E2EEHistoryMessage[]> = {};
  backup: unknown = null;

  constructor(filePath: string) {
    this.path = filePath;
  }

  appendHistory(threadId: string, message: E2EEHistoryMessage): void {
    const key = String(threadId);
    const list = this.history[key] ?? [];
    list.push(message);
    this.history[key] =
      list.length > DeviceStore.MAX_HISTORY_PER_THREAD
        ? list.slice(list.length - DeviceStore.MAX_HISTORY_PER_THREAD)
        : list;
  }

  initialize(): void {
    this.noiseKeyPriv = randomBytes(32);
    this.identityKeyPair = generateKeyPair();
    this.signedPreKey = generateSignedPreKey(this.identityKeyPair.priv, 1);
    this.signedPreKeys[this.signedPreKey.id] = this.signedPreKey;
    this.registrationId = (randomBytes(2).readUInt16BE(0) & 16383) || 1;
    this.facebookUUID = randomUUID();
    this.nextPreKeyId = 1;
    this.save();
  }

  rotateSignedPreKey(): SignedPreKeyRecord {
    const id = (this.signedPreKey ? this.signedPreKey.id : 0) + 1;
    this.signedPreKey = generateSignedPreKey((this.identityKeyPair as { priv: Buffer }).priv, id);
    this.signedPreKeys[id] = this.signedPreKey;
    return this.signedPreKey;
  }

  getSignedPreKeyById(id: number): SignedPreKeyRecord | null {
    return this.signedPreKeys[id] ?? (this.signedPreKey && this.signedPreKey.id === id ? this.signedPreKey : null);
  }

  takePreKey(id: number): PreKeyRecord | null {
    const key = this.preKeys[id];
    if (key) {
      delete this.preKeys[id];
      this.usedPreKeys[id] = key;
      this.usedPreKeyOrder.push(id);
      while (this.usedPreKeyOrder.length > 100) {
        const oldest = this.usedPreKeyOrder.shift();
        if (oldest !== undefined) delete this.usedPreKeys[oldest];
      }
    }
    return key ?? null;
  }

  getUsedPreKey(id: number): PreKeyRecord | null {
    return this.usedPreKeys[id] ?? null;
  }

  generatePreKeys(count: number): Array<{ id: number; pub: Buffer; priv: Buffer }> {
    const result: Array<{ id: number; pub: Buffer; priv: Buffer }> = [];
    for (let i = 0; i < count; i++) {
      const id = this.nextPreKeyId++;
      const pair = generateKeyPair();
      this.preKeys[id] = { priv: b64(pair.priv), pub: b64(pair.pub) };
      result.push({ id, pub: pair.pub, priv: pair.priv });
    }
    this.save();
    return result;
  }

  /** Signed prekey public key with the 0x05 Curve25519 type prefix. */
  signedPreKeyPublic(): Buffer {
    if (!this.signedPreKey) throw new Error("DeviceStore: signed prekey not initialized");
    return Buffer.concat([Buffer.from([5]), unb64(this.signedPreKey.pub)]);
  }

  /** Raw 32-byte identity public key. */
  identityPublic(): Buffer {
    if (!this.identityKeyPair) throw new Error("DeviceStore: identity not initialized");
    return this.identityKeyPair.pub;
  }

  /** Persist atomically with owner-only permissions. */
  save(): void {
    if (!this.path) return;
    const dir = dirname(this.path);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // directory exists or cannot be created; the write below will surface errors
    }
    const data: E2EEDeviceFile = {
      version: 1,
      noise_key_priv: b64(this.noiseKeyPriv as Buffer),
      identity_key_priv: b64(this.identityKeyPair!.priv),
      identity_key_pub: b64(this.identityKeyPair!.pub),
      signed_pre_key: this.signedPreKey as SignedPreKeyRecord,
      signed_pre_keys: this.signedPreKeys,
      registration_id: this.registrationId,
      facebook_uuid: this.facebookUUID,
      jid_user: this.jidUser,
      jid_device: this.jidDevice,
      next_pre_key_id: this.nextPreKeyId,
      pre_keys: this.preKeys,
      used_pre_keys: this.usedPreKeys,
      used_pre_key_order: this.usedPreKeyOrder,
      sessions: this.sessions,
      identities: this.identities,
      e2ee_threads: this.threads,
      e2ee_history: this.history,
      backup: this.backup,
    };
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  load(data: E2EEDeviceFile): void {
    this.noiseKeyPriv = unb64(data.noise_key_priv);
    this.identityKeyPair = {
      priv: unb64(data.identity_key_priv),
      pub: unb64(data.identity_key_pub),
    };
    this.signedPreKey = data.signed_pre_key;
    this.signedPreKeys = data.signed_pre_keys ?? {};
    if (this.signedPreKey && this.signedPreKey.id != null && !this.signedPreKeys[this.signedPreKey.id]) {
      this.signedPreKeys[this.signedPreKey.id] = this.signedPreKey;
    }
    this.registrationId = data.registration_id;
    this.facebookUUID = data.facebook_uuid;
    this.jidUser = data.jid_user ?? "";
    this.jidDevice = data.jid_device ?? 0;
    this.nextPreKeyId = data.next_pre_key_id ?? 1;
    this.preKeys = data.pre_keys ?? {};
    this.usedPreKeys = data.used_pre_keys ?? {};
    this.usedPreKeyOrder = data.used_pre_key_order ?? [];
    this.sessions = (data.sessions as DeviceStore["sessions"]) ?? {};
    this.identities = data.identities ?? {};
    this.threads = data.e2ee_threads ?? {};
    this.history = data.e2ee_history ?? {};
    this.backup = data.backup ?? null;
  }

  /** Load from disk if present, otherwise initialize a fresh device. */
  static fromFile(filePath: string): DeviceStore {
    const store = new DeviceStore(filePath);
    let data: E2EEDeviceFile | null = null;
    if (filePath && existsSync(filePath)) {
      data = JSON.parse(readFileSync(filePath, "utf8")) as E2EEDeviceFile;
    }
    if (data) {
      store.load(data);
      if (store.identityKeyPair.priv.length === 0) store.initialize();
    } else {
      store.initialize();
    }
    return store;
  }
}
