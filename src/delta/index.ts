/**
 * Delta processing.
 *
 * The transport hands over every decoded MQTT payload; this module owns the
 * mapping from wire topics and delta classes to the library's typed events.
 * Every payload is first re-emitted as a `raw` event, then validated and
 * dispatched. A payload that fails validation produces a `warning`, never a
 * thrown error, so one malformed delta cannot kill the listener.
 *
 * Messages are processed strictly in arrival order: the internal chain awaits
 * handlers such as forced fetches before accepting the next payload.
 */

import { z } from "zod";
import type { Logger } from "../logger/index.js";
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
  PresenceStatus,
  ReadReceiptEvent,
  ReactionEvent,
  ThreadUpdateEvent,
  TypingEvent,
} from "../types/index.js";
import {
  parseAdminText,
  parseClientPayload,
  parseDeliveryReceipt,
  parseForcedFetch,
  parseMarkRead,
  parseMessageReply,
  parseNewMessage,
  parseParticipantLeft,
  parseParticipantsAdded,
  parseReadReceipt,
  parseReaction,
  parseThreadFolder,
  parseThreadName,
  parseUnsend,
  type DeltaEvent,
  type ParserContext,
} from "./parsers.js";
import { asRecord, IdSchema, NumericStringSchema, toMillis, toNumber } from "./raw.js";

/** Receives typed events from the processor. */
export interface DeltaSink {
  /** Every payload, before parsing. */
  readonly raw: (topic: string, payload: unknown) => void;
  /** A non-fatal parse or routing issue. */
  readonly warning: (message: string, context: Readonly<Record<string, unknown>>) => void;
  readonly message: (payload: MessageEvent) => void;
  readonly message_reply: (payload: MessageReplyEvent) => void;
  readonly message_unsend: (payload: MessageUnsendEvent) => void;
  readonly reaction: (payload: ReactionEvent) => void;
  readonly typing: (payload: TypingEvent) => void;
  readonly presence: (payload: PresenceEvent) => void;
  readonly read: (payload: ReadReceiptEvent) => void;
  readonly delivered: (payload: DeliveredEvent) => void;
  readonly participant_join: (payload: ParticipantJoinEvent) => void;
  readonly participant_leave: (payload: ParticipantLeaveEvent) => void;
  readonly admin_change: (payload: AdminChangeEvent) => void;
  readonly thread_update: (payload: ThreadUpdateEvent) => void;
  readonly poll: (payload: PollEvent) => void;
  readonly call: (payload: CallEvent) => void;
}

/** Fetches the full payload behind a `ForcedFetch` delta. */
export type ForcedFetchHandler = (
  threadId: string,
  messageId: string,
) => Promise<MessageEvent | ThreadUpdateEvent | null>;

export interface DeltaProcessorDeps {
  /** Facebook id of the authenticated account. */
  readonly selfUserId: string;
  readonly logger: Logger;
  readonly sink: DeltaSink;
  /** Resolves `ForcedFetch` deltas (thread photo changes, pending groups). */
  readonly forcedFetch?: ForcedFetchHandler | undefined;
  /** Clock override for deterministic tests. */
  readonly now?: (() => number) | undefined;
}

/** MQTT topics consumed by the processor. */
const TOPIC_DELTA = "/t_ms";
const TOPIC_THREAD_TYPING = "/thread_typing";
const TOPIC_ORCA_TYPING = "/orca_typing_notifications";
const TOPIC_PRESENCE = "/orca_presence";

const TmsEnvelopeSchema = z
  .object({
    deltas: z.array(z.unknown()).optional(),
  })
  .passthrough();

const TypingSchema = z
  .object({
    sender_fbid: IdSchema,
    state: z.union([z.number(), z.string(), z.boolean()]).optional(),
    thread: IdSchema.optional(),
    thread_fbid: IdSchema.optional(),
  })
  .passthrough();

const PresenceEnvelopeSchema = z
  .object({
    list: z
      .array(
        z
          .object({
            u: IdSchema,
            p: NumericStringSchema.optional(),
            l: NumericStringSchema.optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/**
 * Maps an `/orca_presence` status code.
 *
 * `2` and `3` mean active (3 additionally marks an active web session), `1`
 * is idle, and `0` is offline. Anything else is reported as unknown rather
 * than guessed.
 */
function presenceStatus(value: unknown): PresenceStatus {
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

/** Processes decoded MQTT payloads into typed events. */
export class DeltaProcessor {
  readonly #deps: DeltaProcessorDeps;
  readonly #logger: Logger;
  #chain: Promise<void> = Promise.resolve();

  constructor(deps: DeltaProcessorDeps) {
    this.#deps = deps;
    this.#logger = deps.logger.child({ module: "delta" });
  }

  /**
   * Processes one payload. Returns a promise that settles after every event
   * derived from it has been handed to the sink; concurrent calls are
   * serialized in arrival order.
   */
  handleMessage(topic: string, payload: unknown): Promise<void> {
    const run = (): Promise<void> => this.#process(topic, payload);
    this.#chain = this.#chain.then(run, run);
    return this.#chain;
  }

  async #process(topic: string, payload: unknown): Promise<void> {
    this.#deps.sink.raw(topic, payload);
    try {
      switch (topic) {
        case TOPIC_DELTA:
          await this.#handleTms(payload);
          return;
        case TOPIC_THREAD_TYPING:
        case TOPIC_ORCA_TYPING:
          this.#handleTyping(payload);
          return;
        case TOPIC_PRESENCE:
          this.#handlePresence(payload);
          return;
        default:
          // Other topics are call signalling, telemetry, or lightweight-service
          // responses; the raw event above is the public surface for them.
          this.#logger.debug({ topic }, "MQTT payload has no typed projection");
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.error({ topic, err: message }, "delta processing failed");
      this.#deps.sink.warning(`failed to process an MQTT payload on "${topic}"`, { topic, err: message });
    }
  }

  async #handleTms(payload: unknown): Promise<void> {
    const parsed = TmsEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      this.#deps.sink.warning("dropped a /t_ms payload that is not a sync envelope", {
        reason: parsed.error.message,
      });
      return;
    }
    for (const delta of parsed.data.deltas ?? []) {
      await this.#handleDelta(delta);
    }
  }

  async #handleDelta(raw: unknown): Promise<void> {
    const record = asRecord(raw);
    const deltaClass = record === null ? null : record.class;
    if (typeof deltaClass !== "string") {
      this.#deps.sink.warning("dropped a delta without a class", {});
      return;
    }

    switch (deltaClass) {
      case "NewMessage": {
        const event = parseNewMessage(raw, this.#context());
        if (event === null) {
          this.#warnParse(deltaClass);
          return;
        }
        this.#deps.sink.message(event);
        return;
      }
      case "ClientPayload": {
        for (const event of parseClientPayload(raw, this.#context())) {
          this.#emit(event);
        }
        return;
      }
      case "ReadReceipt": {
        const event = parseReadReceipt(raw, this.#context());
        if (event === null) {
          this.#warnParse(deltaClass);
          return;
        }
        this.#deps.sink.read(event);
        return;
      }
      case "MarkRead": {
        for (const event of parseMarkRead(raw, this.#context())) {
          this.#deps.sink.read(event);
        }
        return;
      }
      case "DeliveryReceipt": {
        const event = parseDeliveryReceipt(raw, this.#context());
        if (event === null) {
          this.#warnParse(deltaClass);
          return;
        }
        this.#deps.sink.delivered(event);
        return;
      }
      case "AdminTextMessage": {
        for (const event of parseAdminText(raw, this.#context())) {
          this.#emit(event);
        }
        return;
      }
      case "ThreadName": {
        const event = parseThreadName(raw, this.#context());
        if (event === null) {
          this.#warnParse(deltaClass);
          return;
        }
        this.#deps.sink.thread_update(event);
        return;
      }
      case "ParticipantsAddedToGroupThread": {
        const event = parseParticipantsAdded(raw, this.#context());
        if (event === null) {
          this.#warnParse(deltaClass);
          return;
        }
        this.#deps.sink.participant_join(event);
        return;
      }
      case "ParticipantLeftGroupThread": {
        const event = parseParticipantLeft(raw, this.#context());
        if (event === null) {
          this.#warnParse(deltaClass);
          return;
        }
        this.#deps.sink.participant_leave(event);
        return;
      }
      case "ForcedFetch": {
        await this.#handleForcedFetch(raw);
        return;
      }
      case "ThreadFolder": {
        const event = parseThreadFolder(raw, this.#context());
        if (event === null) {
          this.#warnParse(deltaClass);
          return;
        }
        this.#deps.sink.thread_update(event);
        return;
      }
      case "NoOp":
      case "MarkFolderSeen":
        return;
      default:
        this.#logger.debug({ deltaClass }, "unhandled delta class");
        return;
    }
  }

  async #handleForcedFetch(raw: unknown): Promise<void> {
    const target = parseForcedFetch(raw);
    if (target === null) {
      this.#warnParse("ForcedFetch");
      return;
    }
    const handler = this.#deps.forcedFetch;
    if (handler === undefined) {
      this.#logger.debug({ threadId: target.threadId }, "ForcedFetch delta without a fetch handler");
      return;
    }
    try {
      const event = await handler(target.threadId, target.messageId);
      if (event === null) {
        return;
      }
      if (event.type === "message") {
        this.#deps.sink.message(event);
      } else {
        this.#deps.sink.thread_update(event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn({ err: message }, "forced fetch failed");
      this.#deps.sink.warning("failed to fetch the payload behind a ForcedFetch delta", {
        threadId: target.threadId,
        messageId: target.messageId,
        err: message,
      });
    }
  }

  #handleTyping(payload: unknown): void {
    const parsed = TypingSchema.safeParse(payload);
    if (!parsed.success) {
      this.#warnParse("Typing");
      return;
    }
    const data = parsed.data;
    const threadId = data.thread ?? data.thread_fbid ?? data.sender_fbid;
    const rawState = data.state;
    const isTyping = rawState === true || rawState === 1 || rawState === "1" || rawState === "true";
    this.#deps.sink.typing({
      type: "typing",
      timestamp: this.#now(),
      threadId,
      userId: data.sender_fbid,
      isTyping,
    });
  }

  #handlePresence(payload: unknown): void {
    const parsed = PresenceEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      this.#warnParse("Presence");
      return;
    }
    const timestamp = this.#now();
    for (const entry of parsed.data.list ?? []) {
      this.#deps.sink.presence({
        type: "presence",
        timestamp,
        userId: entry.u,
        status: presenceStatus(entry.p),
        lastActive: toMillis(entry.l),
      });
    }
  }

  /** Dispatches a parser result by its discriminant. */
  #emit(event: DeltaEvent): void {
    switch (event.type) {
      case "message":
        this.#deps.sink.message(event);
        return;
      case "message_reply":
        this.#deps.sink.message_reply(event);
        return;
      case "message_unsend":
        this.#deps.sink.message_unsend(event);
        return;
      case "reaction":
        this.#deps.sink.reaction(event);
        return;
      case "read":
        this.#deps.sink.read(event);
        return;
      case "delivered":
        this.#deps.sink.delivered(event);
        return;
      case "participant_join":
        this.#deps.sink.participant_join(event);
        return;
      case "participant_leave":
        this.#deps.sink.participant_leave(event);
        return;
      case "admin_change":
        this.#deps.sink.admin_change(event);
        return;
      case "thread_update":
        this.#deps.sink.thread_update(event);
        return;
      case "poll":
        this.#deps.sink.poll(event);
        return;
      case "call":
        this.#deps.sink.call(event);
        return;
    }
  }

  #warnParse(kind: string): void {
    this.#logger.debug({ kind }, "delta payload did not match its expected shape");
    this.#deps.sink.warning(`dropped a ${kind} delta that did not match its expected shape`, { kind });
  }

  #context(): ParserContext {
    return { selfUserId: this.#deps.selfUserId, now: this.#now() };
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}

export {
  parseAdminText,
  parseClientPayload,
  parseDeliveryReceipt,
  parseForcedFetch,
  parseMarkRead,
  parseMessagePayload,
  parseMessageReply,
  parseNewMessage,
  parseParticipantLeft,
  parseParticipantsAdded,
  parseReadReceipt,
  parseReaction,
  parseThreadFolder,
  parseThreadName,
  parseUnsend,
  parseViewerStatus,
} from "./parsers.js";
export type { DeltaEvent, ParserContext } from "./parsers.js";
export { extractMentions } from "./mentions.js";
export { formatAttachment, formatAttachments } from "./attachments.js";
