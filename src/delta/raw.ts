/**
 * Raw-delta helpers.
 *
 * Messenger payloads arrive as loosely typed JSON where the same value is
 * sometimes a string, sometimes a number, and nested objects use either a
 * typed-union or a GraphQL connection shape. These helpers normalize those
 * differences without losing the original data.
 */

import { z } from "zod";

/** An id that may arrive as a JSON string or a JSON number. */
export const IdSchema = z.union([z.string(), z.number()]).transform((value) => String(value));

/** A thread key: group threads carry `threadFbId`, direct threads `otherUserFbId`. */
export const ThreadKeySchema = z
  .object({
    threadFbId: IdSchema.optional(),
    otherUserFbId: IdSchema.optional(),
  })
  .passthrough();

export type RawThreadKey = z.infer<typeof ThreadKeySchema>;

/** A numeric or numeric-string value. */
export const NumericStringSchema = z.union([z.string(), z.number()]);

/** Returns `value` when it is a plain object, otherwise `null`. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Returns `value` when it is an array, otherwise an empty array. */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Parses a numeric value; accepts numeric strings. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalizes an epoch timestamp to milliseconds.
 *
 * Messenger sends most timestamps in milliseconds, but a few receipt fields
 * are still in seconds. Values before 1973 are treated as seconds; no real
 * Messenger event predates that, so the heuristic is safe.
 */
export function toMillis(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }
  return parsed < 1_000_000_000_000 ? Math.round(parsed * 1000) : Math.round(parsed);
}

/** Resolves the thread id out of a thread key. */
export function threadIdFromKey(key: RawThreadKey | null | undefined): string | null {
  if (key === null || key === undefined) {
    return null;
  }
  return key.threadFbId ?? key.otherUserFbId ?? null;
}

/** Whether a thread key describes a group thread. */
export function isGroupKey(key: RawThreadKey | null | undefined): boolean {
  return key?.threadFbId !== undefined;
}

/** Resolves the other user id out of a direct-thread key. */
export function otherUserIdFromKey(key: RawThreadKey | null | undefined): string | null {
  return key?.otherUserFbId ?? null;
}

/** Builds a thread key from either a `threadKey` field or a bare id. */
export function readThreadKey(value: unknown): RawThreadKey | null {
  const parsed = ThreadKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parses a JSON string when possible, otherwise returns `null`. */
export function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Decodes a `ClientPayload` payload field.
 *
 * The field is normally an array of character codes (a JSON document encoded
 * as bytes), but a few server variants send the JSON text directly.
 */
export function decodeClientPayload(value: unknown): unknown {
  let text: string | null = null;
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value)) {
    const codes: number[] = [];
    for (const entry of value) {
      const code = toNumber(entry);
      if (code === null) {
        return null;
      }
      codes.push(code);
    }
    try {
      // Facebook has sent both UTF-8 byte arrays and UTF-16 code-unit arrays.
      // Every UTF-8 byte fits in a byte, so a byte array is unambiguous.
      text = codes.every((code) => code >= 0 && code <= 255)
        ? new TextDecoder("utf-8").decode(Uint8Array.from(codes))
        : String.fromCharCode(...codes);
    } catch {
      return null;
    }
  }
  if (text === null) {
    return null;
  }
  return parseJsonString(text);
}

/** Converts a typed GraphQL value node (`asString`, `asLong`, `asInt`). */
export function readFbTypedValue(node: unknown): string | number | null {
  const record = asRecord(node);
  if (record === null) {
    return null;
  }
  const value = record.asString ?? record.asLong ?? record.asInt;
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
}

/** Converts a dimension pair (`{width,height}`, `"w,h"`, or `[w,h]`) to numbers. */
export function readDimensions(value: unknown): { width: number | null; height: number | null } {
  if (typeof value === "string") {
    const [width, height] = value.split(",");
    return { width: toNumber(width), height: toNumber(height) };
  }
  if (Array.isArray(value)) {
    return { width: toNumber(value[0]), height: toNumber(value[1]) };
  }
  const record = asRecord(value);
  if (record !== null) {
    return {
      width: toNumber(record.width ?? record.x),
      height: toNumber(record.height ?? record.y),
    };
  }
  return { width: null, height: null };
}

/** Reads a nested image descriptor (`{uri|url,width,height}`). */
export function readImage(value: unknown): {
  url: string | null;
  width: number | null;
  height: number | null;
} {
  const record = asRecord(value);
  if (record === null) {
    return { url: null, width: null, height: null };
  }
  const url = typeof record.uri === "string" ? record.uri : typeof record.url === "string" ? record.url : null;
  return { url, width: toNumber(record.width), height: toNumber(record.height) };
}
