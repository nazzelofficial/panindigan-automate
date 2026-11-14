/**
 * Attachment normalization.
 *
 * An attachment arrives in one of two Mercury shapes: a classic
 * `attach_type` blob, or a GraphQL `blob_attachment` with a `__typename`
 * (`MessageImage`, `MessageVideo`, …). Delta payloads may wrap either in a
 * `mercury` object or a `mercuryJSON` string. All variants normalize to the
 * single {@link Attachment} shape exposed by the library.
 */

import type { Attachment, AttachmentType } from "../types/index.js";
import {
  asArray,
  asRecord,
  parseJsonString,
  readDimensions,
  readImage,
  toNumber,
} from "./raw.js";

interface NormalizedInput {
  readonly wrapper: Record<string, unknown>;
  readonly blob: Record<string, unknown>;
}

function unwrap(raw: unknown): NormalizedInput | null {
  const wrapper = asRecord(raw);
  if (wrapper === null) {
    return null;
  }
  const mercuryJson = parseJsonString(wrapper.mercuryJSON);
  const mercury = asRecord(wrapper.mercury) ?? asRecord(mercuryJson);
  return { wrapper, blob: mercury ?? wrapper };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function firstText(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const found = text(value);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function firstNumber(...values: readonly unknown[]): number | null {
  for (const value of values) {
    const found = toNumber(value);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function baseAttachment(
  type: AttachmentType,
  input: NormalizedInput,
  fbType: string,
  fields: Partial<Attachment>,
): Attachment {
  const blob = input.blob;
  const metadata = asRecord(blob.metadata);
  const blobAttachment = asRecord(blob.blob_attachment);
  return {
    type,
    id:
      fields.id ??
      firstText(
        input.wrapper.id,
        blob.legacy_attachment_id,
        blobAttachment?.legacy_attachment_id,
        metadata?.fbid,
        blob.fbid,
        blob.id,
      ) ??
      "",
    filename: fields.filename ?? null,
    url: fields.url ?? null,
    previewUrl: fields.previewUrl ?? null,
    width: fields.width ?? null,
    height: fields.height ?? null,
    mimeType: fields.mimeType ?? null,
    size: fields.size ?? null,
    durationMs: fields.durationMs ?? null,
    stickerId: fields.stickerId ?? null,
    extra: { fbType, raw: blob },
  };
}

function fromMessageImage(blob: Record<string, unknown>): Omit<Attachment, "type" | "id" | "extra"> {
  const original = readDimensions(blob.original_dimensions);
  const preview = readImage(blob.preview);
  const large = readImage(blob.large_preview);
  return {
    filename: text(blob.filename),
    url: large.url ?? preview.url,
    previewUrl: preview.url,
    width: original.width ?? large.width ?? preview.width,
    height: original.height ?? large.height ?? preview.height,
    mimeType: null,
    size: null,
    durationMs: null,
    stickerId: null,
  };
}

function fromMessageAnimatedImage(blob: Record<string, unknown>): Omit<Attachment, "type" | "id" | "extra"> {
  const animated = readImage(blob.animated_image);
  const preview = readImage(blob.preview_image);
  return {
    filename: text(blob.filename),
    url: animated.url ?? preview.url,
    previewUrl: preview.url,
    width: animated.width ?? preview.width,
    height: animated.height ?? preview.height,
    mimeType: null,
    size: null,
    durationMs: null,
    stickerId: null,
  };
}

function fromMessageVideo(blob: Record<string, unknown>): Omit<Attachment, "type" | "id" | "extra"> {
  const large = readImage(blob.large_image);
  const original = readDimensions(blob.original_dimensions);
  return {
    filename: text(blob.filename),
    url: firstText(blob.playable_url, blob.playable_url_quality_hd),
    previewUrl: large.url,
    width: original.width ?? large.width,
    height: original.height ?? large.height,
    mimeType: null,
    size: null,
    durationMs: firstNumber(blob.playable_duration_in_ms),
    stickerId: null,
  };
}

function fromMessageAudio(blob: Record<string, unknown>): Omit<Attachment, "type" | "id" | "extra"> {
  return {
    filename: text(blob.filename),
    url: text(blob.playable_url),
    previewUrl: null,
    width: null,
    height: null,
    mimeType: text(blob.mime_type),
    size: null,
    durationMs: firstNumber(blob.playable_duration_in_ms),
    stickerId: null,
  };
}

function fromSticker(blob: Record<string, unknown>): Omit<Attachment, "type" | "id" | "extra"> {
  const metadata = asRecord(blob.metadata);
  const stickerId = firstText(
    metadata?.stickerID,
    blob.id,
    blob.stickerID,
  );
  return {
    filename: null,
    url: firstText(blob.url, blob.sprite_image, blob.spriteURI),
    previewUrl: firstText(blob.sprite_image, blob.spriteURI, metadata?.spriteURI),
    width: firstNumber(blob.width, metadata?.width),
    height: firstNumber(blob.height, metadata?.height),
    mimeType: null,
    size: null,
    durationMs: null,
    stickerId,
  };
}

function fromExtensible(blob: Record<string, unknown>): Omit<Attachment, "type" | "id" | "extra"> {
  const extensible = asRecord(blob.extensible_attachment) ?? blob;
  const story = asRecord(extensible.story_attachment);
  const media = asRecord(story?.media);
  const image = readImage(media?.image);
  const title = asRecord(story?.title_with_entities);
  const description = asRecord(story?.description);
  return {
    filename: firstText(story?.title, title?.text, extensible.title),
    url: firstText(story?.url, story?.uri, image.url),
    previewUrl: image.url,
    width: image.width,
    height: image.height,
    mimeType: null,
    size: null,
    durationMs: null,
    stickerId: null,
  };
}

function fromClassic(blob: Record<string, unknown>, type: AttachmentType): Omit<Attachment, "type" | "id" | "extra"> {
  const metadata = asRecord(blob.metadata) ?? {};
  const metadataDimensions = readDimensions(metadata.dimensions);
  const metadataImage = readImage(metadata);
  const preview = readImage(blob.preview);
  const imageData = asRecord(blob.image_data) ?? {};
  const share = asRecord(blob.share) ?? {};
  const shareMedia = asRecord(share.media);
  const shareImage = readImage(shareMedia?.image);
  const shareSize = readDimensions(shareMedia?.image_size ?? shareMedia);
  const common = {
    filename: firstText(blob.fileName, blob.filename, blob.name),
    url: firstText(
      metadata.url,
      metadataImage.url,
      blob.url,
      blob.playable_url,
      imageData.url,
      share.uri,
    ),
    previewUrl: firstText(
      blob.preview_url,
      blob.thumbnail_url,
      preview.url,
      shareImage.url,
    ),
    width: metadataDimensions.width ?? firstNumber(blob.width, imageData.width, shareSize.width),
    height: metadataDimensions.height ?? firstNumber(blob.height, imageData.height, shareSize.height),
    mimeType: text(blob.mime_type),
    size: firstNumber(blob.file_size, blob.size),
    durationMs: firstNumber(metadata.duration, blob.duration, blob.playable_duration_in_ms),
    stickerId: type === "sticker" ? firstText(metadata.stickerID, blob.stickerID, blob.id) : null,
  };
  return common;
}

/**
 * Normalizes one raw attachment. Unknown shapes become `type: "unknown"`
 * with the raw object preserved in `extra`, never an exception.
 */
export function formatAttachment(raw: unknown): Attachment {
  const input = unwrap(raw);
  if (input === null) {
    return {
      type: "unknown",
      id: "",
      filename: null,
      url: null,
      previewUrl: null,
      width: null,
      height: null,
      mimeType: null,
      size: null,
      durationMs: null,
      stickerId: null,
      extra: { raw },
    };
  }

  const { blob, wrapper } = input;
  const blobAttachment = asRecord(blob.blob_attachment);
  const core = blobAttachment ?? blob;
  const typename = text(blobAttachment?.__typename) ?? text(blob.__typename);
  const attachType = text(blob.attach_type);
  const stickerAttachment = asRecord(blob.sticker_attachment);
  const extensibleAttachment = asRecord(blob.extensible_attachment);

  let resolved = typename ?? attachType;
  if (resolved === null && stickerAttachment !== null) {
    resolved = "StickerAttachment";
  } else if (resolved === null && extensibleAttachment !== null) {
    resolved = "ExtensibleAttachment";
  }

  switch (resolved) {
    case "sticker":
    case "StickerAttachment":
      return baseAttachment("sticker", input, resolved, fromSticker(stickerAttachment ?? blob));
    case "file": {
      const fields = fromClassic(blob, "file");
      return baseAttachment("file", input, resolved, {
        ...fields,
        filename: firstText(blob.name, blob.filename, wrapper.name),
        mimeType: firstText(blob.mime_type, wrapper.mime_type),
        size: firstNumber(blob.file_size, wrapper.file_size),
      });
    }
    case "photo":
      return baseAttachment("photo", input, resolved, fromClassic(blob, "photo"));
    case "animated_image":
      return baseAttachment("animated_image", input, resolved, fromClassic(blob, "animated_image"));
    case "video":
      return baseAttachment("video", input, resolved, fromClassic(blob, "video"));
    case "audio":
      return baseAttachment("audio", input, resolved, fromClassic(blob, "audio"));
    case "share":
    case "ExtensibleAttachment":
    case "MessageLocation":
      return baseAttachment("share", input, resolved, fromExtensible(blob));
    case "MessageImage":
      return baseAttachment("photo", input, resolved, fromMessageImage(core));
    case "MessageAnimatedImage":
      return baseAttachment("animated_image", input, resolved, fromMessageAnimatedImage(core));
    case "MessageVideo":
      return baseAttachment("video", input, resolved, fromMessageVideo(core));
    case "MessageAudio":
      return baseAttachment("audio", input, resolved, fromMessageAudio(core));
    default:
      return baseAttachment("unknown", input, resolved ?? "unknown", fromClassic(blob, "unknown"));
  }
}

/** Normalizes an attachment list. */
export function formatAttachments(raw: unknown): Attachment[] {
  return asArray(raw).map((entry) => formatAttachment(entry));
}
