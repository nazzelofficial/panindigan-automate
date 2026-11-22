/**
 * Voice-upload regression: voice_clip must ONLY be sent for real voice
 * messages, never for ordinary image/file uploads.
 */
import { describe, expect, it } from "vitest";
import { buildUploadFields } from "../src/client/media.js";

describe("buildUploadFields", () => {
  it("omits voice_clip for normal uploads", () => {
    expect(buildUploadFields(false)).toEqual({});
  });

  it("includes voice_clip=true only for voice uploads", () => {
    expect(buildUploadFields(true)).toEqual({ voice_clip: "true" });
  });
});
