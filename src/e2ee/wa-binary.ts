/**
 * WA Binary Protocol — ported from bhhoang/fbapi-unofficial (MIT),
 * https://github.com/bhhoang/fbapi-unofficial (src/e2ee/binary.js),
 * MIT licensed by bhhoang and contributors.
 *
 * Copyright (c) bhhoang and contributors of fbapi-unofficial.
 * Licensed MIT. Ported to TypeScript with only module-syntax and
 * type-annotation adjustments; wire behaviour is unchanged.
 *
 * WhatsApp's binary stanza encoding: single-byte and double-byte dictionary
 * tokens, packed-nibble/hex strings, JID forms, and the 0x00 marshal prefix
 * (optionally zlib-compressed) used by the Noise transport.
 */

import { inflateSync } from "node:zlib";
import { singleByteTokens, doubleByteTokens, tokenToIndex, doubleTokenToIndex } from "./tokens.js";

const LIST_EMPTY = 0;
const STREAM_END = 2;
const DICTIONARY_0 = 236;
const DICTIONARY_3 = 239;
const LIST_8 = 248;
const LIST_16 = 249;
const JID_PAIR = 250;
const HEX_8 = 251;
const BINARY_8 = 252;
const BINARY_20 = 253;
const BINARY_32 = 254;
const NIBBLE_8 = 255;
const FBJID = 246;
const ADJID = 247;

const jidAttributes: Readonly<Record<string, boolean>> = {
  to: true,
  from: true,
  jid: true,
  participant: true,
  recipient: true,
  target: true,
};

export interface WANode {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly content?: WANode[] | Buffer | string | undefined;
}

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

function encodeListStart(size: number): Buffer {
  if (size === 0) return Buffer.from([LIST_EMPTY]);
  if (size < 256) return Buffer.from([LIST_8, size]);
  if (size < 65536) {
    const out = Buffer.alloc(3);
    out[0] = LIST_16;
    out.writeUInt16BE(size, 1);
    return out;
  }
  throw new Error("List too large");
}

function encodeStringRaw(buf: Buffer): Buffer {
  if (buf.length < 256) {
    return Buffer.concat([Buffer.from([BINARY_8, buf.length]), buf]);
  }
  if (buf.length < 1048576) {
    const header20 = Buffer.alloc(4);
    header20[0] = BINARY_20;
    header20[1] = (buf.length >> 16) & 255;
    header20[2] = (buf.length >> 8) & 255;
    header20[3] = buf.length & 255;
    return Buffer.concat([header20, buf]);
  }
  const header32 = Buffer.alloc(5);
  header32[0] = BINARY_32;
  header32.writeUInt32BE(buf.length, 1);
  return Buffer.concat([header32, buf]);
}

function encodeString(value: string): Buffer {
  const single = tokenToIndex.get(value);
  if (typeof single === "number") return Buffer.from([single]);
  const dbl = doubleTokenToIndex.get(value);
  if (dbl) return Buffer.from([DICTIONARY_0 + dbl.dict, dbl.index]);
  return encodeStringRaw(Buffer.from(String(value), "utf8"));
}

function encodeJID(jid: string): Buffer {
  const atIdx = jid.indexOf("@");
  if (atIdx === -1) return encodeString(jid);
  const userFull = jid.slice(0, atIdx);
  const server = jid.slice(atIdx + 1);
  if (server === "msgr") {
    let user = userFull;
    let device = 0;
    let splitIdx = userFull.indexOf(".");
    if (splitIdx === -1) splitIdx = userFull.indexOf(":");
    if (splitIdx !== -1) {
      user = userFull.slice(0, splitIdx);
      device = parseInt(userFull.slice(splitIdx + 1), 10) || 0;
    }
    const devBuf = Buffer.alloc(2);
    devBuf.writeUInt16BE(device);
    return Buffer.concat([Buffer.from([FBJID]), encodeString(user), devBuf, encodeString(server)]);
  }
  if (server === "s.whatsapp.net" && (userFull.indexOf(".") !== -1 || userFull.indexOf(":") !== -1)) {
    let agent = 0;
    let dev = 0;
    let userOut = userFull;
    const dotIdx = userFull.indexOf(".");
    const colonIdx = userFull.indexOf(":");
    if (dotIdx !== -1 && colonIdx !== -1) {
      userOut = userFull.slice(0, dotIdx);
      agent = parseInt(userFull.slice(dotIdx + 1, colonIdx), 10) || 0;
      dev = parseInt(userFull.slice(colonIdx + 1), 10) || 0;
    } else if (dotIdx !== -1) {
      userOut = userFull.slice(0, dotIdx);
      dev = parseInt(userFull.slice(dotIdx + 1), 10) || 0;
    }
    return Buffer.concat([Buffer.from([ADJID, agent, dev]), encodeString(userOut)]);
  }
  const parts: Buffer[] = [Buffer.from([JID_PAIR])];
  parts.push(userFull ? encodeString(userFull) : Buffer.from([LIST_EMPTY]));
  parts.push(encodeString(server));
  return Buffer.concat(parts);
}

export function encodeNode(
  tag: string,
  attrs?: Record<string, string> | undefined,
  content?: WANode[] | Buffer | string | ReadonlyArray<WANode | Buffer> | undefined,
): Buffer {
  const attrMap = attrs ?? {};
  const attrKeys = Object.keys(attrMap).filter(
    (k) => attrMap[k] !== undefined && attrMap[k] !== null,
  );
  const hasContent = content !== undefined && content !== null;
  const listSize = 1 + attrKeys.length * 2 + (hasContent ? 1 : 0);
  const chunks: Buffer[] = [encodeListStart(listSize), encodeString(tag)];
  for (const key of attrKeys) {
    const value = attrMap[key] as string;
    chunks.push(encodeString(key));
    if (typeof value === "string" && (value.indexOf("@") !== -1 || jidAttributes[key])) {
      chunks.push(encodeJID(value));
    } else {
      chunks.push(encodeString(String(value)));
    }
  }
  if (hasContent && content !== undefined) {
    if (Array.isArray(content)) {
      chunks.push(
        encodeNodeList(
          content.map((child) =>
            Buffer.isBuffer(child) ? child : encodeNode(child.tag, child.attrs, child.content),
          ),
        ),
      );
    } else if (Buffer.isBuffer(content)) {
      chunks.push(encodeStringRaw(content));
    } else {
      chunks.push(encodeString(String(content)));
    }
  }
  return Buffer.concat(chunks);
}

function encodeNodeList(nodes: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [encodeListStart(nodes.length)];
  for (const node of nodes) {
    parts.push(node);
  }
  return Buffer.concat(parts);
}

/** Marshal a node into a transport frame (0x00 prefix). */
export function marshal(node: WANode | Buffer): Buffer {
  const body = Buffer.isBuffer(node)
    ? node
    : encodeNode(node.tag, node.attrs, node.content);
  return Buffer.concat([Buffer.from([0]), body]);
}

class BinaryDecoder {
  private index = 0;
  readonly #data: Buffer;

  constructor(data: Buffer) {
    this.#data = data;
  }

  private readByte(): number {
    if (this.index >= this.#data.length) throw new Error("BinaryDecoder: EOF");
    const b = this.#data[this.index] as number;
    this.index += 1;
    return b;
  }

  private readBytes(len: number): Buffer {
    if (this.index + len > this.#data.length) throw new Error("BinaryDecoder: read out of bounds");
    const out = this.#data.subarray(this.index, this.index + len);
    this.index += len;
    return out;
  }

  private readInt8(): number {
    return this.readByte();
  }

  private readInt16(): number {
    const b = this.readBytes(2);
    return b.readUInt16BE(0);
  }

  private readInt20(): number {
    const b = this.readBytes(3);
    return ((b[0] as number) << 16) | ((b[1] as number) << 8) | (b[2] as number);
  }

  private readInt32(): number {
    const b = this.readBytes(4);
    return b.readUInt32BE(0);
  }

  private readListSize(tag: number): number {
    if (tag === LIST_EMPTY) return 0;
    if (tag === LIST_8) return this.readInt8();
    if (tag === LIST_16) return this.readInt16();
    throw new Error(`Invalid list tag: ${tag}`);
  }

  private readPacked8(tag: number): string {
    const start = this.readByte();
    const len = start & 127;
    let out = "";
    for (let i = 0; i < len; i++) {
      const b = this.readByte();
      out += this.unpackByte(tag, (b & 240) >> 4);
      out += this.unpackByte(tag, b & 15);
    }
    if ((start >> 7) !== 0 && tag === HEX_8) out = out.slice(0, -1);
    return out;
  }

  private unpackByte(tag: number, val: number): string {
    if (tag === NIBBLE_8) {
      if (val < 10) return String.fromCharCode(48 + val);
      if (val === 10) return "-";
      if (val === 11) return ".";
    } else if (tag === HEX_8) {
      if (val < 10) return String.fromCharCode(48 + val);
      if (val < 16) return String.fromCharCode(65 + val - 10);
    }
    return "";
  }

  private readString(tag: number): string {
    if (tag >= 3 && tag < DICTIONARY_0) {
      return (singleByteTokens[tag] as string | undefined) ?? "";
    }
    if (tag >= DICTIONARY_0 && tag <= DICTIONARY_3) {
      const idx = this.readByte();
      const dict = doubleByteTokens[tag - DICTIONARY_0];
      if (!dict) throw new Error(`Invalid dictionary index: ${tag - DICTIONARY_0}`);
      return (dict[idx] as string | undefined) ?? "";
    }
    switch (tag) {
      case BINARY_8:
        return this.readBytes(this.readInt8()).toString();
      case BINARY_20:
        return this.readBytes(this.readInt20()).toString();
      case BINARY_32:
        return this.readBytes(this.readInt32()).toString();
      case NIBBLE_8:
      case HEX_8:
        return this.readPacked8(tag);
      default:
        throw new Error(`Invalid string tag: ${tag}`);
    }
  }

  private read(asString: boolean): WANode[] | Buffer | string | null {
    const tag = this.readByte();
    if (tag === LIST_EMPTY) return null;
    if (tag === LIST_8 || tag === LIST_16) {
      const size = this.readListSize(tag);
      const list: WANode[] = [];
      for (let i = 0; i < size; i++) list.push(this.readNode());
      return list;
    }
    if (tag === BINARY_8) return this.readBytesOrString(this.readInt8(), asString);
    if (tag === BINARY_20) return this.readBytesOrString(this.readInt20(), asString);
    if (tag === BINARY_32) return this.readBytesOrString(this.readInt32(), asString);
    if (tag === JID_PAIR) {
      const user = this.read(true);
      const server = this.read(true);
      return (typeof user === "string" && user ? user + "@" : "") + server;
    }
    if (tag === FBJID) {
      const fbUser = this.read(true);
      const device = this.readInt16();
      const fbServer = this.read(true);
      return fbUser + "." + device + "@" + fbServer;
    }
    if (tag === ADJID) {
      const agent = this.readByte();
      const adDevice = this.readByte();
      const adUser = this.read(true);
      return adUser + "." + agent + ":" + adDevice + "@s.whatsapp.net";
    }
    return this.readString(tag);
  }

  private readBytesOrString(len: number, asString: boolean): Buffer | string {
    const raw = this.readBytes(len);
    return asString ? raw.toString() : Buffer.from(raw);
  }

  readNode(): WANode {
    const listSize = this.readListSize(this.readByte());
    const tag = this.readString(this.readByte());
    const attrs: Record<string, string> = {};
    const attrCount = (listSize - 1) >> 1;
    for (let i = 0; i < attrCount; i++) {
      const key = this.readString(this.readByte());
      const value = this.read(true);
      attrs[key] = typeof value === "string" ? value : String(value ?? "");
    }
    let content: WANode[] | Buffer | string | undefined;
    if (listSize % 2 === 0) {
      const read = this.read(false);
      content = read === null ? undefined : read;
    }
    return content === undefined ? { tag, attrs } : { tag, attrs, content };
  }
}

/** Unmarshal a transport frame. Handles the 0x00 prefix and zlib compression. */
export function unmarshal(data: Buffer): WANode {
  if (!data || data.length === 0) throw new Error("Empty data in unmarshal");
  const dataType = data[0] as number;
  let body = data.subarray(1);
  if ((dataType & 2) !== 0) {
    body = inflateSync(body);
  }
  return new BinaryDecoder(body).readNode();
}

export function findChild(node: WANode | null | undefined, tag: string): WANode | null {
  if (!node || !Array.isArray(node.content)) return null;
  for (const child of node.content) {
    if (child && child.tag === tag) return child;
  }
  return null;
}

export function findDescendant(node: WANode | null | undefined, tag: string): WANode | null {
  if (!node) return null;
  if (node.tag === tag) return node;
  if (!Array.isArray(node.content)) return null;
  for (const child of node.content) {
    const found = findDescendant(child, tag);
    if (found) return found;
  }
  return null;
}

export const WABinaryTags = {
  LIST_EMPTY,
  STREAM_END,
  LIST_8,
  LIST_16,
  BINARY_8,
  BINARY_20,
  BINARY_32,
  JID_PAIR,
  FBJID,
  ADJID,
  HEX_8,
  NIBBLE_8,
  DICTIONARY_0,
  DICTIONARY_3,
} as const;
