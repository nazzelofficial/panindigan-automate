/**
 * Media upload and download.
 *
 * Uploads go to Facebook's Mercury upload endpoint as multipart form data.
 * The primary host accepts the file under `farr`; when it fails or returns no
 * metadata, the upload host is tried with `upload_1024`. The response's
 * `payload.metadata` entry carries the id that send forms and forwarding use.
 *
 * Downloads resolve a playable URL first (from the library's attachment cache
 * or the photo redirect endpoint) and then stream it, so large files never
 * sit in memory unless the caller asks for a Buffer.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { FB_BASE_URL, FB_UPLOAD_URL } from "../constants.js";
import { asArray, asRecord } from "../delta/raw.js";
import { APIError } from "../errors/index.js";
import type { FileInput, MediaInfo } from "../types/index.js";
import type { HttpTransport } from "../transport/http/index.js";
import type { Logger } from "../logger/index.js";

/** Primary upload endpoint (multipart field `farr`). */
export const UPLOAD_URL = `${FB_BASE_URL}/ajax/mercury/upload.php`;

/** Fallback upload host (multipart field `upload_1024`). */
export const UPLOAD_FALLBACK_URL = `${FB_UPLOAD_URL}/ajax/mercury/upload.php`;

/** Photo redirect endpoint used to resolve image attachment ids. */
export const PHOTO_URL = `${FB_BASE_URL}/mercury/attachments/photo`;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
};

interface FileContents {
  readonly content: Buffer;
  readonly filename: string;
  readonly contentType: string | null;
}

/** Reads any supported file input fully into memory. */
export async function readFileInput(input: FileInput): Promise<FileContents> {
  if (typeof input === "string") {
    const content = await readFile(input);
    const filename = basename(input);
    const dot = filename.lastIndexOf(".");
    const extension = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
    return { content, filename, contentType: MIME_BY_EXTENSION[extension] ?? null };
  }
  if (Buffer.isBuffer(input)) {
    return { content: input, filename: "upload", contentType: null };
  }
  const chunks: Buffer[] = [];
  const iterable = input as AsyncIterable<unknown>;
  for await (const chunk of iterable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return { content: Buffer.concat(chunks), filename: "upload", contentType: null };
}

/**
 * Picks the first metadata entry. Facebook sends either an array or an
 * object keyed by numeric strings; both are normalized to the first entry.
 */
export function firstMetadataEntry(metadata: unknown): Record<string, unknown> | null {
  if (Array.isArray(metadata)) {
    const first = metadata[0];
    return asRecord(first);
  }
  const record = asRecord(metadata);
  if (record === null) {
    return null;
  }
  const keys = Object.keys(record).sort((a, b) => Number(a) - Number(b));
  const first = keys.length > 0 ? record[keys[0]!] : undefined;
  return asRecord(first);
}

/** Extracts the attachment id and entity kind from one metadata entry. */
export function metadataToMediaInfo(
  entry: Record<string, unknown>,
  filename: string,
  contentType: string | null,
  size: number,
): MediaInfo | null {
  const candidates = [
    ["image_id", "image"],
    ["gif_id", "gif"],
    ["file_id", "file"],
    ["video_id", "video"],
    ["audio_id", "audio"],
  ] as const;
  for (const [field, kind] of candidates) {
    const id = entry[field];
    if (typeof id === "string" && id !== "" || typeof id === "number") {
      return {
        attachmentId: String(id),
        filename,
        mimeType: firstText(entry["mime_type"] ?? entry["content_type"]) ?? contentType,
        size: firstNumber(entry["file_size"] ?? entry["size"]) ?? size,
        kind,
      };
    }
  }
  return null;
}

function firstText(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}

function firstNumber(...values: readonly unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

interface UploadAttempt {
  readonly info: MediaInfo | null;
  readonly error: unknown;
}

/** Builds the multipart fields for an upload; voice_clip only for voice. */
export function buildUploadFields(voiceClip: boolean): Record<string, string> {
  return voiceClip ? { voice_clip: "true" } : {};
}

async function attemptUpload(
  http: HttpTransport,
  url: string,
  field: string,
  contents: FileContents,
  voiceClip: boolean = false,
): Promise<UploadAttempt> {
  try {
    const response = await http.postMultipart(
      "uploadMedia",
      url,
      // voice_clip is ONLY for actual voice messages. Sending it on every
      // image/file upload mislabels them as audio clips.
      buildUploadFields(voiceClip),
      { field, filename: contents.filename, content: contents.content, contentType: contents.contentType ?? undefined },
    );
    const payload = http.check("uploadMedia", response, { allowNon200: true });
    const record = asRecord(payload);
    const payloadRecord = asRecord(record?.["payload"]);
    const metadata = payloadRecord !== null ? payloadRecord["metadata"] : record?.["metadata"];
    const entry = firstMetadataEntry(metadata);
    if (entry === null) {
      return { info: null, error: null };
    }
    const info = metadataToMediaInfo(entry, contents.filename, contents.contentType, contents.content.length);
    return { info, error: null };
  } catch (error) {
    return { info: null, error };
  }
}

/**
 * Uploads a file to Facebook's CDN and returns the id that `sendMessage`,
 * `sendAttachment`, and forwarding accept.
 */
export async function uploadMedia(
  http: HttpTransport,
  logger: Logger,
  input: FileInput,
  options?: { readonly voiceClip?: boolean | undefined },
): Promise<MediaInfo> {
  const contents = await readFileInput(input);
  const voiceClip = options?.voiceClip === true;

  const primary = await attemptUpload(http, UPLOAD_URL, "farr", contents, voiceClip);
  if (primary.info !== null) {
    return primary.info;
  }

  const fallback = await attemptUpload(http, UPLOAD_FALLBACK_URL, "upload_1024", contents, voiceClip);
  if (fallback.info !== null) {
    logger.debug({ host: "upload.facebook.com" }, "media upload succeeded on the fallback host");
    return fallback.info;
  }

  if (primary.error !== null) {
    throw primary.error;
  }
  if (fallback.error !== null) {
    throw fallback.error;
  }
  throw new APIError(
    "Facebook accepted the upload but returned no attachment metadata",
    "API_ERROR",
    { retryable: true, context: { filename: contents.filename, size: contents.content.length } },
  );
}

/**
 * Resolves a photo attachment id to its CDN URL through Facebook's
 * `ServerRedirect.redirectPageTo` payload.
 */
export async function resolvePhotoUrl(http: HttpTransport, photoId: string): Promise<string> {
  const response = await http.get("resolvePhotoUrl", PHOTO_URL, { query: { photo_id: photoId } });
  const payload = http.check("resolvePhotoUrl", response);
  const record = asRecord(payload);
  const jsmods = asRecord(record?.["jsmods"]);
  const require = asArray(jsmods?.["require"]);

  const byKey = new Map<string, unknown>();
  for (const entry of require) {
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      byKey.set(entry[0], entry[3]);
    }
  }
  const redirect = byKey.get("ServerRedirect.redirectPageTo");
  const first = asArray(redirect)[0];
  if (typeof first === "string" && first.startsWith("http")) {
    return first;
  }

  const legacy = asArray(asArray(require[0])?.[3])[0];
  if (typeof legacy === "string" && legacy.startsWith("http")) {
    return legacy;
  }

  throw new APIError(
    `Facebook did not return a downloadable URL for photo "${photoId}"`,
    "ATTACHMENT_URL_UNAVAILABLE",
    { retryable: false, context: { photoId } },
  );
}
