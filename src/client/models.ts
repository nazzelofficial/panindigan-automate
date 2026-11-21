/**
 * Payload normalizers.
 *
 * Facebook returns the same entities in several shapes: GraphQL nodes for
 * history and forced fetches, Mercury-style thread summaries for search, and
 * legacy profile maps for the user-info endpoints. These functions collapse
 * them into the public model types, never throwing on a partially shaped
 * payload — a missing optional field becomes `null`/`0`, and unknown message
 * typenames become `kind: "system"` entries with the raw data preserved.
 */

import { formatAttachment } from "../delta/attachments.js";
import { asArray, asRecord, toMillis, toNumber } from "../delta/raw.js";
import type {
  Attachment,
  Message,
  MessageEvent,
  MessageReaction,
  MessageReplyEvent,
  Mention,
  PollInfo,
  PollOption,
  PresenceInfo,
  PresenceStatus,
  ThreadInfo,
  ThreadParticipant,
  UserInfo,
  UserSearchResult,
} from "../types/index.js";

/** Gender codes Facebook's friend-list endpoint returns. */
const GENDER_CODES: Readonly<Record<number, string>> = {
  0: "unknown",
  1: "female_singular",
  2: "male_singular",
  3: "female_singular_guess",
  4: "male_singular_guess",
  5: "mixed",
  6: "neuter_singular",
  7: "unknown_singular",
  8: "female_plural",
  9: "male_plural",
  10: "neuter_plural",
  11: "unknown_plural",
};

/** GraphQL message typenames that represent thread-log entries, not user text. */
const SYSTEM_MESSAGE_TYPES = new Set([
  "ThreadNameMessage",
  "ThreadImageMessage",
  "ParticipantsAddedMessage",
  "ParticipantLeftMessage",
  "GenericAdminTextMessage",
  "VideoCallMessage",
  "VoiceCallMessage",
]);

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

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

/** Strips the alpha byte from an 8-digit ARGB color, leaving RRGGBB. */
export function normalizeColor(value: unknown): string | null {
  const color = text(value);
  if (color === null) {
    return null;
  }
  return /^[0-9a-fA-F]{8}$/.test(color) ? color.slice(2) : color;
}

/** Maps Facebook's numeric gender codes, passing strings through. */
export function normalizeGender(value: unknown): string | null {
  const code = toNumber(value);
  if (code !== null) {
    return GENDER_CODES[code] ?? "unknown";
  }
  return text(value);
}

/** Normalizes a `messaging_actor` participant. */
export function normalizeParticipant(raw: unknown): ThreadParticipant | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const id = firstText(record.id, record.userID, record.user_id);
  if (id === null) {
    return null;
  }
  const typename = text(record.__typename);
  const accountType =
    typename === null
      ? null
      : typename === "User"
        ? "user"
        : typename === "Page"
          ? "page"
          : typename === "ReducedMessagingActor"
            ? "reduce"
            : typename.toLowerCase();
  return {
    id,
    name: firstText(record.name, record.short_name, record.shortName),
    accountType,
  };
}

/** Normalizes a GraphQL thread node (or a `message_thread` wrapper). */
export function normalizeThread(raw: unknown): ThreadInfo | null {
  const outer = asRecord(raw);
  if (outer === null) {
    return null;
  }
  const thread = asRecord(outer["message_thread"]) ?? outer;
  const key = asRecord(thread["thread_key"]);
  const id = firstText(
    key?.["thread_fbid"],
    key?.["other_user_id"],
    thread["thread_fbid"],
    thread["thread_id"],
    thread["other_user_id"],
  );
  if (id === null) {
    return null;
  }

  const threadType = text(thread["thread_type"]);
  const isGroup = threadType !== null ? threadType.toUpperCase() === "GROUP" : key?.["thread_fbid"] !== undefined;

  const customization = asRecord(thread["customization_info"]);
  const participants: ThreadParticipant[] = [];
  const participantIds: string[] = [];
  const adminIDs: string[] = [];
  const edges = asArray(asRecord(thread["all_participants"])?.["edges"]);
  for (const edgeRaw of edges) {
    const edge = asRecord(edgeRaw);
    const node = edge !== null ? asRecord(edge["node"]) : null;
    const actor = node !== null ? (asRecord(node["messaging_actor"]) ?? node) : null;
    const participant = normalizeParticipant(actor);
    if (participant !== null) {
      participants.push(participant);
      participantIds.push(participant.id);
    }
    // Participant-level admin marker (modern GraphQL sometimes carries the
    // role on the node or the actor rather than a top-level admin_ids list).
    const adminFlag = node?.["is_admin"] ?? actor?.["is_admin"] ?? node?.["isGroupAdmin"];
    if (participant !== null && (adminFlag === true || text(node?.["admin_type"]) !== null)) {
      adminIDs.push(participant.id);
    }
  }
  // Classic FCA shape: top-level `admin_ids` (array of ids or objects).
  for (const rawAdmin of asArray(thread["admin_ids"])) {
    const record = asRecord(rawAdmin);
    const id = record !== null ? firstText(record["id"], record["user_id"], record["profile_id"]) : text(rawAdmin);
    if (id !== null && !adminIDs.includes(id)) adminIDs.push(id);
  }

  const nicknames: Record<string, string> = {};
  for (const entry of asArray(customization?.["participant_customizations"])) {
    const record = asRecord(entry);
    const participantId = record !== null ? firstText(record["participant_id"]) : null;
    const nickname = record !== null ? text(record["nickname"]) : null;
    if (participantId !== null && nickname !== null) {
      nicknames[participantId] = nickname;
    }
  }

  const lastMessage = asRecord(thread["last_message"]);
  const lastMessageNodes = asArray(lastMessage?.["nodes"]);
  const lastReadReceipt = asRecord(thread["last_read_receipt"]);
  const lastReadNodes = asArray(lastReadReceipt?.["nodes"]);

  let name = text(thread["name"]);
  if (name === null && key?.["thread_fbid"] === undefined) {
    const otherUserId = firstText(key?.["other_user_id"]);
    const other = participants.find((participant) => participant.id === otherUserId);
    name = other?.name ?? null;
  }

  const muteUntil = toNumber(thread["mute_until"]);
  const updatedAt = toMillis(thread["updated_time_precise"]) ?? Date.now();

  return {
    id,
    name,
    isGroup,
    participantIds,
    participants,
    adminIDs,
    unreadCount: toNumber(thread["unread_count"]) ?? 0,
    emoji: firstText(customization?.["emoji"]),
    color: normalizeColor(customization?.["outgoing_bubble_color"]),
    nicknames,
    photoUrl: firstText(asRecord(thread["image"])?.["uri"]),
    lastMessageTimestamp: toMillis(lastMessage?.["timestamp_precise"]),
    lastReadTimestamp: toMillis(asRecord(lastReadNodes[0])?.["timestamp_precise"]),
    isArchived: typeof thread["has_viewer_archived"] === "boolean" ? thread["has_viewer_archived"] : null,
    muteUntil,
    canReply: thread["cannot_reply_reason"] == null,
    snippet: firstText(asRecord(lastMessageNodes[0])?.["snippet"]),
    updatedAt,
  };
}

/** Normalizes a legacy Mercury thread summary from thread search. */
export function normalizeLegacyThread(raw: unknown): ThreadInfo | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const id = firstText(record["thread_fbid"], record["other_user_id"], record["threadID"], record["id"]);
  if (id === null) {
    return null;
  }

  const participantIds: string[] = [];
  for (const entry of asArray(record["participants"])) {
    if (typeof entry === "string" || typeof entry === "number") {
      participantIds.push(String(entry));
      continue;
    }
    const entryRecord = asRecord(entry);
    const entryId = entryRecord !== null ? firstText(entryRecord["id"], entryRecord["userID"]) : null;
    if (entryId !== null) {
      participantIds.push(entryId);
    }
  }

  const nicknames: Record<string, string> = {};
  const customNicknames = asRecord(record["custom_nickname"]);
  if (customNicknames !== null) {
    for (const [participantId, nickname] of Object.entries(customNicknames)) {
      const value = text(nickname);
      if (value !== null) {
        nicknames[participantId] = value;
      }
    }
  }

  const threadType = text(record["thread_type"]);
  const isGroup = threadType !== null && threadType.toUpperCase() === "GROUP";

  return {
    id,
    name: firstText(record["name"]),
    isGroup,
    participantIds,
    participants: participantIds.map((participantId) => ({
      id: participantId,
      name: null,
      accountType: null,
    })),
    adminIDs: asArray(record["admin_ids"])
      .map((raw) => (asRecord(raw) !== null ? firstText(asRecord(raw)!["id"], asRecord(raw)!["user_id"]) : text(raw)))
      .filter((id): id is string => id !== null),
    unreadCount: toNumber(record["unread_count"]) ?? 0,
    emoji: firstText(record["custom_like_icon"]),
    color: normalizeColor(record["custom_color"]),
    nicknames,
    photoUrl: firstText(record["image_src"]),
    lastMessageTimestamp: toMillis(record["last_message_timestamp"]),
    lastReadTimestamp: toMillis(record["last_read_timestamp"]),
    isArchived: typeof record["is_archived"] === "boolean" ? record["is_archived"] : null,
    muteUntil: toNumber(record["mute_until"]),
    canReply: record["cannot_reply_reason"] == null,
    snippet: firstText(record["snippet"]),
    updatedAt: toMillis(record["timestamp"]) ?? Date.now(),
  };
}

/** Normalizes a profile from `/chat/user_info/` or `/chat/user_info_all`. */
export function normalizeUser(raw: unknown, fallbackId?: string | undefined): UserInfo | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const id = firstText(record["id"], record["userID"], record["user_id"], fallbackId);
  if (id === null) {
    return null;
  }
  const bigImage = asRecord(record["big_image_src"]);
  return {
    id,
    name: firstText(record["name"], record["fullName"]),
    firstName: firstText(record["firstName"], record["first_name"], record["short_name"], record["shortName"]),
    vanity: firstText(record["vanity"], record["username"]),
    profileUrl: firstText(record["uri"], record["url"], record["profileUrl"], bigImage?.["uri"]),
    photoUrl: firstText(record["thumbSrc"], record["profilePicture"], bigImage?.["uri"]),
    gender: normalizeGender(record["gender"]),
    isFriend: bool(record["is_friend"] ?? record["isFriend"]),
    isVerified: bool(record["is_verified"] ?? record["isVerified"]),
    isBirthday: bool(record["is_birthday"] ?? record["isBirthday"]),
    type: firstText(record["type"], record["__typename"]),
  };
}

/** Normalizes one typeahead search hit. */
export function normalizeSearchUser(raw: unknown): UserSearchResult | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const id = firstText(record["uid"], record["id"]);
  if (id === null) {
    return null;
  }
  return {
    id,
    name: firstText(record["text"], record["name"]),
    photoUrl: firstText(record["photo"]),
    profileUrl: firstText(record["path"], record["profileUrl"]),
    isVerified: bool(record["is_verified"] ?? record["isVerified"]),
    category: firstText(record["category"]),
  };
}

function normalizeVoters(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    const voters: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string" || typeof entry === "number") {
        voters.push(String(entry));
        continue;
      }
      const record = asRecord(entry);
      const node = record !== null ? asRecord(record["node"]) : null;
      const id = firstText(record?.["id"], node?.["id"]);
      if (id !== null) {
        voters.push(id);
      }
    }
    return voters;
  }
  const record = asRecord(value);
  if (record !== null) {
    const edges = asArray(record["edges"]);
    const voters: string[] = [];
    for (const edgeRaw of edges) {
      const edge = asRecord(edgeRaw);
      const node = edge !== null ? asRecord(edge["node"]) : null;
      const id = node !== null ? firstText(node["id"]) : null;
      if (id !== null) {
        voters.push(id);
      }
    }
    return voters;
  }
  return [];
}

/** Normalizes one poll option. */
export function normalizePollOption(raw: unknown): PollOption | null {
  const record = asRecord(raw);
  if (record === null) {
    return null;
  }
  const id = firstText(record["id"]);
  if (id === null) {
    return null;
  }
  const voters = normalizeVoters(record["voters"]);
  return {
    id,
    text: text(record["text"]) ?? "",
    voters,
    voteCount: firstNumber(record["total_count"], record["voteCount"]) ?? voters.length,
    viewerHasVoted: bool(record["viewer_has_voted"] ?? record["viewerHasVoted"]),
  };
}

/** Normalizes a poll option list from `get_poll_options` or a poll payload. */
export function normalizePollOptions(payload: unknown): readonly PollOption[] {
  const list = Array.isArray(payload)
    ? payload
    : asArray(asRecord(payload)?.["payload"]).length > 0
      ? asArray(asRecord(payload)?.["payload"])
      : asArray(asRecord(payload)?.["options"]);
  const options: PollOption[] = [];
  for (const entry of list) {
    const option = normalizePollOption(entry);
    if (option !== null) {
      options.push(option);
    }
  }
  return options;
}

/** Assembles a `PollInfo`, using the cached question when the endpoint omits it. */
export function normalizePoll(pollId: string, options: readonly PollOption[], question: string | null): PollInfo {
  return {
    id: pollId,
    question: question ?? "",
    options,
    optionCount: options.length,
  };
}

function stickerAttachment(raw: unknown): Attachment {
  const sticker = asRecord(raw);
  const id = firstText(sticker?.["id"], sticker?.["stickerID"]);
  return {
    type: "sticker",
    id: id ?? "",
    filename: firstText(sticker?.["label"]),
    url: firstText(sticker?.["url"]),
    previewUrl: firstText(sticker?.["sprite_image"], sticker?.["sprite_image_2x"]),
    width: firstNumber(sticker?.["width"]),
    height: firstNumber(sticker?.["height"]),
    mimeType: null,
    size: null,
    durationMs: null,
    stickerId: id,
    extra: { raw: sticker ?? {} },
  };
}

function mentionsFromRanges(body: unknown, ranges: unknown): readonly Mention[] {
  const text = typeof body === "string" ? body : "";
  const mentions: Mention[] = [];
  for (const entry of asArray(ranges)) {
    const range = asRecord(entry);
    const entity = range !== null ? asRecord(range["entity"]) : null;
    const id = entity !== null ? firstText(entity["id"]) : null;
    const offset = firstNumber(range?.["offset"]);
    const length = firstNumber(range?.["length"]);
    if (id === null || offset === null || length === null) {
      continue;
    }
    mentions.push({ id, tag: text.slice(offset, offset + length), fromIndex: offset });
  }
  return mentions;
}

function reactionsFromList(raw: unknown): readonly MessageReaction[] {
  const reactions: MessageReaction[] = [];
  for (const entry of asArray(raw)) {
    const record = asRecord(entry);
    const user = record !== null ? asRecord(record["user"]) : null;
    const userId = user !== null ? firstText(user["id"]) : firstText(record?.["userID"]);
    const emoji = firstText(record?.["reaction"]);
    if (userId !== null && emoji !== null) {
      reactions.push({ userId, emoji });
    }
  }
  return reactions;
}

/**
 * Normalizes a GraphQL message node from history or a forced fetch.
 * Returns `null` when the node has no message id.
 */
export function normalizeMessageNode(raw: unknown, threadId: string, selfUserId: string): Message | null {
  const node = asRecord(raw);
  if (node === null) {
    return null;
  }
  const id = firstText(node["message_id"], node["messageID"], node["id"]);
  if (id === null) {
    return null;
  }
  const sender = asRecord(node["message_sender"]);
  const actor = sender !== null ? (asRecord(sender["messaging_actor"]) ?? sender) : null;
  const senderId = firstText(sender?.["id"], actor?.["id"], node["author"]) ?? "";
  const typename = firstText(node["__typename"]) ?? "UserMessage";
  const timestamp = toMillis(node["timestamp_precise"]) ?? toMillis(node["timestamp"]) ?? Date.now();
  const isSystem = SYSTEM_MESSAGE_TYPES.has(typename);

  let body: string | null = null;
  let attachments: readonly Attachment[] = [];
  let mentions: readonly Mention[] = [];
  let reactions: readonly MessageReaction[] = [];
  let systemType: string | null = null;
  let systemData: Record<string, unknown> = {};

  if (isSystem) {
    systemType = typename;
    body = firstText(node["snippet"]);
    const image = asRecord(node["image_with_metadata"]);
    if (image !== null) {
      const preview = asRecord(image["preview"]);
      const dimensions = asRecord(image["original_dimensions"]);
      attachments = [
        {
          type: "photo",
          id: firstText(image["legacy_attachment_id"], image["id"]) ?? "",
          filename: null,
          url: firstText(preview?.["uri"]),
          previewUrl: firstText(preview?.["uri"]),
          width: firstNumber(dimensions?.["x"], dimensions?.["width"]),
          height: firstNumber(dimensions?.["y"], dimensions?.["height"]),
          mimeType: null,
          size: null,
          durationMs: null,
          stickerId: null,
          extra: { raw: image },
        },
      ];
      systemData = {
        attachmentId: firstText(image["legacy_attachment_id"]),
        width: firstNumber(dimensions?.["x"], dimensions?.["width"]),
        height: firstNumber(dimensions?.["y"], dimensions?.["height"]),
        url: firstText(preview?.["uri"]),
      };
    } else if (typename === "ThreadNameMessage") {
      systemData = { name: firstText(node["thread_name"]) };
    } else if (typename === "ParticipantsAddedMessage") {
      const ids = asArray(node["participants_added"])
        .map((entry) => firstText(asRecord(entry)?.["id"]))
        .filter((entry): entry is string => entry !== null);
      systemData = { participantIds: ids };
    } else if (typename === "ParticipantLeftMessage") {
      const ids = asArray(node["participants_removed"])
        .map((entry) => firstText(asRecord(entry)?.["id"]))
        .filter((entry): entry is string => entry !== null);
      systemData = { participantIds: ids };
    } else if (typename === "GenericAdminTextMessage") {
      systemData = {
        adminType: firstText(node["extensible_message_admin_text_type"]),
        data: asRecord(node["extensible_message_admin_text"]) ?? {},
      };
    } else {
      systemData = { isVideo: typename === "VideoCallMessage" };
    }
  } else {
    const message = asRecord(node["message"]);
    body = firstText(message?.["text"]);
    mentions = mentionsFromRanges(message?.["text"], message?.["ranges"]);
    reactions = reactionsFromList(node["message_reactions"]);
    const sticker = asRecord(node["sticker"]);
    const blobs = asArray(node["blob_attachments"]);
    if (sticker !== null) {
      attachments = [stickerAttachment(sticker)];
    } else if (blobs.length > 0) {
      attachments = blobs.map((entry) => formatAttachment(entry));
    } else if (node["extensible_attachment"] !== undefined) {
      attachments = [formatAttachment(node)];
    }
  }

  return {
    id,
    threadId,
    senderId,
    body,
    attachments,
    mentions,
    reactions,
    timestamp,
    isRead: node["unread"] !== true,
    isSelf: senderId !== "" && senderId === selfUserId,
    kind: isSystem ? "system" : "message",
    systemType,
    systemData,
  };
}

/** Builds the cached `Message` view of a realtime message event. */
export function messageFromEvent(event: MessageEvent | MessageReplyEvent): Message {
  return {
    id: event.messageId,
    threadId: event.threadId,
    senderId: event.senderId,
    body: event.body,
    attachments: event.attachments,
    mentions: event.mentions,
    reactions: [],
    timestamp: event.timestamp,
    isRead: true,
    isSelf: event.isSelf,
    kind: "message",
    systemType: null,
    systemData: {},
  };
}

/** Converts a forced-fetch GraphQL node into a realtime message event. */
export function messageEventFromNode(
  raw: unknown,
  threadId: string,
  selfUserId: string,
  isGroup: boolean,
): MessageEvent | null {
  const message = normalizeMessageNode(raw, threadId, selfUserId);
  if (message === null || message.kind !== "message") {
    return null;
  }
  return {
    type: "message",
    timestamp: message.timestamp,
    messageId: message.id,
    threadId,
    senderId: message.senderId,
    isGroup,
    body: message.body,
    attachments: message.attachments,
    mentions: message.mentions,
    isSelf: message.isSelf,
  };
}

/** Presence status mapping shared with the delta parser. */
export function presenceStatus(value: unknown): PresenceStatus {
  const code = toNumber(value);
  switch (code) {
    case 2:
    case 3:
      return "online";
    case 1:
      return "idle";
    case 0:
      return "offline";
    default:
      return "unknown";
  }
}

/** Builds a presence snapshot for `getPresence`. */
export function presenceSnapshot(
  userId: string,
  status: PresenceStatus,
  lastActive: number | null,
  updatedAt: number,
): PresenceInfo {
  return { userId, status, lastActive, updatedAt };
}
