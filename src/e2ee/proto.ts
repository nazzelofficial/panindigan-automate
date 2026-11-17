/**
 * Protobuf encoding/decoding for Meta's E2EE message formats — ported from
 * bhhoang/fbapi-unofficial (MIT), https://github.com/bhhoang/fbapi-unofficial
 * (src/e2ee/proto.js), MIT licensed by bhhoang and contributors.
 *
 * Copyright (c) bhhoang and contributors of fbapi-unofficial.
 * Licensed MIT. Ported to TypeScript with only module-syntax adjustments;
 * wire behaviour is unchanged.
 */

const B = BigInt;

export function encodeVarint(value: bigint | number): Buffer {
  const out: number[] = [];
  let v = B(value);
  while (v > B(127)) {
    out.push(Number(v & B(127)) | 128);
    v >>= B(7);
  }
  out.push(Number(v));
  return Buffer.from(out);
}

export function encodeTag(field: number, wire: number): Buffer {
  return encodeVarint(B(field * 8 + wire));
}

export function concatLengthDelimited(
  parts: ReadonlyArray<{ readonly field: number; readonly data: Buffer | Uint8Array }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const buf = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data);
    chunks.push(encodeTag(part.field, 2));
    chunks.push(encodeVarint(B(buf.length)));
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export class ProtoWriter {
  readonly #chunks: Buffer[] = [];

  varint(field: number, value: bigint | number): this {
    this.#chunks.push(encodeTag(field, 0));
    this.#chunks.push(encodeVarint(B(value)));
    return this;
  }

  bool(field: number, value: boolean): this {
    return this.varint(field, value ? 1 : 0);
  }

  uint64(field: number, value: bigint | number): this {
    this.#chunks.push(encodeTag(field, 0));
    this.#chunks.push(encodeVarint(B(value)));
    return this;
  }

  bytes(field: number, data: Buffer | Uint8Array): this {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.#chunks.push(encodeTag(field, 2));
    this.#chunks.push(encodeVarint(B(buf.length)));
    this.#chunks.push(buf);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, Buffer.from(String(value), "utf8"));
  }

  build(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

export class ProtoReader {
  #index = 0;
  readonly #data: Buffer;

  constructor(data: Buffer | Uint8Array) {
    this.#data = Buffer.isBuffer(data) ? data : Buffer.from(data);
  }

  eof(): boolean {
    return this.#index >= this.#data.length;
  }

  readVarint(): bigint {
    let result = B(0);
    let shift = B(0);
    let b: number;
    do {
      if (this.#index >= this.#data.length) throw new Error("ProtoReader: EOF in varint");
      b = this.#data[this.#index] as number;
      this.#index += 1;
      result |= B(b & 0x7f) << shift;
      shift += B(7);
    } while (b & 0x80);
    return result;
  }

  readBytes(len: number): Buffer {
    if (this.#index + len > this.#data.length) throw new Error("ProtoReader: EOF in bytes");
    const out = this.#data.subarray(this.#index, this.#index + len);
    this.#index += len;
    return Buffer.from(out);
  }

  skip(wire: number): void {
    if (wire === 0) this.readVarint();
    else if (wire === 1) this.#index += 8;
    else if (wire === 2) this.readBytes(Number(this.readVarint()));
    else if (wire === 5) this.#index += 4;
    else throw new Error(`ProtoReader: unsupported wire type ${wire}`);
  }

  readMessage(): Buffer {
    return this.readBytes(Number(this.readVarint()));
  }
}

export type DecodedFields = Record<number, bigint | Buffer>;

/** Decode a buffer into { fieldNumber: value } (first value wins per field). */
export function decodeFields(data: Buffer | Uint8Array): DecodedFields {
  const reader = new ProtoReader(data);
  const fields: DecodedFields = {};
  while (!reader.eof()) {
    const tag = Number(reader.readVarint());
    const field = tag >> 3;
    const wire = tag & 7;
    let value: bigint | Buffer;
    if (wire === 0) value = reader.readVarint();
    else if (wire === 2) value = reader.readMessage();
    else if (wire === 1) value = reader.readBytes(8);
    else if (wire === 5) value = reader.readBytes(4);
    else throw new Error(`ProtoReader: unsupported wire type ${wire}`);
    if (fields[field] === undefined) fields[field] = value;
  }
  return fields;
}
