/**
 * End-to-End Encryption (E2EE) for 1:1 Facebook Messenger threads.
 *
 * This module implements the Signal Protocol + Noise XX transport used by
 * Messenger's encrypted chats. It is a faithful port of
 * bhhoang/fbapi-unofficial (MIT), https://github.com/bhhoang/fbapi-unofficial,
 * ported to TypeScript with attribution in each file.
 *
 * Scope in v0.1.7: one-to-one text messages; reactions, edits and unsends
 * are received and surfaced as events. Group chats (sender keys), E2EE
 * attachments and encrypted backup restore are NOT implemented.
 *
 * Live verification requires a real Facebook session. Offline tests cover
 * the codec and crypto round trips only; do not equate passing tests with a
 * verified live handshake.
 */

export { E2EEClient, normalizeThreadJid } from "./client.js";
export type {
  E2EEClientDeps,
  E2EEIncomingEvent,
  E2EETextMessageEvent,
  E2EEReactionEvent,
  E2EEEditEvent,
  E2EEUnsendEvent,
} from "./client.js";

export { DeviceStore } from "./store.js";
export type { E2EEHistoryMessage, SignedPreKeyRecord } from "./store.js";

export {
  parseJid,
  addressKey,
  hasSession,
  establishSession,
  encrypt,
  decryptMessage,
  decryptPreKey,
  MESSAGE_VERSION,
} from "./signal.js";
export type { PreKeyBundle, SessionState } from "./signal.js";

export { connectNoiseSocket, EncryptedFrameSocket } from "./noise.js";
export { marshal, unmarshal, encodeNode, findChild, findDescendant } from "./wa-binary.js";
export type { WANode } from "./wa-binary.js";
export { singleByteTokens, doubleByteTokens } from "./tokens.js";
export { ProtoWriter, ProtoReader, decodeFields, encodeVarint } from "./proto.js";
