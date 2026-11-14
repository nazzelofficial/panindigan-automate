/**
 * Runtime validation for public method input.
 *
 * Every value that crosses into the client from the outside world is checked
 * with Zod before it reaches a transport. Failures become `ValidationError`
 * with the Zod issue list attached, so callers get one stable code
 * (`VALIDATION_FAILED`) and machine-readable details.
 */

import { z } from "zod";
import { MESSAGE_MAX_LENGTH, REACTION_EMOJI } from "../constants.js";
import { ValidationError } from "../errors/index.js";
import type {
  FileInput,
  Mention,
  MessageContent,
  MessageListOptions,
  MessageSearchOptions,
  Reaction,
  ThreadListOptions,
} from "../types/index.js";

/** An id, accepted as a numeric string or a number. */
const IdSchema = z.string().min(1).max(64);

/** Coerces a numeric id to its string form before schema validation. */
function coerceId(value: unknown): unknown {
  return typeof value === "number" ? String(value) : value;
}

export const ThreadIdSchema = IdSchema;
export const MessageIdSchema = IdSchema;
export const UserIdSchema = IdSchema;

/** A body mention. `fromIndex` is advisory; the tag is located in the body. */
const MentionSchema = z.object({
  id: IdSchema,
  tag: z.string().min(1),
  fromIndex: z.number().int().nonnegative().optional(),
});

const TextContentSchema = z
  .object({
    type: z.literal("text"),
    body: z.string().max(MESSAGE_MAX_LENGTH),
    mentions: z.array(MentionSchema).optional(),
  })
  .strict();

const StickerContentSchema = z
  .object({
    type: z.literal("sticker"),
    stickerId: IdSchema,
  })
  .strict();

const GifContentSchema = z
  .object({
    type: z.literal("gif"),
    gifId: IdSchema,
  })
  .strict();

const AttachmentContentSchema = z
  .object({
    type: z.literal("attachment"),
    attachmentId: IdSchema,
  })
  .strict();

export const MessageContentSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  StickerContentSchema,
  GifContentSchema,
  AttachmentContentSchema,
]);

const ReactionSchema = z.string().min(1).max(64);

const MessageBodySchema = z.string().min(1).max(MESSAGE_MAX_LENGTH);

const ThreadNameSchema = z.string().min(1).max(1_000);

const QuerySchema = z.string().min(1).max(1_000);

const BooleanSchema = z.boolean();

const IdArraySchema = z.array(IdSchema).min(1).max(50);

const ThreadListOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(64).optional(),
    tags: z.array(z.string().min(1)).min(1).max(10).optional(),
  })
  .strict();

const MessageListOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    before: z.number().int().nonnegative().optional(),
  })
  .strict();

const MessageSearchOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const PollOptionsSchema = z
  .array(z.string().min(1))
  .min(2, "a poll needs at least two options")
  .max(20, "a poll accepts at most twenty options")
  .refine((options) => new Set(options).size === options.length, "poll options must be unique");

const UserIdsSchema = z
  .array(IdSchema)
  .min(2, "createGroup needs at least two participant ids")
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "participant ids must be unique");

const ThreadColorSchema = z.string().min(1).max(32);

/**
 * Validates one input against a schema, converting failures to
 * `ValidationError`.
 */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new ValidationError(`Invalid ${label}: ${issues[0]?.message ?? "validation failed"}`, {
      context: { label, issues },
    });
  }
  return result.data;
}

/** Validates a thread id, returning it as a string. */
export function parseThreadId(value: unknown): string {
  return parseInput(ThreadIdSchema, coerceId(value), "threadId");
}

/** Validates a message id, returning it as a string. */
export function parseMessageId(value: unknown): string {
  return parseInput(MessageIdSchema, coerceId(value), "messageId");
}

/** Validates a user id, returning it as a string. */
export function parseUserId(value: unknown): string {
  return parseInput(UserIdSchema, coerceId(value), "userId");
}

/** Validates sendable message content. */
export function parseMessageContent(value: unknown): MessageContent {
  return parseInput(MessageContentSchema, value, "content");
}

/** Validates a reaction name or emoji. */
export function parseReaction(value: unknown): Reaction {
  return parseInput(ReactionSchema, value, "reaction");
}

/** Validates `getThreadList` options. */
export function parseThreadListOptions(value: unknown): ThreadListOptions {
  return parseInput(ThreadListOptionsSchema, value ?? {}, "options");
}

/** Validates `getMessages` options. */
export function parseMessageListOptions(value: unknown): MessageListOptions {
  return parseInput(MessageListOptionsSchema, value ?? {}, "options");
}

/** Validates `searchMessages` options. */
export function parseMessageSearchOptions(value: unknown): MessageSearchOptions {
  return parseInput(MessageSearchOptionsSchema, value ?? {}, "options");
}

/** Validates poll option text. */
export function parsePollOptions(value: unknown): readonly string[] {
  return parseInput(PollOptionsSchema, value, "options");
}

/** Validates the participant list for `createGroup`. */
export function parseUserIds(value: unknown): readonly string[] {
  return parseInput(UserIdsSchema, value, "userIds");
}

/** Validates a thread color name or hex value. */
export function parseThreadColor(value: unknown): string {
  return parseInput(ThreadColorSchema, value, "color");
}

/** Validates a message body for editing. */
export function parseMessageBody(value: unknown): string {
  return parseInput(MessageBodySchema, value, "newBody");
}

/** Validates a thread display name. */
export function parseThreadName(value: unknown): string {
  return parseInput(ThreadNameSchema, value, "name");
}

/** Validates a free-text search query. */
export function parseQuery(value: unknown): string {
  return parseInput(QuerySchema, value, "query");
}

/** Validates a boolean flag. */
export function parseBoolean(value: unknown, label: string): boolean {
  return parseInput(BooleanSchema, value, label);
}

/** Validates a list of ids (poll votes, sticker ids, …). */
export function parseIdArray(value: unknown, label: string): readonly string[] {
  return parseInput(IdArraySchema, value, label);
}

/** Accepts a path, buffer, or readable stream; rejects everything else. */
export function assertFileInput(value: unknown): asserts value is FileInput {
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new ValidationError("file must be a non-empty path", { context: { kind: "path" } });
    }
    return;
  }
  if (Buffer.isBuffer(value)) {
    return;
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as { readonly pipe?: unknown };
    if (typeof candidate.pipe === "function") {
      return;
    }
  }
  throw new ValidationError("file must be a path, a Buffer, or a readable stream", {
    context: { received: typeof value },
  });
}

/** Maps a reaction shortcut to its emoji; unknown values pass through. */
export function resolveReactionEmoji(reaction: Reaction): string {
  const known = REACTION_EMOJI[reaction as keyof typeof REACTION_EMOJI];
  return known ?? reaction;
}

/** Type helpers re-exported for the models and client modules. */
export type { Mention };
