/**
 * Delta parsers.
 *
 * One function per wire delta class, each a pure transformation from a
 * validated raw payload to zero or more typed event payloads. The
 * `DeltaProcessor` owns routing and emission; these functions are exported so
 * they can be unit-tested against captured payloads without a transport.
 *
 * Classes handled (matching `fbchat` 2.0.0a4 and the maintained
 * `fca-unofficial` fork):
 *
 * - `NewMessage`
 * - `ClientPayload` (`deltaMessageReaction`, `deltaRecallMessageData`,
 *   `deltaMessageReply`, `deltaChangeViewerStatus`)
 * - `ReadReceipt`
 * - `MarkRead`
 * - `DeliveryReceipt`
 * - `AdminTextMessage`
 * - `ThreadName`
 * - `ParticipantsAddedToGroupThread`
 * - `ParticipantLeftGroupThread`
 * - `ForcedFetch`
 * - `ThreadFolder`
 * - `MarkFolderSeen`
 * - `NoOp`
 */

import { z } from "zod";
import type {
  AdminChangeEvent,
  CallAction,
  CallEvent,
  DeliveredEvent,
  MessageEvent,
  MessageReplyEvent,
  MessageUnsendEvent,
  ParticipantJoinEvent,
  ParticipantLeaveEvent,
  PollEvent,
  PollOption,
  ReadReceiptEvent,
  ReactionEvent,
  ThreadUpdateAction,
  ThreadUpdateEvent,
} from "../types/index.js";
import { formatAttachments } from "./attachments.js";
import { extractMentions } from "./mentions.js";
import {
  asArray,
  asRecord,
  decodeClientPayload,
  IdSchema,
  isGroupKey,
  NumericStringSchema,
  otherUserIdFromKey,
  parseJsonString,
  readThreadKey,
  ThreadKeySchema,
  threadIdFromKey,
  toMillis,
  toNumber,
} from "./raw.js";

/** Context every parser needs. */
export interface ParserContext {
  /** Facebook id of the authenticated account. */
  readonly selfUserId: string;
  /** Fallback timestamp when the payload omits one. */
  readonly now: number;
}

/** A parsed event payload produced by one of the parsers. */
export type DeltaEvent =
  | MessageEvent
  | MessageReplyEvent
  | MessageUnsendEvent
  | ReactionEvent
  | ReadReceiptEvent
  | DeliveredEvent
  | ParticipantJoinEvent
  | ParticipantLeaveEvent
  | AdminChangeEvent
  | ThreadUpdateEvent
  | PollEvent
  | CallEvent;

// ---------------------------------------------------------------------------
// Raw shapes
// ---------------------------------------------------------------------------

const MessageMetadataSchema = z
  .object({
    actorFbId: IdSchema.optional(),
    threadKey: ThreadKeySchema.optional(),
    messageId: IdSchema.optional(),
    timestamp: NumericStringSchema.optional(),
    adminText: z.string().nullish(),
  })
  .passthrough();

type RawMessageMetadata = z.infer<typeof MessageMetadataSchema>;

const RawMessageSchema = z
  .object({
    body: z.string().nullish(),
    messageMetadata: MessageMetadataSchema,
    attachments: z.array(z.unknown()).nullish(),
    data: z.unknown().optional(),
    ranges: z.array(z.unknown()).nullish(),
    profileRanges: z.array(z.unknown()).nullish(),
    mention_ids: z.unknown().optional(),
    mention_offsets: z.unknown().optional(),
    mention_lengths: z.unknown().optional(),
  })
  .passthrough();

const NewMessageSchema = RawMessageSchema.extend({
  class: z.literal("NewMessage"),
});

const ReplyPayloadSchema = z
  .object({
    message: RawMessageSchema,
    repliedToMessage: RawMessageSchema.nullish(),
  })
  .passthrough();

const ReactionSchema = z
  .object({
    threadKey: ThreadKeySchema.optional(),
    messageId: IdSchema,
    reaction: z.string().nullish(),
    senderId: IdSchema.optional(),
    userId: IdSchema,
    action: NumericStringSchema.optional(),
  })
  .passthrough();

const RecallSchema = z
  .object({
    threadKey: ThreadKeySchema.optional(),
    messageID: IdSchema,
    senderID: IdSchema,
    deletionTimestamp: NumericStringSchema.optional(),
    timestamp: NumericStringSchema.optional(),
  })
  .passthrough();

const ReadReceiptSchema = z
  .object({
    threadKey: ThreadKeySchema.optional(),
    actorFbId: IdSchema.optional(),
    actionTimestampMs: NumericStringSchema.optional(),
  })
  .passthrough();

const MarkReadSchema = z
  .object({
    threadKeys: z.array(ThreadKeySchema).optional(),
    actionTimestamp: NumericStringSchema.optional(),
  })
  .passthrough();

const DeliveryReceiptSchema = z
  .object({
    threadKey: ThreadKeySchema.optional(),
    messageIds: z.array(IdSchema).optional(),
    actorFbId: IdSchema.optional(),
    deliveredWatermarkTimestampMs: NumericStringSchema.optional(),
  })
  .passthrough();

const ThreadNameSchema = z
  .object({
    class: z.literal("ThreadName"),
    name: z.string().nullish(),
    messageMetadata: MessageMetadataSchema,
  })
  .passthrough();

const ParticipantsAddedSchema = z
  .object({
    class: z.literal("ParticipantsAddedToGroupThread"),
    addedParticipants: z
      .array(z.object({ userFbId: IdSchema }).passthrough())
      .optional(),
    messageMetadata: MessageMetadataSchema,
  })
  .passthrough();

const ParticipantLeftSchema = z
  .object({
    class: z.literal("ParticipantLeftGroupThread"),
    leftParticipantFbId: IdSchema,
    messageMetadata: MessageMetadataSchema,
  })
  .passthrough();

const AdminTextSchema = z
  .object({
    class: z.literal("AdminTextMessage"),
    type: z.string().optional(),
    untypedData: z.unknown().optional(),
    messageMetadata: MessageMetadataSchema,
  })
  .passthrough();

const ForcedFetchSchema = z
  .object({
    class: z.literal("ForcedFetch"),
    threadKey: ThreadKeySchema.optional(),
    messageId: IdSchema.optional(),
  })
  .passthrough();

const ThreadFolderSchema = z
  .object({
    class: z.literal("ThreadFolder"),
    threadKey: ThreadKeySchema.optional(),
    folder: z.unknown().optional(),
    messageMetadata: MessageMetadataSchema.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EventMeta {
  readonly threadId: string | null;
  readonly actorId: string | null;
  readonly timestamp: number;
  readonly isGroup: boolean;
}

function readMeta(metadata: RawMessageMetadata, ctx: ParserContext): EventMeta {
  const threadId = threadIdFromKey(metadata.threadKey ?? null);
  const actorId = metadata.actorFbId ?? null;
  return {
    threadId,
    actorId,
    timestamp: toMillis(metadata.timestamp) ?? ctx.now,
    isGroup: isGroupKey(metadata.threadKey ?? null),
  };
}

function readUntypedData(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record !== null) {
    return record;
  }
  const parsed = parseJsonString(value);
  return asRecord(parsed) ?? {};
}

function readBody(body: string | null | undefined): string {
  return body ?? "";
}

function buildMessage(
  message: z.infer<typeof RawMessageSchema>,
  rawRecord: Record<string, unknown>,
  ctx: ParserContext,
): Omit<MessageEvent, "type"> | null {
  const meta = readMeta(message.messageMetadata, ctx);
  const messageId = message.messageMetadata.messageId ?? null;
  const senderId = message.messageMetadata.actorFbId ?? null;
  if (meta.threadId === null || messageId === null || senderId === null) {
    return null;
  }
  const body = readBody(message.body);
  return {
    timestamp: meta.timestamp,
    messageId,
    threadId: meta.threadId,
    senderId,
    isGroup: meta.isGroup,
    body: message.body === undefined || message.body === null ? null : body,
    attachments: formatAttachments(message.attachments),
    mentions: extractMentions(rawRecord, body),
    isSelf: senderId === ctx.selfUserId,
  };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** `NewMessage` — a plain user message. */
export function parseNewMessage(raw: unknown, ctx: ParserContext): MessageEvent | null {
  const parsed = NewMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const rawRecord = asRecord(raw) ?? {};
  const base = buildMessage(parsed.data, rawRecord, ctx);
  return base === null ? null : { type: "message", ...base };
}

/** `NewMessage`-shaped payload used for forced fetches and history rows. */
export function parseMessagePayload(raw: unknown, ctx: ParserContext): MessageEvent | null {
  const parsed = RawMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const rawRecord = asRecord(raw) ?? {};
  const base = buildMessage(parsed.data, rawRecord, ctx);
  return base === null ? null : { type: "message", ...base };
}

/** A `deltaMessageReply` client-payload entry. */
export function parseMessageReply(raw: unknown, ctx: ParserContext): MessageEvent | MessageReplyEvent | null {
  const parsed = ReplyPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const rawRecord = asRecord(raw) ?? {};
  const messageRecord = asRecord(rawRecord.message) ?? {};
  const base = buildMessage(parsed.data.message, messageRecord, ctx);
  if (base === null) {
    return null;
  }
  const repliedTo = parsed.data.repliedToMessage;
  const repliedToMessageId =
    repliedTo === undefined || repliedTo === null ? null : repliedTo.messageMetadata.messageId ?? null;
  if (repliedToMessageId === null) {
    return { type: "message", ...base };
  }
  return { type: "message_reply", ...base, repliedToMessageId };
}

/** A `deltaMessageReaction` client-payload entry. */
export function parseReaction(raw: unknown, ctx: ParserContext): ReactionEvent | null {
  const parsed = ReactionSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const delta = parsed.data;
  const threadId = threadIdFromKey(delta.threadKey ?? null);
  if (threadId === null) {
    return null;
  }
  const action = delta.action === undefined ? 0 : Number(delta.action);
  const emoji = action !== 0 || delta.reaction === "" ? null : delta.reaction ?? null;
  return {
    type: "reaction",
    timestamp: ctx.now,
    threadId,
    messageId: delta.messageId,
    userId: delta.userId,
    emoji,
    isSelf: delta.userId === ctx.selfUserId,
  };
}

/** A `deltaRecallMessageData` client-payload entry (unsend). */
export function parseUnsend(raw: unknown, ctx: ParserContext): MessageUnsendEvent | null {
  const parsed = RecallSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const delta = parsed.data;
  const threadId = threadIdFromKey(delta.threadKey ?? null);
  if (threadId === null) {
    return null;
  }
  return {
    type: "message_unsend",
    timestamp: toMillis(delta.deletionTimestamp) ?? toMillis(delta.timestamp) ?? ctx.now,
    threadId,
    messageId: delta.messageID,
    senderId: delta.senderID,
    isSelf: delta.senderID === ctx.selfUserId,
  };
}

/** A `deltaChangeViewerStatus` client-payload entry, surfaced as a thread update. */
export function parseViewerStatus(raw: unknown, ctx: ParserContext): ThreadUpdateEvent | null {
  const parsed = z
    .object({
      threadKey: ThreadKeySchema.optional(),
      actorFbid: IdSchema.optional(),
      reason: NumericStringSchema.optional(),
      canViewerReply: z.boolean().optional(),
    })
    .passthrough()
    .safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const delta = parsed.data;
  const threadId = threadIdFromKey(delta.threadKey ?? null);
  if (threadId === null) {
    return null;
  }
  const actorId = delta.actorFbid ?? "";
  return {
    type: "thread_update",
    timestamp: ctx.now,
    threadId,
    actorId,
    action: "unknown",
    details: {
      change: "viewer_status",
      reason: delta.reason ?? null,
      canViewerReply: delta.canViewerReply ?? null,
    },
    isSelf: actorId === ctx.selfUserId,
  };
}

/** A `ReadReceipt` delta. */
export function parseReadReceipt(raw: unknown, ctx: ParserContext): ReadReceiptEvent | null {
  const parsed = ReadReceiptSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const delta = parsed.data;
  const threadId = threadIdFromKey(delta.threadKey ?? null);
  const readerId = otherUserIdFromKey(delta.threadKey ?? null) ?? delta.actorFbId ?? null;
  if (threadId === null || readerId === null) {
    return null;
  }
  const timestamp = toMillis(delta.actionTimestampMs) ?? ctx.now;
  return {
    type: "read",
    timestamp,
    threadId,
    readerId,
    watermark: toMillis(delta.actionTimestampMs),
    isSelf: readerId === ctx.selfUserId,
  };
}

/** A `MarkRead` delta (the account read threads on another device). */
export function parseMarkRead(raw: unknown, ctx: ParserContext): ReadReceiptEvent[] {
  const parsed = MarkReadSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  const delta = parsed.data;
  const watermark = toMillis(delta.actionTimestamp);
  const timestamp = watermark ?? ctx.now;
  const events: ReadReceiptEvent[] = [];
  const seen = new Set<string>();
  for (const key of delta.threadKeys ?? []) {
    const threadId = threadIdFromKey(key);
    if (threadId === null || seen.has(threadId)) {
      continue;
    }
    seen.add(threadId);
    events.push({
      type: "read",
      timestamp,
      threadId,
      readerId: ctx.selfUserId,
      watermark,
      isSelf: true,
    });
  }
  return events;
}

/** A `DeliveryReceipt` delta. */
export function parseDeliveryReceipt(raw: unknown, ctx: ParserContext): DeliveredEvent | null {
  const parsed = DeliveryReceiptSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const delta = parsed.data;
  const threadId = threadIdFromKey(delta.threadKey ?? null);
  const deliveredTo = delta.actorFbId ?? otherUserIdFromKey(delta.threadKey ?? null);
  if (threadId === null || deliveredTo === null || deliveredTo === undefined) {
    return null;
  }
  return {
    type: "delivered",
    timestamp: toMillis(delta.deliveredWatermarkTimestampMs) ?? ctx.now,
    threadId,
    deliveredTo,
    messageIds: delta.messageIds ?? [],
    isSelf: deliveredTo === ctx.selfUserId,
  };
}

/** A `ThreadName` delta. */
export function parseThreadName(raw: unknown, ctx: ParserContext): ThreadUpdateEvent | null {
  const parsed = ThreadNameSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const delta = parsed.data;
  const meta = readMeta(delta.messageMetadata, ctx);
  if (meta.threadId === null) {
    return null;
  }
  const actorId = meta.actorId ?? "";
  return {
    type: "thread_update",
    timestamp: meta.timestamp,
    threadId: meta.threadId,
    actorId,
    action: "name",
    details: { name: delta.name ?? null },
    isSelf: actorId === ctx.selfUserId,
  };
}

/** A `ParticipantsAddedToGroupThread` delta. */
export function parseParticipantsAdded(raw: unknown, ctx: ParserContext): ParticipantJoinEvent | null {
  const parsed = ParticipantsAddedSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const delta = parsed.data;
  const meta = readMeta(delta.messageMetadata, ctx);
  if (meta.threadId === null) {
    return null;
  }
  const addedIds = (delta.addedParticipants ?? []).map((entry) => entry.userFbId);
  if (addedIds.length === 0) {
    return null;
  }
  const addedBy = meta.actorId ?? "";
  return {
    type: "participant_join",
    timestamp: meta.timestamp,
    threadId: meta.threadId,
    addedIds,
    addedBy,
    isSelf: addedBy === ctx.selfUserId,
  };
}

/** A `ParticipantLeftGroupThread` delta. */
export function parseParticipantLeft(raw: unknown, ctx: ParserContext): ParticipantLeaveEvent | null {
  const parsed = ParticipantLeftSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const delta = parsed.data;
  const meta = readMeta(delta.messageMetadata, ctx);
  if (meta.threadId === null) {
    return null;
  }
  const removedBy = meta.actorId ?? "";
  return {
    type: "participant_leave",
    timestamp: meta.timestamp,
    threadId: meta.threadId,
    removedIds: [delta.leftParticipantFbId],
    removedBy,
    isSelf: removedBy === ctx.selfUserId,
  };
}

// ---------------------------------------------------------------------------
// Admin text
// ---------------------------------------------------------------------------

function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}

function parsePollOptions(raw: unknown): PollOption[] {
  return asArray(raw).flatMap((entry) => {
    const record = asRecord(entry);
    if (record === null) {
      return [];
    }
    const id = record.id;
    if (typeof id !== "string" && typeof id !== "number") {
      return [];
    }
    const votersRecord = asRecord(record.voters);
    const rawVoters = votersRecord === null ? record.voters : votersRecord.edges;
    const voters = asArray(rawVoters).flatMap((voter) => {
      if (typeof voter === "string" || typeof voter === "number") {
        return [String(voter)];
      }
      const edge = asRecord(voter);
      const node = edge === null ? null : asRecord(edge.node);
      const voterId = node?.id;
      return typeof voterId === "string" || typeof voterId === "number" ? [String(voterId)] : [];
    });
    const voteCount =
      toNumber(votersRecord?.count) ??
      toNumber(record.total_count) ??
      toNumber(record.vote_count) ??
      voters.length;
    const rawViewerVoted = record.viewer_has_voted ?? record.vote;
    const viewerHasVoted =
      rawViewerVoted === true || rawViewerVoted === "true" || rawViewerVoted === 1 || rawViewerVoted === "1";
    return [
      {
        id: String(id),
        text: typeof record.text === "string" ? record.text : "",
        voters,
        voteCount,
        viewerHasVoted,
      },
    ];
  });
}

function parsePollEvent(
  untyped: Record<string, unknown>,
  meta: EventMeta,
  ctx: ParserContext,
): PollEvent | null {
  const eventType = firstString(untyped.event_type);
  const action =
    eventType === "question_creation"
      ? "created"
      : eventType === "update_vote"
        ? "voted"
        : eventType === "question_ended" || eventType === "end_poll"
          ? "ended"
          : null;
  if (action === null) {
    return null;
  }
  const questionData = asRecord(parseJsonString(untyped.question_json));
  const questionId = questionData === null ? null : questionData.id;
  const pollId =
    typeof questionId === "string" || typeof questionId === "number"
      ? String(questionId)
      : firstString(untyped.question_id) ?? "";
  const actorId = meta.actorId;
  return {
    type: "poll",
    timestamp: meta.timestamp,
    threadId: meta.threadId ?? "",
    pollId,
    action,
    question: questionData === null ? null : firstString(questionData.title, questionData.text),
    options: questionData === null ? [] : parsePollOptions(questionData.options),
    actorId,
    isSelf: actorId !== null && actorId === ctx.selfUserId,
  };
}

function callAction(event: string | null): CallAction | null {
  switch (event) {
    case "group_call_started":
    case "call_started":
    case "video_call_started":
      return "started";
    case "participant_joined_group_call":
    case "group_call_joined":
      return "joined";
    case "group_call_ended":
    case "one_on_one_call_ended":
    case "call_ended":
      return "ended";
    default:
      return null;
  }
}

function parseCallEvent(
  untyped: Record<string, unknown>,
  event: string | null,
  meta: EventMeta,
  ctx: ParserContext,
): CallEvent | null {
  const action = callAction(event);
  if (action === null) {
    return null;
  }
  const actorId = meta.actorId ?? "";
  const callId =
    firstString(untyped.call_id, untyped.video_call_id, untyped.callId) ?? "";
  const videoFlag = untyped.video_call ?? untyped.is_video;
  const isVideo =
    videoFlag === true || videoFlag === 1 || videoFlag === "1" || videoFlag === "true"
      ? true
      : event !== null && event.includes("video")
        ? true
        : null;
  return {
    type: "call",
    timestamp: meta.timestamp,
    threadId: meta.threadId ?? "",
    callId,
    callerId: actorId,
    action,
    isVideo,
    isSelf: actorId !== "" && actorId === ctx.selfUserId,
  };
}

const ADMIN_ACTIONS: Readonly<Record<string, ThreadUpdateAction>> = {
  change_thread_theme: "color",
  change_thread_icon: "emoji",
  change_thread_nickname: "nickname",
  change_thread_approval_mode: "approval_queue",
  change_thread_name: "name",
  change_thread_subject: "name",
  thread_name: "name",
  joinable_group_link_mode_change: "mode",
  magic_words: "mode",
};

/**
 * An `AdminTextMessage` delta. Some admin text types map to `call` or `poll`
 * events rather than thread updates, so one delta can produce several
 * payloads (the return is an array, ordered).
 */
export function parseAdminText(raw: unknown, ctx: ParserContext): DeltaEvent[] {
  const parsed = AdminTextSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  const delta = parsed.data;
  const meta = readMeta(delta.messageMetadata, ctx);
  if (meta.threadId === null) {
    return [];
  }
  const type = delta.type ?? "";
  const untyped = readUntypedData(delta.untypedData);
  const actorId = meta.actorId ?? "";
  const isSelf = actorId !== "" && actorId === ctx.selfUserId;
  const timestamp = meta.timestamp;

  if (type === "change_thread_admins") {
    const eventType = firstString(untyped.ADMIN_EVENT);
    const promoted = eventType === "add_admin";
    const userId = firstString(untyped.TARGET_ID);
    if (userId === null) {
      return [];
    }
    return [
      {
        type: "admin_change",
        timestamp,
        threadId: meta.threadId,
        userId,
        promoted,
        isSelf,
      },
    ];
  }

  if (type === "group_poll") {
    const event = parsePollEvent(untyped, meta, ctx);
    return event === null ? [] : [event];
  }

  if (type === "messenger_call_log" || type === "rtc_call_log") {
    const event = parseCallEvent(untyped, firstString(untyped.event), meta, ctx);
    return event === null ? [] : [event];
  }

  if (type === "participant_joined_group_call") {
    const event = parseCallEvent(untyped, "participant_joined_group_call", meta, ctx);
    return event === null ? [] : [event];
  }

  const action = ADMIN_ACTIONS[type] ?? "unknown";
  const details: Record<string, unknown> = {};
  switch (action) {
    case "color":
      details.color = firstString(untyped.theme_color);
      break;
    case "emoji":
      details.emoji = firstString(untyped.thread_icon);
      break;
    case "nickname":
      details.userId = firstString(untyped.participant_id);
      details.nickname = firstString(untyped.nickname);
      break;
    case "approval_queue":
      details.requireAdminApproval = untyped.APPROVAL_MODE === "1";
      break;
    case "name":
      details.name = firstString(untyped.name) ?? delta.messageMetadata.adminText ?? null;
      break;
    case "mode":
      details.mode = firstString(untyped.mode, untyped.link_mode);
      break;
    default:
      details.adminType = type;
      details.data = untyped;
      break;
  }

  return [
    {
      type: "thread_update",
      timestamp,
      threadId: meta.threadId,
      actorId,
      action,
      details,
      isSelf,
    },
  ];
}

/** A `ThreadFolder` delta: the thread moved between inbox folders. */
export function parseThreadFolder(raw: unknown, ctx: ParserContext): ThreadUpdateEvent | null {
  const parsed = ThreadFolderSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const delta = parsed.data;
  const threadId = threadIdFromKey(delta.threadKey ?? null);
  if (threadId === null) {
    return null;
  }
  const meta = delta.messageMetadata === undefined ? null : readMeta(delta.messageMetadata, ctx);
  const actorId = meta?.actorId ?? "";
  return {
    type: "thread_update",
    timestamp: meta?.timestamp ?? ctx.now,
    threadId,
    actorId,
    action: "mode",
    details: { folder: delta.folder ?? null },
    isSelf: actorId !== "" && actorId === ctx.selfUserId,
  };
}

/** A `ForcedFetch` delta: the message body must be fetched over GraphQL. */
export function parseForcedFetch(raw: unknown): { readonly threadId: string; readonly messageId: string } | null {
  const parsed = ForcedFetchSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const threadId = threadIdFromKey(parsed.data.threadKey ?? null);
  const messageId = parsed.data.messageId ?? null;
  if (threadId === null || messageId === null) {
    return null;
  }
  return { threadId, messageId };
}

/**
 * Parses the deltas inside a `ClientPayload` envelope. Unknown inner keys are
 * ignored; the raw event already carries the complete payload.
 */
export function parseClientPayload(raw: unknown, ctx: ParserContext): DeltaEvent[] {
  const parsed = z
    .object({
      class: z.literal("ClientPayload"),
      payload: z.unknown(),
    })
    .passthrough()
    .safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  const decoded = asRecord(decodeClientPayload(parsed.data.payload));
  if (decoded === null) {
    return [];
  }
  const events: DeltaEvent[] = [];
  for (const entry of asArray(decoded.deltas)) {
    const delta = asRecord(entry);
    if (delta === null) {
      continue;
    }
    if (delta.deltaMessageReaction !== undefined) {
      const event = parseReaction(delta.deltaMessageReaction, ctx);
      if (event !== null) {
        events.push(event);
      }
    }
    if (delta.deltaRecallMessageData !== undefined) {
      const event = parseUnsend(delta.deltaRecallMessageData, ctx);
      if (event !== null) {
        events.push(event);
      }
    }
    if (delta.deltaMessageReply !== undefined) {
      const event = parseMessageReply(delta.deltaMessageReply, ctx);
      if (event !== null) {
        events.push(event);
      }
    }
    if (delta.deltaChangeViewerStatus !== undefined) {
      const event = parseViewerStatus(delta.deltaChangeViewerStatus, ctx);
      if (event !== null) {
        events.push(event);
      }
    }
  }
  return events;
}
