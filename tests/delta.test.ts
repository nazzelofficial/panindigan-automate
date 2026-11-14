import { describe, expect, it } from "vitest";
import { createRootLogger } from "../src/logger/index.js";
import {
  DeltaProcessor,
  formatAttachment,
  parseAdminText,
  parseClientPayload,
  parseDeliveryReceipt,
  parseMarkRead,
  parseMessageReply,
  parseNewMessage,
  parseParticipantLeft,
  parseParticipantsAdded,
  parseReadReceipt,
  parseReaction,
  parseThreadName,
  parseUnsend,
  type DeltaSink,
} from "../src/delta/index.js";
import type {
  AdminChangeEvent,
  CallEvent,
  DeliveredEvent,
  MessageEvent,
  MessageReplyEvent,
  MessageUnsendEvent,
  ParticipantJoinEvent,
  ParticipantLeaveEvent,
  PollEvent,
  PresenceEvent,
  ReadReceiptEvent,
  ReactionEvent,
  ThreadUpdateEvent,
  TypingEvent,
} from "../src/types/index.js";

const SELF = "100000000000001";
const OTHER = "100000000000002";
const GROUP = "200000000000003";
const ctx = { selfUserId: SELF, now: 1_700_000_000_000 };

const logger = createRootLogger({
  level: "silent",
  prettyPrint: false,
  logFile: null,
  transports: [],
});

const metadata = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  actorFbId: OTHER,
  threadKey: { otherUserFbId: OTHER },
  messageId: "mid.123",
  timestamp: 1_700_000_000_000,
  ...overrides,
});

describe("message deltas", () => {
  it("parses a direct message with prng mentions and a photo attachment", () => {
    const body = "hey @Nazzel look";
    const event = parseNewMessage(
      {
        class: "NewMessage",
        body,
        messageMetadata: metadata(),
        data: {
          prng: JSON.stringify([{ i: SELF, o: body.indexOf("@Nazzel"), l: 7 }]),
        },
        attachments: [
          {
            mercury: {
              attach_type: "photo",
              metadata: {
                fbid: "111",
                url: "https://cdn.example/photo.jpg",
                dimensions: "800,600",
              },
              preview_url: "https://cdn.example/preview.jpg",
            },
          },
        ],
      },
      ctx,
    );

    expect(event).not.toBeNull();
    expect(event?.type).toBe("message");
    expect(event?.threadId).toBe(OTHER);
    expect(event?.isGroup).toBe(false);
    expect(event?.isSelf).toBe(false);
    expect(event?.body).toBe(body);
    expect(event?.mentions).toEqual([{ id: SELF, tag: "@Nazzel", fromIndex: body.indexOf("@Nazzel") }]);
    expect(event?.attachments).toHaveLength(1);
    expect(event?.attachments[0]).toMatchObject({
      type: "photo",
      id: "111",
      url: "https://cdn.example/photo.jpg",
      previewUrl: "https://cdn.example/preview.jpg",
      width: 800,
      height: 600,
    });
  });

  it("parses group messages and marks own messages", () => {
    const event = parseNewMessage(
      {
        class: "NewMessage",
        body: "hi",
        messageMetadata: metadata({
          actorFbId: SELF,
          threadKey: { threadFbId: GROUP },
        }),
      },
      ctx,
    );
    expect(event?.isGroup).toBe(true);
    expect(event?.threadId).toBe(GROUP);
    expect(event?.isSelf).toBe(true);
  });

  it("normalizes mercuryJSON file attachments", () => {
    const event = parseNewMessage(
      {
        class: "NewMessage",
        body: "",
        messageMetadata: metadata(),
        attachments: [
          {
            mercuryJSON: JSON.stringify({
              attach_type: "file",
              name: "report.pdf",
              url: "https://cdn.example/report.pdf",
              mime_type: "application/pdf",
              file_size: 1234,
            }),
          },
        ],
      },
      ctx,
    );
    expect(event?.attachments[0]).toMatchObject({
      type: "file",
      filename: "report.pdf",
      url: "https://cdn.example/report.pdf",
      mimeType: "application/pdf",
      size: 1234,
    });
  });

  it("rejects a message missing its thread key", () => {
    expect(
      parseNewMessage(
        { class: "NewMessage", body: "x", messageMetadata: metadata({ threadKey: undefined }) },
        ctx,
      ),
    ).toBeNull();
  });

  it("parses replies with the replied-to id", () => {
    const event = parseMessageReply(
      {
        message: {
          body: "answer",
          messageMetadata: metadata({ messageId: "mid.reply" }),
        },
        repliedToMessage: {
          body: "question",
          messageMetadata: metadata({ messageId: "mid.original" }),
        },
      },
      ctx,
    );
    expect(event?.type).toBe("message_reply");
    expect((event as MessageReplyEvent).repliedToMessageId).toBe("mid.original");
  });

  it("falls back to a plain message when the reply target is absent", () => {
    const event = parseMessageReply(
      { message: { body: "answer", messageMetadata: metadata() } },
      ctx,
    );
    expect(event?.type).toBe("message");
  });
});

describe("client payload deltas", () => {
  // UTF-16 code units: every value above 255 marks this as the code-unit
  // encoding, so surrogate pairs survive intact.
  const encodeUtf16 = (payload: unknown): number[] =>
    JSON.stringify(payload)
      .split("")
      .map((character) => character.charCodeAt(0));

  // UTF-8 bytes: every value is 0-255, which is what Facebook sends for
  // payloads that contain multi-byte characters.
  const encodeUtf8 = (payload: unknown): number[] => Array.from(Buffer.from(JSON.stringify(payload), "utf8"));

  it("decodes a UTF-16 code-unit ClientPayload", () => {
    const events = parseClientPayload(
      {
        class: "ClientPayload",
        payload: encodeUtf16({
          deltas: [
            {
              deltaMessageReaction: {
                threadKey: { otherUserFbId: OTHER },
                messageId: "mid.123",
                reaction: "😍",
                userId: OTHER,
                action: 0,
              },
            },
          ],
        }),
      },
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "reaction", emoji: "😍", messageId: "mid.123", isSelf: false });
  });

  it("decodes a UTF-8 byte ClientPayload", () => {
    const events = parseClientPayload(
      {
        class: "ClientPayload",
        payload: encodeUtf8({
          deltas: [
            {
              deltaMessageReaction: {
                threadKey: { otherUserFbId: OTHER },
                messageId: "mid.456",
                reaction: "🔥",
                userId: OTHER,
                action: 0,
              },
            },
          ],
        }),
      },
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "reaction", emoji: "🔥", messageId: "mid.456" });
  });

  it("treats a non-zero reaction action as a removal", () => {
    const event = parseReaction(
      {
        threadKey: { threadFbId: GROUP },
        messageId: "mid.123",
        reaction: "😍",
        userId: SELF,
        action: 1,
      },
      ctx,
    );
    expect(event?.emoji).toBeNull();
    expect(event?.isSelf).toBe(true);
  });

  it("parses recalls", () => {
    const event = parseUnsend(
      {
        threadKey: { threadFbId: GROUP },
        messageID: "mid.123",
        senderID: OTHER,
        deletionTimestamp: 1_700_000_001_000,
      },
      ctx,
    );
    expect(event).toMatchObject({
      type: "message_unsend",
      timestamp: 1_700_000_001_000,
      messageId: "mid.123",
      senderId: OTHER,
    });
  });
});

describe("receipt deltas", () => {
  it("parses a read receipt", () => {
    const event = parseReadReceipt(
      {
        threadKey: { otherUserFbId: OTHER },
        actorFbId: OTHER,
        actionTimestampMs: 1_700_000_002_000,
      },
      ctx,
    );
    expect(event).toMatchObject({
      type: "read",
      threadId: OTHER,
      readerId: OTHER,
      watermark: 1_700_000_002_000,
      isSelf: false,
    });
  });

  it("expands MarkRead into one receipt per thread", () => {
    const events = parseMarkRead(
      {
        threadKeys: [{ threadFbId: GROUP }, { otherUserFbId: OTHER }, { threadFbId: GROUP }],
        actionTimestamp: 1_700_000_003_000,
      },
      ctx,
    );
    expect(events.map((event) => event.threadId)).toEqual([GROUP, OTHER]);
    expect(events.every((event) => event.readerId === SELF && event.isSelf)).toBe(true);
  });

  it("parses delivery receipts", () => {
    const event = parseDeliveryReceipt(
      {
        threadKey: { threadFbId: GROUP },
        messageIds: ["mid.1", "mid.2"],
        actorFbId: OTHER,
        deliveredWatermarkTimestampMs: 1_700_000_004_000,
      },
      ctx,
    );
    expect(event).toMatchObject({
      type: "delivered",
      threadId: GROUP,
      deliveredTo: OTHER,
      messageIds: ["mid.1", "mid.2"],
    });
  });
});

describe("thread deltas", () => {
  it("parses a thread name change", () => {
    const event = parseThreadName(
      {
        class: "ThreadName",
        name: "New name",
        messageMetadata: metadata({ threadKey: { threadFbId: GROUP } }),
      },
      ctx,
    );
    expect(event).toMatchObject({ type: "thread_update", action: "name", details: { name: "New name" } });
  });

  it("parses participant joins", () => {
    const event = parseParticipantsAdded(
      {
        class: "ParticipantsAddedToGroupThread",
        addedParticipants: [{ userFbId: OTHER }, { userFbId: "100000000000009" }],
        messageMetadata: metadata({ threadKey: { threadFbId: GROUP } }),
      },
      ctx,
    );
    expect(event).toMatchObject({
      type: "participant_join",
      addedIds: [OTHER, "100000000000009"],
      addedBy: OTHER,
    });
  });

  it("parses participant leaves", () => {
    const event = parseParticipantLeft(
      {
        class: "ParticipantLeftGroupThread",
        leftParticipantFbId: OTHER,
        messageMetadata: metadata({ threadKey: { threadFbId: GROUP } }),
      },
      ctx,
    );
    expect(event).toMatchObject({ type: "participant_leave", removedIds: [OTHER] });
  });
});

describe("admin text deltas", () => {
  const admin = (type: string, untypedData: Record<string, unknown>): Record<string, unknown> => ({
    class: "AdminTextMessage",
    type,
    untypedData,
    messageMetadata: metadata({ threadKey: { threadFbId: GROUP }, adminText: "text" }),
  });

  it("maps theme, icon, nickname and approval changes", () => {
    expect(parseAdminText(admin("change_thread_theme", { theme_color: "#ff0000" }), ctx)[0]).toMatchObject({
      type: "thread_update",
      action: "color",
      details: { color: "#ff0000" },
    });
    expect(parseAdminText(admin("change_thread_icon", { thread_icon: "🔥" }), ctx)[0]).toMatchObject({
      action: "emoji",
      details: { emoji: "🔥" },
    });
    expect(
      parseAdminText(admin("change_thread_nickname", { participant_id: OTHER, nickname: "Nick" }), ctx)[0],
    ).toMatchObject({ action: "nickname", details: { userId: OTHER, nickname: "Nick" } });
    expect(parseAdminText(admin("change_thread_approval_mode", { APPROVAL_MODE: "1" }), ctx)[0]).toMatchObject({
      action: "approval_queue",
      details: { requireAdminApproval: true },
    });
  });

  it("maps admin changes", () => {
    const added = parseAdminText(admin("change_thread_admins", { ADMIN_EVENT: "add_admin", TARGET_ID: OTHER }), ctx);
    expect(added[0]).toMatchObject({ type: "admin_change", userId: OTHER, promoted: true });
    const removed = parseAdminText(
      admin("change_thread_admins", { ADMIN_EVENT: "remove_admin", TARGET_ID: OTHER }),
      ctx,
    );
    expect(removed[0]).toMatchObject({ type: "admin_change", userId: OTHER, promoted: false });
  });

  it("parses a poll creation", () => {
    const events = parseAdminText(
      admin("group_poll", {
        event_type: "question_creation",
        question_json: JSON.stringify({
          id: "900",
          title: "Lunch?",
          options: [
            { id: "1", text: "Pizza", total_count: 2, viewers: [] },
            { id: "2", text: "Salad", total_count: 0 },
          ],
        }),
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    const poll = events[0] as PollEvent;
    expect(poll).toMatchObject({ type: "poll", pollId: "900", action: "created", question: "Lunch?" });
    expect(poll.options).toEqual([
      { id: "1", text: "Pizza", voters: [], voteCount: 2, viewerHasVoted: false },
      { id: "2", text: "Salad", voters: [], voteCount: 0, viewerHasVoted: false },
    ]);
  });

  it("parses call logs", () => {
    const events = parseAdminText(
      admin("messenger_call_log", { event: "group_call_started", call_id: "call-1", video_call: "1" }),
      ctx,
    );
    expect(events[0]).toMatchObject({
      type: "call",
      callId: "call-1",
      callerId: OTHER,
      action: "started",
      isVideo: true,
    } satisfies Partial<CallEvent>);
  });

  it("surfaces unknown admin types as an unknown thread update", () => {
    const events = parseAdminText(admin("some_new_admin_type", { a: 1 }), ctx);
    expect(events[0]).toMatchObject({ type: "thread_update", action: "unknown" });
  });
});

describe("attachment normalization", () => {
  it("normalizes a GraphQL MessageVideo blob", () => {
    const attachment = formatAttachment({
      mercury: {
        blob_attachment: {
          __typename: "MessageVideo",
          legacy_attachment_id: "vid-1",
          filename: "clip.mp4",
          playable_url: "https://cdn.example/clip.mp4",
          playable_duration_in_ms: 4200,
          original_dimensions: { x: 1920, y: 1080 },
          large_image: { uri: "https://cdn.example/thumb.jpg", width: 640, height: 360 },
        },
      },
    });
    expect(attachment).toMatchObject({
      type: "video",
      id: "vid-1",
      filename: "clip.mp4",
      url: "https://cdn.example/clip.mp4",
      width: 1920,
      height: 1080,
      durationMs: 4200,
    });
  });

  it("keeps unknown attachments representable", () => {
    const attachment = formatAttachment({ mercury: { attach_type: "hologram" } });
    expect(attachment.type).toBe("unknown");
    expect(attachment.extra).toBeTypeOf("object");
  });
});

describe("DeltaProcessor routing", () => {
  interface Recorded {
    readonly name: string;
    readonly payload: unknown;
  }

  function createSink(): { sink: DeltaSink; events: Recorded[] } {
    const events: Recorded[] = [];
    const record = (name: string) => (payload: unknown) => {
      events.push({ name, payload });
    };
    const sink: DeltaSink = {
      raw: (topic, payload) => events.push({ name: "raw", payload: { topic, payload } }),
      warning: (message, context) => events.push({ name: "warning", payload: { message, context } }),
      message: record("message") as (payload: MessageEvent) => void,
      message_reply: record("message_reply") as (payload: MessageReplyEvent) => void,
      message_unsend: record("message_unsend") as (payload: MessageUnsendEvent) => void,
      reaction: record("reaction") as (payload: ReactionEvent) => void,
      typing: record("typing") as (payload: TypingEvent) => void,
      presence: record("presence") as (payload: PresenceEvent) => void,
      read: record("read") as (payload: ReadReceiptEvent) => void,
      delivered: record("delivered") as (payload: DeliveredEvent) => void,
      participant_join: record("participant_join") as (payload: ParticipantJoinEvent) => void,
      participant_leave: record("participant_leave") as (payload: ParticipantLeaveEvent) => void,
      admin_change: record("admin_change") as (payload: AdminChangeEvent) => void,
      thread_update: record("thread_update") as (payload: ThreadUpdateEvent) => void,
      poll: record("poll") as (payload: PollEvent) => void,
      call: record("call") as (payload: CallEvent) => void,
    };
    return { sink, events };
  }

  it("emits raw before typed events and keeps order", async () => {
    const { sink, events } = createSink();
    const processor = new DeltaProcessor({ selfUserId: SELF, logger, sink, now: () => ctx.now });
    await processor.handleMessage("/t_ms", {
      deltas: [
        {
          class: "NewMessage",
          body: "one",
          messageMetadata: metadata(),
        },
        {
          class: "ThreadName",
          name: "n",
          messageMetadata: metadata({ threadKey: { threadFbId: GROUP } }),
        },
      ],
    });
    expect(events.map((event) => event.name)).toEqual(["raw", "message", "thread_update"]);
  });

  it("parses typing topics", async () => {
    const { sink, events } = createSink();
    const processor = new DeltaProcessor({ selfUserId: SELF, logger, sink, now: () => ctx.now });
    await processor.handleMessage("/thread_typing", { thread: GROUP, sender_fbid: OTHER, state: 1 });
    expect(events.at(-1)).toMatchObject({
      name: "typing",
      payload: { threadId: GROUP, userId: OTHER, isTyping: true },
    });
  });

  it("parses presence batches", async () => {
    const { sink, events } = createSink();
    const processor = new DeltaProcessor({ selfUserId: SELF, logger, sink, now: () => ctx.now });
    await processor.handleMessage("/orca_presence", {
      list: [
        { u: OTHER, p: 2, l: 1_700_000_000 },
        { u: "100000000000004", p: 0 },
      ],
    });
    const presence = events.filter((event) => event.name === "presence");
    expect(presence).toHaveLength(2);
    expect(presence[0]?.payload).toMatchObject({ userId: OTHER, status: "online", lastActive: 1_700_000_000_000 });
    expect(presence[1]?.payload).toMatchObject({ status: "offline", lastActive: null });
  });

  it("warns instead of throwing on malformed payloads", async () => {
    const { sink, events } = createSink();
    const processor = new DeltaProcessor({ selfUserId: SELF, logger, sink, now: () => ctx.now });
    await processor.handleMessage("/t_ms", [1, 2, 3]);
    expect(events.map((event) => event.name)).toEqual(["raw", "warning"]);
  });
});
