/**
 * Mention extraction.
 *
 * Messenger has shipped at least four mention encodings over the years:
 *
 * 1. `data.prng`: a JSON string of `{i,o,l}` triples (id, offset, length).
 * 2. Parallel CSV fields: `mention_ids`, `mention_offsets`, `mention_lengths`.
 * 3. Range lists: `ranges` / `profileRanges` with an entity id and offset.
 * 4. A typed GraphQL map at `messageMetadata.data.data.Gb.asMap.data`.
 *
 * All four are handled; the first encoding that yields a mention wins.
 */

import type { Mention } from "../types/index.js";
import { asArray, asRecord, parseJsonString, readFbTypedValue, toNumber } from "./raw.js";

interface Triple {
  readonly id: string;
  readonly offset: number;
  readonly length: number;
}

function toTriples(ids: readonly unknown[], offsets: readonly unknown[], lengths: readonly unknown[]): Triple[] {
  const triples: Triple[] = [];
  const count = Math.min(ids.length, offsets.length, lengths.length);
  for (let index = 0; index < count; index += 1) {
    const rawId = ids[index];
    const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId).trim() : "";
    const offset = toNumber(offsets[index]);
    const length = toNumber(lengths[index]);
    if (id === "" || offset === null || length === null || length <= 0) {
      continue;
    }
    triples.push({ id, offset, length });
  }
  return triples;
}

function splitCsv(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }
  return [];
}

function fromPrng(message: Record<string, unknown>): Triple[] {
  const data = asRecord(message.data);
  const prng = data === null ? undefined : data.prng;
  const parsed = parseJsonString(prng);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const items = parsed.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== null);
  return toTriples(
    items.map((item) => item.i),
    items.map((item) => item.o),
    items.map((item) => item.l),
  );
}

function fromCsv(message: Record<string, unknown>): Triple[] {
  const data = asRecord(message.data) ?? {};
  const ids = splitCsv(data.mention_ids ?? message.mention_ids);
  const offsets = splitCsv(data.mention_offsets ?? message.mention_offsets);
  const lengths = splitCsv(data.mention_lengths ?? message.mention_lengths);
  return toTriples(ids, offsets, lengths);
}

function fromRanges(message: Record<string, unknown>): Triple[] {
  const data = asRecord(message.data);
  const ranges = asArray(message.ranges).length > 0
    ? asArray(message.ranges)
    : asArray(data?.ranges).length > 0
      ? asArray(data?.ranges)
      : asArray(message.profileRanges);
  const triples: Triple[] = [];
  for (const entry of ranges) {
    const range = asRecord(entry);
    if (range === null) {
      continue;
    }
    const entity = asRecord(range.entity);
    const rawId = entity?.id ?? range.id ?? range.i;
    const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId).trim() : "";
    const offset = toNumber(range.offset ?? range.o);
    const length = toNumber(range.length ?? range.l);
    if (id !== "" && offset !== null && length !== null && length > 0) {
      triples.push({ id, offset, length });
    }
  }
  return triples;
}

function fromGraphqlMap(message: Record<string, unknown>): Triple[] {
  const metadata = asRecord(message.messageMetadata);
  const metadataData = metadata === null ? null : asRecord(metadata.data);
  const nested = metadataData === null ? null : asRecord(metadataData.data);
  const gb = nested?.Gb ?? metadataData?.Gb;
  const gbRecord = asRecord(gb);
  const asMap = gbRecord === null ? null : asRecord(gbRecord.asMap);
  const map = asMap === null ? null : asRecord(asMap.data);
  if (map === null) {
    return [];
  }
  const triples: Triple[] = [];
  for (const entry of Object.values(map)) {
    const wrapper = asRecord(entry);
    const row = wrapper === null ? null : asRecord(wrapper.asMap);
    const rowData = row === null ? null : asRecord(row.data);
    if (rowData === null) {
      continue;
    }
    const rawId = readFbTypedValue(rowData.id);
    const id = rawId === null ? "" : String(rawId).trim();
    const offset = toNumber(readFbTypedValue(rowData.offset));
    const length = toNumber(readFbTypedValue(rowData.length));
    if (id !== "" && offset !== null && length !== null && length > 0) {
      triples.push({ id, offset, length });
    }
  }
  return triples;
}

/**
 * Extracts mentions from a raw message delta.
 *
 * The body slice is derived from the offsets rather than trusting a `tag`
 * field, because the offsets are authoritative when the message is edited.
 * Mentions whose range falls outside the body are dropped.
 */
export function extractMentions(message: Record<string, unknown>, body: string): Mention[] {
  let triples = fromPrng(message);
  if (triples.length === 0) {
    triples = fromCsv(message);
  }
  if (triples.length === 0) {
    triples = fromRanges(message);
  }
  if (triples.length === 0) {
    triples = fromGraphqlMap(message);
  }

  const seen = new Set<string>();
  const mentions: Mention[] = [];
  for (const triple of triples) {
    if (triple.offset < 0 || triple.offset + triple.length > body.length) {
      continue;
    }
    const key = `${triple.id}:${triple.offset}:${triple.length}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mentions.push({
      id: triple.id,
      tag: body.slice(triple.offset, triple.offset + triple.length),
      fromIndex: triple.offset,
    });
  }
  mentions.sort((left, right) => (left.fromIndex ?? 0) - (right.fromIndex ?? 0));
  return mentions;
}
