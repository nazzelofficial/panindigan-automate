/**
 * Form builders for Facebook's Mercury endpoints.
 *
 * The send and log-message forms are shared by messaging and every group
 * mutation, so they live here as pure functions: the client supplies the
 * session values and the builder produces the exact field set Facebook's
 * `/messaging/send/` family expects. Keeping them pure makes the group-versus-
 * 1:1 targeting rules directly testable.
 */

import type { FormValue } from "../transport/http/index.js";
import { generateOfflineThreadingId, generateThreadingId } from "../utils/index.js";

/** Options for a user-generated message form. */
export interface MessageFormOptions {
  readonly userId: string;
  readonly clientId: string;
  readonly threadId: string;
  readonly isGroup: boolean;
  readonly offlineThreadingId: string;
  readonly replyToMessageId?: string | undefined;
}

/** Options for a log-message form (thread name, image, membership, …). */
export interface LogMessageFormOptions {
  readonly userId: string;
  readonly clientId: string;
  readonly threadId: string;
  readonly logMessageType: string;
  readonly extra?: Readonly<Record<string, FormValue>> | undefined;
  /** Value for `thread_id`; pass `""` to match the add-participant request. */
  readonly threadIdField?: string | undefined;
}

function relativeTime(): string {
  const now = new Date();
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function randomSignatureId(): string {
  return (Math.floor(Math.random() * 2_147_483_648) >>> 0).toString(16);
}

/**
 * Builds the `/messaging/send/` form for a user-generated message.
 *
 * Group threads are addressed with `thread_fbid`; direct threads use the
 * `specific_to_list`/`other_user_fbid` triple, matching the web client.
 */
export function buildMessageForm(options: MessageFormOptions): Record<string, FormValue> {
  const { userId, clientId, threadId, isGroup, offlineThreadingId } = options;
  const form: Record<string, FormValue> = {
    client: "mercury",
    action_type: "ma-type:user-generated-message",
    author: `fbid:${userId}`,
    timestamp: Date.now(),
    timestamp_absolute: "Today",
    timestamp_relative: relativeTime(),
    timestamp_time_passed: "0",
    is_unread: false,
    is_cleared: false,
    is_forward: false,
    is_filtered_content: false,
    is_filtered_content_bh: false,
    is_filtered_content_account: false,
    is_filtered_content_quasar: false,
    is_filtered_content_invalid_app: false,
    is_spoof_warning: false,
    source: "source:chat:web",
    "source_tags[0]": "source:chat",
    html_body: false,
    ui_push_phase: "V3",
    status: "0",
    offline_threading_id: offlineThreadingId,
    message_id: offlineThreadingId,
    threading_id: generateThreadingId(clientId),
    "ephemeral_ttl_mode:": "0",
    manual_retry_cnt: "0",
    signatureID: randomSignatureId(),
  };

  if (isGroup) {
    form["thread_fbid"] = threadId;
  } else {
    form["specific_to_list[0]"] = `fbid:${threadId}`;
    form["specific_to_list[1]"] = `fbid:${userId}`;
    form["other_user_fbid"] = threadId;
  }

  const replyToMessageId = options.replyToMessageId;
  if (replyToMessageId !== undefined) {
    form["replied_to_message_id"] = replyToMessageId;
  }
  return form;
}

/**
 * Builds the `/messaging/send/` form for a log-message mutation. `extra`
 * carries the operation-specific fields (`thread_name`, `thread_image_id`,
 * `log_message_data[added_participants][i]`, …).
 */
export function buildLogMessageForm(options: LogMessageFormOptions): Record<string, FormValue> {
  const { userId, clientId, threadId, logMessageType } = options;
  const offlineThreadingId = generateOfflineThreadingId();
  const form: Record<string, FormValue> = {
    client: "mercury",
    action_type: "ma-type:log-message",
    author: `fbid:${userId}`,
    timestamp: Date.now(),
    timestamp_absolute: "Today",
    timestamp_relative: relativeTime(),
    timestamp_time_passed: "0",
    is_unread: false,
    is_cleared: false,
    is_forward: false,
    is_filtered_content: false,
    is_spoof_warning: false,
    source: "source:chat:web",
    "source_tags[0]": "source:chat",
    status: "0",
    offline_threading_id: offlineThreadingId,
    message_id: offlineThreadingId,
    threading_id: generateThreadingId(clientId),
    manual_retry_cnt: "0",
    thread_fbid: threadId,
    log_message_type: logMessageType,
  };

  const threadIdValue = options.threadIdField ?? threadId;
  form["thread_id"] = threadIdValue;

  const extra = options.extra;
  if (extra !== undefined) {
    Object.assign(form, extra);
  }
  return form;
}
