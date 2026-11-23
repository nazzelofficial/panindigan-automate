import { describe, expect, it } from "vitest";
import { MessengerClient } from "../src/client/index.js";
import { extractUserIdFromUrl, extractUserIdFromHtml } from "../src/index.js";
import {
  messageEventFromNode,
  messageFromEvent,
  normalizeColor,
  normalizeLegacyThread,
  normalizeMessageNode,
  normalizePoll,
  normalizePollOptions,
  normalizeSearchUser,
  normalizeThread,
} from "../src/client/models.js";
import { parseGraphQLBatch } from "../src/client/graphql.js";
import { buildLogMessageForm, buildMessageForm } from "../src/client/forms.js";
import { firstMetadataEntry, metadataToMediaInfo } from "../src/client/media.js";
import {
  parseMessageContent,
  parsePollOptions,
  parseThreadId,
  parseUserIds,
  resolveReactionEmoji,
} from "../src/client/validation.js";
import { CookieError, ValidationError } from "../src/errors/index.js";
import type { MessageEvent } from "../src/types/index.js";

describe("MessengerClient construction", () => {
  it("starts uninitialized and disconnected", () => {
    const client = new MessengerClient({
      storageAdapter: "memory",
      persistSession: false,
      logLevel: "silent",
    });

    const session = client.getSession();
    expect(session.state).toBe("UNINITIALIZED");
    expect(session.userId).toBe("");
    expect(session.connected).toBe(false);
    expect(client.isConnected()).toBe(false);
  });

  it("exposes a diagnostics handle", () => {
    const client = new MessengerClient({ storageAdapter: "memory", logLevel: "silent" });
    const snapshot = client.diagnostics.getSnapshot();
    expect(snapshot).toHaveProperty("http");
    expect(snapshot).toHaveProperty("mqtt");
    expect(snapshot).toHaveProperty("cache");
    expect(snapshot).toHaveProperty("events");
    expect(snapshot).toHaveProperty("process");
  });

  it("accepts middleware registrations", () => {
    const client = new MessengerClient({ storageAdapter: "memory", logLevel: "silent" });
    expect(() =>
      client.use("before", async (_context, next) => {
        await next();
      }),
    ).not.toThrow();
  });

  it("registers, counts and removes event listeners", () => {
    const client = new MessengerClient({ storageAdapter: "memory", logLevel: "silent" });
    const listener = (): void => undefined;

    const unsubscribe = client.on("warning", listener);
    expect(client.listenerCount("warning")).toBe(1);

    client.off("warning", listener);
    expect(client.listenerCount("warning")).toBe(0);

    client.on("warning", listener);
    client.removeAll("warning");
    expect(client.listenerCount("warning")).toBe(0);

    unsubscribe();
    expect(client.listenerCount("warning")).toBe(0);
  });

  it("rejects credentials without the required cookies before any network call", async () => {
    const client = new MessengerClient({ storageAdapter: "memory", persistSession: false, logLevel: "silent" });
    await expect(client.login({})).rejects.toBeInstanceOf(CookieError);
  });
});

describe("modern convenience API", () => {
  it("exposes all the new aliases as functions without login", () => {
    const client = new MessengerClient({ storageAdapter: "memory", persistSession: false, logLevel: "silent" });
    for (const method of [
      "getCurrentUserId", "setMessageReaction", "setTitle", "changeThreadEmoji",
      "changeThreadColor", "changeArchivedStatus", "sendTypingIndicator",
      "getThreadHistory", "getFriendsList", "searchForThread", "deleteMessage",
      "uploadAttachment", "resolvePhotoUrl", "forwardAttachment",
      "markAsReadAll", "markAsUnread", "getAppState",
    ] as const) {
      expect(typeof (client as any)[method]).toBe("function");
    }
  });

  it("keeps invite-link APIs honestly unimplemented", async () => {
    const client = new MessengerClient({ storageAdapter: "memory", persistSession: false, logLevel: "silent" });
    await expect(client.createInviteLink("123")).rejects.toThrow();
    await expect(client.joinGroupByLink("x")).rejects.toThrow();
  });
});

describe("profile URL resolution", () => {
  it("extracts an id from profile.php?id= and /users/ URLs", () => {
    expect(extractUserIdFromUrl("https://www.facebook.com/profile.php?id=123456789")).toBe("123456789");
    expect(extractUserIdFromUrl("https://www.facebook.com/users/987654321")).toBe("987654321");
    expect(extractUserIdFromUrl("https://www.facebook.com/5555555555")).toBe("5555555555");
  });

  it("does not mistake an opaque share code for a user id", () => {
    expect(extractUserIdFromUrl("https://www.facebook.com/share/19wEoLmtBB/")).toBeNull();
  });

  it("extracts a target profile id and never the viewer's own id", () => {
    // A share page contains the VIEWER id (the bot) and the target profile id.
    // Returning the viewer id made add-member add the bot to the group.
    const body = '{"user_id":"61596880191204","profile_id":"123456789012345","name":"James"}';
    expect(extractUserIdFromHtml(body, "61596880191204")).toBe("123456789012345");
    // Without a viewer id it still prefers profile-target fields.
    expect(extractUserIdFromHtml(body)).toBe("123456789012345");
  });

  it("extracts an id from real profile-page fields (userID, entity_id, fb://)", () => {
    expect(extractUserIdFromHtml('{"userID":"123456789012345"}')).toBe("123456789012345");
    expect(extractUserIdFromHtml('{"entity_id":123456789012345}')).toBe("123456789012345");
    expect(extractUserIdFromHtml('<a href="fb://profile/123456789012345">')).toBe("123456789012345");
    // The viewer id is still excluded even when it appears in userID.
    expect(extractUserIdFromHtml('{"userID":"61596880191204","profile_id":"123456789012345"}', "61596880191204"))
      .toBe("123456789012345");
  });

  it("returns null rather than the bot's own id when that is the only id present", () => {
    const body = '{"user_id":"61596880191204","name":"Viewer"}';
    expect(extractUserIdFromHtml(body, "61596880191204")).toBeNull();
  });
});

describe("thread normalization", () => {
  it("normalizes a GraphQL thread node", () => {
    const info = normalizeThread({
      thread_key: { thread_fbid: "123" },
      thread_type: "GROUP",
      name: "Test group",
      unread_count: 2,
      updated_time_precise: "1700000000000",
      all_participants: {
        edges: [{ node: { messaging_actor: { id: "1", name: "Ada", __typename: "User" } } }],
      },
      customization_info: {
        emoji: "😀",
        outgoing_bubble_color: "FF8C0077",
        participant_customizations: [{ participant_id: "1", nickname: "Ace" }],
      },
      last_message: { timestamp_precise: "1699999999999", nodes: [{ snippet: "hi" }] },
      last_read_receipt: { nodes: [{ timestamp_precise: "1699999999000" }] },
      image: { uri: "https://example.com/photo.png" },
      mute_until: 0,
      cannot_reply_reason: null,
      has_viewer_archived: false,
    });

    expect(info).not.toBeNull();
    expect(info?.id).toBe("123");
    expect(info?.isGroup).toBe(true);
    expect(info?.name).toBe("Test group");
    expect(info?.unreadCount).toBe(2);
    expect(info?.color).toBe("8C0077");
    expect(info?.emoji).toBe("😀");
    expect(info?.participants[0]).toEqual({ id: "1", name: "Ada", accountType: "user" });
    expect(info?.participantIds).toEqual(["1"]);
    expect(info?.nicknames).toEqual({ "1": "Ace" });
    expect(info?.lastMessageTimestamp).toBe(1699999999999);
    expect(info?.lastReadTimestamp).toBe(1699999999000);
    expect(info?.photoUrl).toBe("https://example.com/photo.png");
    expect(info?.muteUntil).toBe(0);
    expect(info?.canReply).toBe(true);
    expect(info?.snippet).toBe("hi");
    expect(info?.updatedAt).toBe(1700000000000);
    expect(info?.adminIDs).toEqual([]);
  });

  it("extracts group admin IDs from a top-level admin_ids list", () => {
    const info = normalizeThread({
      thread_key: { thread_fbid: "123" },
      thread_type: "GROUP",
      all_participants: {
        edges: [
          { node: { messaging_actor: { id: "1", name: "Ada", __typename: "User" } } },
          { node: { messaging_actor: { id: "2", name: "Bob", __typename: "User" } } },
        ],
      },
      admin_ids: [{ id: "1" }, { id: "2" }],
    });
    expect(info?.adminIDs).toEqual(["1", "2"]);
  });

  it("extracts admin IDs from participant is_admin markers", () => {
    const info = normalizeThread({
      thread_key: { thread_fbid: "123" },
      thread_type: "GROUP",
      all_participants: {
        edges: [
          { node: { messaging_actor: { id: "1", name: "Ada" }, is_admin: true } },
          { node: { messaging_actor: { id: "2", name: "Bob" } } },
        ],
      },
    });
    expect(info?.adminIDs).toEqual(["1"]);
  });

  it("extracts admins from a thread_admins connection", () => {
    const info = normalizeThread({
      thread_key: { thread_fbid: "123" },
      thread_type: "GROUP",
      thread_admins: {
        edges: [
          { node: { id: "10", __typename: "User" } },
          { node: { id: "11", __typename: "User" } },
        ],
      },
      all_participants: { edges: [] },
    });
    expect(info?.adminIDs).toEqual(["10", "11"]);
  });

  it("normalizes a legacy search thread", () => {
    const info = normalizeLegacyThread({
      thread_fbid: "99",
      name: "Legacy",
      participants: ["1", "2"],
      custom_nickname: { "1": "Ace" },
      custom_color: "FF0084FF",
      custom_like_icon: "👍",
      snippet: "hello",
      timestamp: "1700000000000",
      thread_type: "GROUP",
      unread_count: 3,
    });

    expect(info?.id).toBe("99");
    expect(info?.isGroup).toBe(true);
    expect(info?.color).toBe("0084FF");
    expect(info?.participantIds).toEqual(["1", "2"]);
    expect(info?.nicknames).toEqual({ "1": "Ace" });
    expect(info?.updatedAt).toBe(1700000000000);
  });

  it("strips the alpha byte from colors only when present", () => {
    expect(normalizeColor("FF8C0077")).toBe("8C0077");
    expect(normalizeColor("0084FF")).toBe("0084FF");
    expect(normalizeColor(null)).toBeNull();
  });
});

describe("message normalization", () => {
  const userNode = {
    __typename: "UserMessage",
    message_id: "m1",
    message_sender: { id: "u1", messaging_actor: { id: "u1" } },
    message: {
      text: "hello @Ada",
      ranges: [{ entity: { id: "2" }, offset: 6, length: 4 }],
    },
    blob_attachments: [
      {
        __typename: "MessageImage",
        legacy_attachment_id: "att1",
        filename: "a.png",
        preview: { uri: "https://example.com/preview" },
        large_preview: { uri: "https://example.com/large", width: 10, height: 20 },
        original_dimensions: { x: 10, y: 20 },
      },
    ],
    message_reactions: [{ user: { id: "2" }, reaction: "👍" }],
    timestamp_precise: "1700000000000",
    unread: false,
  };

  it("normalizes a user message", () => {
    const message = normalizeMessageNode(userNode, "t1", "me");
    expect(message).not.toBeNull();
    expect(message?.id).toBe("m1");
    expect(message?.threadId).toBe("t1");
    expect(message?.senderId).toBe("u1");
    expect(message?.body).toBe("hello @Ada");
    expect(message?.mentions).toEqual([{ id: "2", tag: "@Ada", fromIndex: 6 }]);
    expect(message?.attachments[0]?.type).toBe("photo");
    expect(message?.attachments[0]?.id).toBe("att1");
    expect(message?.reactions).toEqual([{ userId: "2", emoji: "👍" }]);
    expect(message?.timestamp).toBe(1700000000000);
    expect(message?.isRead).toBe(true);
    expect(message?.isSelf).toBe(false);
    expect(message?.kind).toBe("message");
  });

  it("normalizes thread-log entries", () => {
    const message = normalizeMessageNode(
      {
        __typename: "ThreadNameMessage",
        message_id: "m2",
        message_sender: { id: "u1" },
        thread_name: "New name",
        snippet: "renamed the conversation",
        timestamp_precise: "1700000000001",
      },
      "t1",
      "me",
    );

    expect(message?.kind).toBe("system");
    expect(message?.systemType).toBe("ThreadNameMessage");
    expect(message?.systemData).toEqual({ name: "New name" });
    expect(message?.body).toBe("renamed the conversation");
  });

  it("normalizes a sticker message", () => {
    const message = normalizeMessageNode(
      {
        __typename: "UserMessage",
        message_id: "m3",
        message_sender: { id: "u1" },
        message: { text: null },
        sticker: { id: "s1", url: "https://example.com/s.png", width: 100, height: 100 },
        timestamp_precise: "1700000000002",
      },
      "t1",
      "u1",
    );

    expect(message?.attachments[0]?.type).toBe("sticker");
    expect(message?.attachments[0]?.stickerId).toBe("s1");
    expect(message?.isSelf).toBe(true);
  });

  it("builds a cacheable message from an event", () => {
    const event: MessageEvent = {
      type: "message",
      timestamp: 1700000000000,
      messageId: "m1",
      threadId: "t1",
      senderId: "u1",
      isGroup: true,
      body: "hi",
      attachments: [],
      mentions: [],
      isSelf: false,
    };
    const message = messageFromEvent(event);
    expect(message.id).toBe("m1");
    expect(message.kind).toBe("message");
    expect(message.isRead).toBe(true);
  });

  it("carries the group flag into forced-fetch events", () => {
    const event = messageEventFromNode(userNode, "g1", "me", true);
    expect(event?.isGroup).toBe(true);
    expect(event?.threadId).toBe("g1");
    expect(event?.messageId).toBe("m1");
  });

  it("does not turn system entries into message events", () => {
    const event = messageEventFromNode(
      {
        __typename: "ThreadNameMessage",
        message_id: "m2",
        message_sender: { id: "u1" },
        thread_name: "New",
        timestamp_precise: "1700000000000",
      },
      "g1",
      "me",
      true,
    );
    expect(event).toBeNull();
  });
});

describe("poll normalization", () => {
  it("normalizes options with connection-shaped and plain voters", () => {
    const options = normalizePollOptions([
      {
        id: "1",
        text: "Yes",
        voters: { edges: [{ node: { id: "u1" } }, { node: { id: "u2" } }] },
        total_count: 2,
        viewer_has_voted: "true",
      },
      { id: "2", text: "No", voters: ["u3"], viewer_has_voted: false },
    ]);

    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
      id: "1",
      text: "Yes",
      voters: ["u1", "u2"],
      voteCount: 2,
      viewerHasVoted: true,
    });
    expect(options[1]).toMatchObject({
      id: "2",
      text: "No",
      voters: ["u3"],
      voteCount: 1,
      viewerHasVoted: false,
    });
  });

  it("uses the cached question when Facebook omits it, else an empty string", () => {
    const cached = normalizePoll("p1", [{ id: "1", text: "Yes", voters: [], voteCount: 0, viewerHasVoted: false }], "Do you agree?");
    expect(cached.question).toBe("Do you agree?");

    const uncached = normalizePoll("p2", [{ id: "1", text: "Yes", voters: [], voteCount: 0, viewerHasVoted: false }], null);
    expect(uncached.question).toBe("");
  });
});

describe("search normalization", () => {
  it("normalizes a typeahead user hit", () => {
    const result = normalizeSearchUser({
      uid: "1",
      text: "Ada",
      photo: "https://example.com/a.png",
      path: "/ada",
      is_verified: true,
      category: "friend",
    });

    expect(result).toEqual({
      id: "1",
      name: "Ada",
      photoUrl: "https://example.com/a.png",
      profileUrl: "/ada",
      isVerified: true,
      category: "friend",
    });
  });
});

describe("GraphQL batch parsing", () => {
  it("extracts the o0 data payload and the summary", () => {
    const batch = parseGraphQLBatch([
      { o0: { data: { viewer: { message_threads: { nodes: [{ id: "1" }] } } } } },
      { error_results: 0, successful_results: 1 },
    ]);

    expect(batch.data).toEqual({ viewer: { message_threads: { nodes: [{ id: "1" }] } } });
    expect(batch.summary).toEqual({ error_results: 0, successful_results: 1 });
    expect(batch.entries).toHaveLength(2);
  });

  it("wraps a single document", () => {
    const batch = parseGraphQLBatch({ o0: { data: { message_thread: { id: "1" } } } });
    expect(batch.data).toEqual({ message_thread: { id: "1" } });
    expect(batch.entries).toHaveLength(1);
  });
});

describe("message form builders", () => {
  it("targets group threads with thread_fbid", () => {
    const form = buildMessageForm({
      userId: "me",
      clientId: "client",
      threadId: "group-1",
      isGroup: true,
      offlineThreadingId: "otid",
    });

    expect(form["thread_fbid"]).toBe("group-1");
    expect(form["specific_to_list[0]"]).toBeUndefined();
    expect(form["other_user_fbid"]).toBeUndefined();
    expect(form["action_type"]).toBe("ma-type:user-generated-message");
    expect(form["author"]).toBe("fbid:me");
    expect(form["offline_threading_id"]).toBe("otid");
    expect(form["message_id"]).toBe("otid");
    expect(form["threading_id"]).toContain("@mail.projektitan.com");
  });

  it("targets direct threads with the specific_to_list triple", () => {
    const form = buildMessageForm({
      userId: "me",
      clientId: "client",
      threadId: "user-1",
      isGroup: false,
      offlineThreadingId: "otid",
    });

    expect(form["specific_to_list[0]"]).toBe("fbid:user-1");
    expect(form["specific_to_list[1]"]).toBe("fbid:me");
    expect(form["other_user_fbid"]).toBe("user-1");
    expect(form["thread_fbid"]).toBeUndefined();
  });

  it("adds replied_to_message_id only for replies", () => {
    const reply = buildMessageForm({
      userId: "me",
      clientId: "client",
      threadId: "group-1",
      isGroup: true,
      offlineThreadingId: "otid",
      replyToMessageId: "m1",
    });
    expect(reply["replied_to_message_id"]).toBe("m1");

    const plain = buildMessageForm({
      userId: "me",
      clientId: "client",
      threadId: "group-1",
      isGroup: true,
      offlineThreadingId: "otid",
    });
    expect(plain["replied_to_message_id"]).toBeUndefined();
  });

  it("builds group log-message forms", () => {
    const form = buildLogMessageForm({
      userId: "me",
      clientId: "client",
      threadId: "group-1",
      logMessageType: "log:subscribe",
      extra: { "log_message_data[added_participants][0]": "fbid:user-2" },
      threadIdField: "",
    });

    expect(form["thread_fbid"]).toBe("group-1");
    expect(form["thread_id"]).toBe("");
    expect(form["action_type"]).toBe("ma-type:log-message");
    expect(form["log_message_type"]).toBe("log:subscribe");
    expect(form["log_message_data[added_participants][0]"]).toBe("fbid:user-2");
  });
});

describe("media metadata", () => {
  it("picks the numerically first metadata entry", () => {
    const first = firstMetadataEntry({
      "2": { file_id: "b" },
      "1": { image_id: "a" },
    });
    expect(first).toEqual({ image_id: "a" });
  });

  it("maps metadata ids to a media kind", () => {
    const info = metadataToMediaInfo(
      { image_id: "9", mime_type: "image/png", file_size: 5 },
      "a.png",
      null,
      5,
    );
    expect(info).toEqual({
      attachmentId: "9",
      filename: "a.png",
      mimeType: "image/png",
      size: 5,
      kind: "image",
    });
  });

  it("falls back to the content size", () => {
    const info = metadataToMediaInfo({ file_id: "10" }, "a.bin", null, 12);
    expect(info?.kind).toBe("file");
    expect(info?.size).toBe(12);
  });
});

describe("input validation", () => {
  it("rejects empty ids", () => {
    expect(() => parseThreadId("")).toThrow(ValidationError);
  });

  it("rejects unknown content types", () => {
    expect(() => parseMessageContent({ type: "unknown" })).toThrow(ValidationError);
  });

  it("rejects polls with fewer than two options", () => {
    expect(() => parsePollOptions(["only"])).toThrow(ValidationError);
  });

  it("rejects group creation with fewer than two participants", () => {
    expect(() => parseUserIds(["1"])).toThrow(ValidationError);
  });

  it("maps reaction shortcuts and passes emojis through", () => {
    expect(resolveReactionEmoji("love")).toBe("😍");
    expect(resolveReactionEmoji("like")).toBe("👍");
    expect(resolveReactionEmoji("🚀")).toBe("🚀");
  });
});
