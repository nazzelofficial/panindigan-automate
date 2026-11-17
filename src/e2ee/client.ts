/**
 * Facebook Messenger 1:1 E2EE client — ported from
 * bhhoang/fbapi-unofficial (MIT), https://github.com/bhhoang/fbapi-unofficial
 * (src/e2ee/client.js), MIT licensed by bhhoang and contributors.
 *
 * Copyright (c) bhhoang and contributors of fbapi-unofficial.
 * Licensed MIT. Ported to TypeScript with only module-syntax and
 * type-annotation adjustments; protocol behaviour is unchanged.
 *
 * Scope of this port (v0.1.7): one-to-one text messages and the reaction /
 * edit / revoke protocol messages. Group chats (sender keys), attachments,
 * encrypted backup restore and calls are not implemented here and are
 * reported as unsupported, never faked.
 *
 * Live verification requires a real Facebook session; offline unit tests in
 * tests/e2ee.test.ts cover the codec and crypto round trips only.
 */

import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { CookieStore } from "../auth/index.js";
import type { HttpTransport, HttpResponse } from "../transport/http/index.js";
import type { Logger } from "../logger/index.js";
import { decodeFields, ProtoWriter } from "./proto.js";
import * as binary from "./wa-binary.js";
import type { WANode } from "./wa-binary.js";
import * as cryptoUtils from "./crypto.js";
import * as signal from "./signal.js";
import { DeviceStore } from "./store.js";
import { connectNoiseSocket, EncryptedFrameSocket } from "./noise.js";

const CAT_DOC_ID = "23999698219677129";
const ICDC_HOST = "https://reg-e2ee.facebook.com/v2";
const ICDC_APP_ID = "2220391788200892";
const E2EE_ENDPOINT = "wss://web-chat-e2ee.facebook.com/ws/chat";
const ICDC_USER_AGENT =
  "Facebook Messenger/441.1.0.32.115 (Android 13; 480dpi; 1080x2236; Xiaomi; 2210132G; cupid; qcom; en_US; 555627749)";
const WS_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const FB_MESSAGE_APPLICATION_VERSION = 2;
const FB_CONSUMER_MESSAGE_VERSION = 1;
const MIN_PREKEY_COUNT = 5;
const PREKEY_UPLOAD_COUNT = 50;

// ---------------------------------------------------------------------------
// Incoming events (delivered to the host via `onEvent`)
// ---------------------------------------------------------------------------

export interface E2EETextMessageEvent {
  readonly type: "e2ee_message";
  readonly timestamp: number;
  readonly threadId: string;
  readonly messageId: string | null;
  readonly senderId: string;
  readonly body: string;
  readonly isE2EE: true;
}

export interface E2EEReactionEvent {
  readonly type: "e2ee_message_reaction";
  readonly timestamp: number;
  readonly threadId: string;
  readonly messageId: string;
  readonly senderId: string;
  /** Reaction text, or `null` when removed. */
  readonly reaction: string | null;
  readonly isE2EE: true;
}

export interface E2EEEditEvent {
  readonly type: "e2ee_message_edit";
  readonly timestamp: number;
  readonly threadId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly body: string;
  readonly isE2EE: true;
}

export interface E2EEUnsendEvent {
  readonly type: "e2ee_message_unsend";
  readonly timestamp: number;
  readonly threadId: string;
  readonly messageId: string;
  readonly senderId: string;
  readonly isE2EE: true;
}

export type E2EEIncomingEvent =
  | E2EETextMessageEvent
  | E2EEReactionEvent
  | E2EEEditEvent
  | E2EEUnsendEvent;

export interface E2EEClientDeps {
  /** The logged-in user's id (from the session). */
  readonly userId: string;
  /** The `fb_dtsg` page token scraped from the home surface. */
  readonly fbDtsg: string;
  /** Optional jazoest counterpart of fb_dtsg. */
  readonly jazoest?: string | null;
  /** Optional LSD token seen at login. */
  readonly lsd?: string | null;
  /** Optional web client revision from the login page. */
  readonly clientRevision?: string | null;
  readonly cookies: CookieStore;
  readonly http: HttpTransport;
  readonly logger: Logger;
  /** Where the E2EE device identity is persisted. Keep it; deleting re-registers a device. */
  readonly deviceStorePath: string;
  /** Emit events for our own messages as well (default: false). */
  readonly selfListen?: boolean;
  /** Cache recipient device lists for this many ms (default: 0 = no cache). */
  readonly deviceListCacheMs?: number;
  /** Deliver incoming E2EE events. */
  readonly onEvent?: (event: E2EEIncomingEvent) => void;
}

// ---------------------------------------------------------------------------
// Encoder helpers (protobuf message builders, ported verbatim)
// ---------------------------------------------------------------------------

function encodeClientPayload(opts: {
  readonly username: string;
  readonly deviceId: number;
  readonly fbCatBase64: string;
}): Buffer {
  const appVersion = new ProtoWriter().varint(1, 301).varint(2, 0).varint(3, 2).build();
  const userAgent = new ProtoWriter()
    .varint(1, 32)
    .bytes(2, appVersion)
    .string(3, "000")
    .string(4, "000")
    .string(5, "")
    .string(6, "Linux")
    .string(7, "Chrome")
    .string(8, "")
    .varint(10, 3)
    .string(11, "en")
    .string(12, "en")
    .build();
  return new ProtoWriter()
    .uint64(1, BigInt(opts.username))
    .bool(3, false)
    .bytes(5, userAgent)
    .varint(12, 1)
    .varint(13, 1)
    .varint(18, opts.deviceId)
    .varint(20, 1)
    .bytes(21, Buffer.from(opts.fbCatBase64 || ""))
    .bytes(22, Buffer.from(WS_USER_AGENT))
    .bool(33, true)
    .build();
}

function encodeTextMessage(text: string): Buffer {
  const msgText = new ProtoWriter().string(1, text).build();
  const content = new ProtoWriter().bytes(1, msgText).build();
  const payload = new ProtoWriter().bytes(1, content).build();
  return new ProtoWriter().bytes(1, payload).build();
}

function generatePadding(): Buffer {
  const len = randomBytes(1)[0] || 1;
  const pad = randomBytes(len);
  pad[len - 1] = len;
  return pad;
}

interface OutboundDsm {
  readonly destinationJid: string;
  readonly phash: string;
}

function encodeMessageTransport(opts: {
  readonly messageApp?: Buffer | undefined;
  readonly dsm?: OutboundDsm | undefined;
  readonly messageRef?: string | undefined;
}): Buffer {
  const padding = generatePadding();
  let payload: Buffer | undefined;
  if (opts.messageApp) {
    const appPayload = new ProtoWriter()
      .bytes(1, opts.messageApp)
      .varint(2, FB_MESSAGE_APPLICATION_VERSION)
      .build();
    payload = new ProtoWriter().bytes(1, appPayload).varint(3, 0).build();
  }
  const integral = new ProtoWriter().bytes(1, padding);
  if (opts.dsm) {
    const dsm = new ProtoWriter()
      .string(1, opts.dsm.destinationJid)
      .string(2, opts.dsm.phash || "")
      .build();
    integral.bytes(2, dsm);
  } else if (opts.messageRef != null) {
    const ref = new ProtoWriter()
      .string(1, String(opts.messageRef))
      .varint(2, 1)
      .build();
    integral.bytes(2, new ProtoWriter().bytes(5, ref).build());
  }
  const protocol = new ProtoWriter().bytes(1, integral.build()).bytes(2, Buffer.alloc(0)).build();
  const transport = new ProtoWriter();
  if (payload) transport.bytes(1, payload);
  return transport.bytes(2, protocol).build();
}

function encodeMessageApplication(
  consumerApp: Buffer,
): { messageApp: Buffer; frankingTag: Buffer } {
  const frankingKey = randomBytes(32);
  const subProtocol = new ProtoWriter()
    .bytes(1, consumerApp)
    .varint(2, FB_CONSUMER_MESSAGE_VERSION)
    .build();
  const payloadSubProto = new ProtoWriter().varint(1, 0).bytes(2, subProtocol).build();
  const appPayload = new ProtoWriter().bytes(4, payloadSubProto).build();
  const metadata = new ProtoWriter().bytes(8, frankingKey).varint(9, 0).build();
  const messageApp = new ProtoWriter()
    .bytes(1, appPayload)
    .bytes(2, metadata)
    .build();
  const frankingTag = cryptoUtils.hmacSha256(frankingKey, messageApp);
  return { messageApp, frankingTag };
}

function encodePreKeyNode(
  key: { id: number; pub: Buffer; signature?: Buffer },
  tag: "key" | "skey",
): Buffer {
  const idBuf = Buffer.alloc(4);
  idBuf.writeUInt32BE(key.id);
  const children = [
    binary.encodeNode("id", {}, idBuf.subarray(1)),
    binary.encodeNode("value", {}, key.pub),
  ];
  if (key.signature) children.push(binary.encodeNode("signature", {}, key.signature));
  return binary.encodeNode(tag, {}, children);
}

function encodePreKeyUpload(
  id: string,
  registrationId: number,
  identityPub: Buffer,
  signedPreKey: { id: number; pub: Buffer; signature: Buffer },
  preKeys: ReadonlyArray<{ id: number; pub: Buffer }>,
): Buffer {
  const regBuf = Buffer.alloc(4);
  regBuf.writeUInt32BE(registrationId);
  const iq = binary.encodeNode(
    "iq",
    { id, to: "s.whatsapp.net", type: "set", xmlns: "encrypt" },
    [
      binary.encodeNode("registration", {}, regBuf),
      binary.encodeNode("type", {}, Buffer.from([5])),
      binary.encodeNode("identity", {}, identityPub),
      binary.encodeNode(
        "list",
        {},
        preKeys.map((key) => encodePreKeyNode(key, "key")),
      ),
      encodePreKeyNode(signedPreKey, "skey"),
    ],
  );
  return binary.marshal(iq);
}

export function normalizeThreadJid(threadId: string): string {
  const id = String(threadId);
  if (id.indexOf("@") !== -1) return id;
  if (id.indexOf(".") !== -1 || id.indexOf(":") !== -1) return id + "@msgr";
  return id + ".0@msgr";
}

function bareJid(jid: string): string {
  const at = jid.indexOf("@");
  const userPart = at === -1 ? jid : jid.slice(0, at);
  const server = at === -1 ? "" : jid.slice(at + 1);
  let cut = userPart.indexOf(".");
  if (cut === -1) cut = userPart.indexOf(":");
  if (cut === -1) cut = userPart.length;
  return userPart.slice(0, cut) + ".0@" + server;
}

function summarizeNode(node: WANode | null | undefined): unknown {
  if (node === null || node === undefined) return String(node);
  if (Buffer.isBuffer(node.content)) {
    return { tag: node.tag, attrs: node.attrs, content: `<${node.content.length} bytes>` };
  }
  return {
    tag: node.tag,
    attrs: node.attrs,
    content: Array.isArray(node.content)
      ? node.content.map((child) => summarizeNode(child))
      : summarizeNode(node.content as WANode | undefined),
  };
}

// ---------------------------------------------------------------------------
// Decoded consumer-content envelope (text/reaction/edit/revoke only)
// ---------------------------------------------------------------------------

type DecodedConsumerContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reaction"; readonly targetMessageID: string | null; readonly text: string | null; readonly timestamp: number | null }
  | { readonly kind: "edit"; readonly targetMessageID: string | null; readonly text: string; readonly timestamp: number | null }
  | { readonly kind: "revoke"; readonly targetMessageID: string | null }
  | { readonly kind: "other" | "media" };

function decodeConsumerContent(bytes: Buffer): DecodedConsumerContent | null {
  try {
    const transport = decodeFields(bytes);
    const payload = transport[1] ? decodeFields(transport[1] as Buffer) : null;
    const applicationPayload = payload?.[1] ? decodeFields(payload[1] as Buffer) : null;
    if (!applicationPayload?.[1]) return null;
    const messageApp = decodeFields(applicationPayload[1] as Buffer);
    const appPayloadContainer = messageApp[1] ? decodeFields(messageApp[1] as Buffer) : null;
    const payloadSubProtocol = appPayloadContainer?.[4]
      ? decodeFields(appPayloadContainer[4] as Buffer)
      : null;
    if (payloadSubProtocol?.[1]) {
      const revokedID = findMessageKeyID(decodeFields(payloadSubProtocol[1] as Buffer), 0);
      if (revokedID) return { kind: "revoke", targetMessageID: revokedID };
    }
    const subProtocol = payloadSubProtocol?.[2] ? decodeFields(payloadSubProtocol[2] as Buffer) : null;
    const consumerApp = subProtocol?.[1] ? decodeFields(subProtocol[1] as Buffer) : null;
    if (!consumerApp) return null;
    const consumerPayload = consumerApp[1] ? decodeFields(consumerApp[1] as Buffer) : null;
    if (!consumerPayload?.[1]) return null;
    const content = decodeFields(consumerPayload[1] as Buffer);
    if (content[1]) {
      const messageText = decodeFields(content[1] as Buffer);
      return {
        kind: "text",
        text: messageText[1] ? Buffer.from(messageText[1] as Buffer).toString("utf8") : "",
      };
    }
    if (content[16]) {
      const reactionFields = decodeFields(content[16] as Buffer);
      const reactionKey = reactionFields[1] ? decodeFields(reactionFields[1] as Buffer) : null;
      return {
        kind: "reaction",
        targetMessageID: reactionKey?.[3] ? Buffer.from(reactionKey[3] as Buffer).toString("utf8") : null,
        text: reactionFields[2] != null ? Buffer.from(reactionFields[2] as Buffer).toString("utf8") : null,
        timestamp: reactionFields[4] != null ? Number(reactionFields[4]) : null,
      };
    }
    if (content[19]) {
      const editFields = decodeFields(content[19] as Buffer);
      const editKey = editFields[1] ? decodeFields(editFields[1] as Buffer) : null;
      const editContent = editFields[2] ? decodeFields(editFields[2] as Buffer) : null;
      return {
        kind: "edit",
        targetMessageID: editKey?.[3] ? Buffer.from(editKey[3] as Buffer).toString("utf8") : null,
        text: editContent?.[1] ? Buffer.from(editContent[1] as Buffer).toString("utf8") : "",
        timestamp: editFields[3] != null ? Number(editFields[3]) : null,
      };
    }
    return { kind: "other" };
  } catch {
    return null;
  }
}

function findMessageKeyID(obj: Record<number, bigint | Buffer>, depth: number): string | null {
  if (!obj || depth > 12) return null;
  const direct = obj[3];
  if (direct != null && Buffer.isBuffer(direct)) {
    const id = Buffer.from(direct).toString("utf8");
    if (/^\d{8,}$/.test(id)) return id;
  }
  for (const value of Object.values(obj)) {
    if (Buffer.isBuffer(value)) {
      let nested: Record<number, bigint | Buffer> | null = null;
      try {
        nested = decodeFields(value);
      } catch {
        nested = null;
      }
      if (nested) {
        const found = findMessageKeyID(nested, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

function decodeDsmDestination(bytes: Buffer): string | null {
  try {
    const transport = decodeFields(bytes);
    const protocol = transport[2] ? decodeFields(transport[2] as Buffer) : null;
    const integral = protocol?.[1] ? decodeFields(protocol[1] as Buffer) : null;
    const dsm = integral?.[2] ? decodeFields(integral[2] as Buffer) : null;
    return dsm?.[1] ? Buffer.from(dsm[1] as Buffer).toString("utf8") : null;
  } catch {
    return null;
  }
}

function findNode(node: WANode | null | undefined, tag: string): WANode | null {
  if (!node) return null;
  if (node.tag === tag) return node;
  if (!Array.isArray(node.content)) return null;
  for (const child of node.content) {
    const found = findNode(child, tag);
    if (found) return found;
  }
  return null;
}

function findChild(node: WANode | null | undefined, tag: string): WANode | null {
  return binary.findChild(node ?? null, tag);
}

function findDescendant(node: WANode | null | undefined, tag: string): WANode | null {
  return binary.findDescendant(node ?? null, tag);
}

function collectNodes(node: WANode | null | undefined, tag: string, out: WANode[] = []): WANode[] {
  if (!node || typeof node !== "object") return out;
  if (node.tag === tag) {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectNodes(child, tag, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// E2EE client
// ---------------------------------------------------------------------------

interface PendingIQ {
  resolve: (node: WANode) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface OutboundCacheEntry {
  readonly threadJid: string;
  readonly messageApp: Buffer;
  readonly frankingTag: Buffer;
  readonly createdAt: number;
}

/** Normalized raw JID parts used on the wire. */
interface DeviceListCacheEntry {
  readonly at: number;
  readonly devices: string[];
}

export class E2EEClient {
  #deps: E2EEClientDeps;
  #store: DeviceStore | null = null;
  #socket: EncryptedFrameSocket | null = null;
  #cat: string | null = null;
  #connected = false;
  #pendingIQs = new Map<string, PendingIQ>();
  #connectPromise: Promise<void> | null = null;
  /** When set, incoming frames are routed here first during connection setup. */
  #frameInterceptor: ((frame: Buffer) => boolean) | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #prekeyTimer: NodeJS.Timeout | null = null;
  #requestCounter = 0;
  #deviceListCache: Record<string, DeviceListCacheEntry> = {};
  #outboundCache: Record<string, OutboundCacheEntry> = {};
  #lastMessageId: bigint | undefined;
  #deviceRecovered = false;

  constructor(deps: E2EEClientDeps) {
    this.#deps = deps;
  }

  private get log(): Logger {
    return this.#deps.logger.child({ module: "e2ee" });
  }

  #requireStore(): DeviceStore {
    if (!this.#store) {
      throw new Error("E2EE device store not initialized — call connect() first");
    }
    return this.#store;
  }

  /** Whether the encrypted channel is connected and authenticated. */
  isConnected(): boolean {
    return this.#connected && this.#socket !== null;
  }

  /** The registered E2EE device id, or `null` when not registered. */
  get deviceId(): number | null {
    return this.#store?.jidDevice ?? null;
  }

  /** The E2EE device store (public for diagnostics/tests). */
  get store(): DeviceStore | null {
    return this.#store;
  }

  // -------------------------------------------------------------------------
  // Connect / register
  // -------------------------------------------------------------------------

  /** Connect (or return the in-flight/already established connection). */
  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.#connectPromise) return this.#connectPromise;

    this.#connectPromise = this.#connect()
      .catch((err: Error) => this.#recoverEvictedDevice(err))
      .catch((err: Error) => {
        this.#connectPromise = null;
        throw err;
      });
    return this.#connectPromise;
  }

  async #connect(): Promise<void> {
    const storePath = this.#deps.deviceStorePath;
    if (!this.#store) this.#store = DeviceStore.fromFile(storePath);

    const cat = await this.#fetchCat();
    this.#cat = cat;

    let deviceId = this.#store.jidDevice;
    if (!deviceId) {
      deviceId = await this.#registerDevice(cat);
      this.#store.jidDevice = deviceId;
      this.#store.jidUser = this.#deps.userId;
      this.#store.save();
    }

    const payload = encodeClientPayload({
      username: this.#deps.userId,
      deviceId,
      fbCatBase64: cat,
    });
    const endpoint = `${E2EE_ENDPOINT}?cid=client-${Date.now()}`;
    const options = {
      headers: {
        Origin: "https://www.facebook.com",
        "User-Agent": WS_USER_AGENT,
        Cookie: this.#deps.cookies.headerFor("https://www.facebook.com"),
      },
      perMessageDeflate: true,
    };
    const noiseKeyPriv = this.#requireStore().noiseKeyPriv as Buffer;
    const socket = await connectNoiseSocket(endpoint, options, noiseKeyPriv, payload);
    this.#socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#frameInterceptor = null;
        reject(new Error("E2EE login timed out waiting for success frame."));
      }, 15000);
      this.#frameInterceptor = (frame: Buffer): boolean => {
        let node: WANode | null = null;
        try {
          node = binary.unmarshal(frame);
        } catch {
          node = null;
        }
        if (node?.tag === "success" && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.#frameInterceptor = null;
          this.#handleFrame(frame);
          resolve();
          return true;
        }
        if (node?.tag === "failure" && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.#frameInterceptor = null;
          reject(new Error(`E2EE login failure: ${node.attrs.reason || "unknown"}`));
          return true;
        }
        return false;
      };
      this.#readLoop();
    });

    this.#connected = true;
    await this.#sendNode(binary.encodeNode("presence", { type: "available", passive: "false" }));
    const sessionId = String((Date.now() + 3 * 24 * 60 * 60 * 1000) % (7 * 24 * 60 * 60 * 1000));
    await this.#sendNode(
      binary.encodeNode("ib", {}, [
        binary.encodeNode("unified_session", { id: sessionId }),
        binary.encodeNode("offline"),
        binary.encodeNode("dirty", { type: "account_sync" }),
      ]),
    );
    await this.#sendNode(
      binary.encodeNode(
        "iq",
        { id: "active-stream", to: "s.whatsapp.net", type: "set", xmlns: "passive" },
        [binary.encodeNode("active")],
      ),
    );
    void this.#syncPreKeys();
    this.#startHeartbeat();
  }

  /** Disconnect the encrypted channel (idempotent). */
  async disconnect(): Promise<void> {
    this.#stopHeartbeat();
    this.#connected = false;
    const socket = this.#socket;
    this.#socket = null;
    this.#connectPromise = null;
    if (socket) {
      try {
        socket.end();
      } catch {
        // already closed
      }
    }
  }

  /** Meta evicted this device (415); re-register once with the same identity. */
  async #recoverEvictedDevice(err: Error): Promise<void> {
    const message = String(err?.message ?? err ?? "");
    if (!/E2EE login failure: 415/.test(message)) throw err;
    if (!this.#store || !this.#store.jidDevice || this.#deviceRecovered) throw err;
    this.#deviceRecovered = true;
    this.log.warn({ deviceId: this.#store.jidDevice }, "E2EE device rejected (415); re-registering with same identity");
    this.#store.jidDevice = 0;
    this.#store.sessions = {};
    try {
      this.#store.save();
    } catch {
      // best effort
    }
    if (this.#socket) {
      try {
        this.#socket.end();
      } catch {
        // already closed
      }
      this.#socket = null;
    }
    return this.#connect();
  }

  async #fetchCat(): Promise<string> {
    const form = {
      fb_dtsg: this.#deps.fbDtsg,
      variables: "{}",
      doc_id: CAT_DOC_ID,
      __user: this.#deps.userId,
      __a: "1",
      __jssesw: "1",
      server_timestamps: "true",
    };
    const response = await this.#deps.http.postForm(
      "e2ee_cat",
      "https://www.facebook.com/api/graphql/",
      form,
      { withDefaults: false },
    );
    const resData = (response.json ?? parseJson(response.body)) as
      | { data?: { secure_message_over_wa_cat_query?: { encrypted_serialized_cat?: string } } }
      | null;
    const cat = resData?.data?.secure_message_over_wa_cat_query?.encrypted_serialized_cat;
    if (!cat) {
      const detail = typeof response.body === "string" ? response.body.slice(0, 500) : "";
      throw new Error(`Could not fetch E2EE CAT token from Facebook: ${detail}`);
    }
    return cat;
  }

  async #icdcPost(endpoint: string, form: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
    const response = await this.#deps.http.postForm(
      `e2ee_icdc_${endpoint}`,
      `${ICDC_HOST}/${endpoint}`,
      form,
      {
        withDefaults: false,
        headers: {
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": ICDC_USER_AGENT,
          Origin: "https://www.messenger.com",
          Referer: "https://www.messenger.com/messages/",
        },
      },
    );
    if (response.status !== 200) {
      throw new Error(
        `ICDC ${endpoint} failed with HTTP ${response.status}: ${response.body.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(response.body) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`ICDC ${endpoint} returned invalid JSON`, { cause: err });
    }
  }

  async #registerDevice(fbCat: string): Promise<number> {
    const store = this.#requireStore();
    const fetchForm = {
      fbid: this.#deps.userId,
      device_id: store.facebookUUID,
      app_id: ICDC_APP_ID,
      fb_cat: fbCat,
    };
    const fetchResp = await this.#icdcPost("fb_icdc_fetch", fetchForm);
    if (Number(fetchResp.status) !== 200) {
      throw new Error(`ICDC fetch failed with status ${String(fetchResp.status)}`);
    }
    const identities: Buffer[] = Array.isArray(fetchResp.device_identities)
      ? (fetchResp.device_identities as unknown[]).map((id) => Buffer.from(String(id), "base64"))
      : [];
    const ownIdentity = store.identityPublic();
    let ownIndex = -1;
    for (let i = 0; i < identities.length; i++) {
      if (Buffer.compare(identities[i] as Buffer, ownIdentity) === 0) {
        ownIndex = i;
        break;
      }
    }
    let seq = Number(fetchResp.icdc_seq ?? 0);
    if (ownIndex === -1) {
      ownIndex = identities.length;
      identities.push(ownIdentity);
      seq += 1;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const details = new ProtoWriter().varint(1, seq).uint64(2, BigInt(timestamp));
    for (const identity of identities) {
      details.bytes(3, identity);
    }
    details.varint(4, ownIndex);
    const unsignedList = details.build();
    const signature = cryptoUtils.xeddsaSign((store.identityKeyPair as { priv: Buffer }).priv, unsignedList);
    const signedList = new ProtoWriter().bytes(1, unsignedList).bytes(2, signature).build();

    const sorted = identities.slice().sort(Buffer.compare) as Buffer[];
    const hash = cryptoUtils.sha256(Buffer.concat(sorted)).subarray(0, 10);

    const regBuf = Buffer.alloc(4);
    regBuf.writeUInt32BE(store.registrationId);
    const skeyId = Buffer.alloc(4);
    skeyId.writeUInt32BE((store.signedPreKey as { id: number }).id);
    const registerForm = {
      fbid: this.#deps.userId,
      fb_cat: fbCat,
      app_id: ICDC_APP_ID,
      device_id: store.facebookUUID,
      e_regid: regBuf.toString("base64"),
      e_keytype: Buffer.from([5]).toString("base64"),
      e_ident: ownIdentity.toString("base64"),
      e_skey_id: skeyId.subarray(1).toString("base64"),
      e_skey_val: Buffer.from((store.signedPreKey as { pub: string }).pub, "base64").toString("base64"),
      e_skey_sig: Buffer.from((store.signedPreKey as { signature: string }).signature, "base64").toString("base64"),
      icdc_list: signedList.toString("base64"),
      icdc_ts: String(timestamp),
      icdc_seq: String(seq),
      ihash: hash.toString("base64"),
    };
    const registerResp = await this.#icdcPost("fb_register_v2", registerForm);
    if (Number(registerResp.status) !== 200) {
      throw new Error(`ICDC register failed with status ${String(registerResp.status)}`);
    }
    return Number(registerResp.wa_device_id);
  }

  // -------------------------------------------------------------------------
  // Frame send/receive
  // -------------------------------------------------------------------------

  async #sendNode(node: WANode | Buffer): Promise<void> {
    const socket = this.#socket;
    if (!socket) throw new Error("E2EE socket is not connected");
    const body = Buffer.isBuffer(node) ? node : binary.encodeNode(node.tag, node.attrs, node.content);
    socket.sendFrame(Buffer.concat([Buffer.from([0]), body]));
  }

  #nextId(prefix: string): string {
    this.#requestCounter += 1;
    return prefix + Date.now() + "-" + this.#requestCounter;
  }

  #nextMessageId(): string {
    let id = (BigInt(Date.now()) << 22n) | BigInt(randomInt(4194304));
    if (this.#lastMessageId !== undefined && id <= this.#lastMessageId) {
      id = this.#lastMessageId + 1n;
    }
    this.#lastMessageId = id;
    return id.toString();
  }

  async #requestIQ(iq: WANode, timeoutMs = 10000): Promise<WANode> {
    const id = iq.attrs.id;
    if (!id) throw new Error("E2EE IQ requires an id");
    return new Promise<WANode>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingIQs.delete(id);
        reject(new Error(`E2EE IQ timeout: ${id}`));
      }, timeoutMs);
      this.#pendingIQs.set(id, {
        resolve: (node: WANode) => {
          clearTimeout(timer);
          resolve(node);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
      this.#sendNode(iq).catch((err: Error) => {
        clearTimeout(timer);
        this.#pendingIQs.delete(id);
        reject(err);
      });
    });
  }

  async #getDeviceList(userJids: ReadonlyArray<string>): Promise<string[]> {
    const id = this.#nextId("");
    const iq: WANode = {
      tag: "iq",
      attrs: { id, to: "s.whatsapp.net", type: "get", xmlns: "fbid:devices" },
      content: [
        {
          tag: "users",
          attrs: {},
          content: userJids.map((jid) => ({ tag: "user", attrs: { jid } })),
        },
      ],
    };
    const res = await this.#requestIQ(iq);
    const deviceJids: string[] = [];
    const usersNode = findChild(res, "users");
    if (!usersNode || !Array.isArray(usersNode.content)) return deviceJids;
    for (const userNode of usersNode.content) {
      if (!userNode || userNode.tag !== "user" || !Array.isArray(userNode.content)) continue;
      const devicesNode = findChild(userNode, "devices");
      if (!devicesNode || !Array.isArray(devicesNode.content)) continue;
      const parsed = signal.parseJid(userNode.attrs.jid as string);
      for (const deviceNode of devicesNode.content) {
        if (deviceNode?.tag === "device" && deviceNode.attrs.id) {
          deviceJids.push(`${parsed.user}.${deviceNode.attrs.id}@${parsed.server}`);
        }
      }
    }
    return deviceJids;
  }

  #deviceListKey(jid: string): string {
    const parsed = signal.parseJid(jid);
    return `${parsed.user}@${parsed.server}`;
  }

  async #getDeviceListCached(userJids: string[]): Promise<string[]> {
    const ttl = Number(this.#deps.deviceListCacheMs ?? 0);
    if (!(ttl > 0)) return this.#getDeviceList(userJids);
    const now = Date.now();
    const cached: string[] = [];
    const missing: string[] = [];
    for (const jid of userJids) {
      const entry = this.#deviceListCache[this.#deviceListKey(jid)];
      if (entry && now - entry.at < ttl) cached.push(...entry.devices);
      else missing.push(jid);
    }
    if (missing.length === 0) return cached;
    const devices = await this.#getDeviceList(missing);
    const at = Date.now();
    for (const jid of missing) {
      const key = this.#deviceListKey(jid);
      this.#deviceListCache[key] = {
        at,
        devices: devices.filter((device) => this.#deviceListKey(device) === key),
      };
    }
    return cached.concat(devices);
  }

  #forgetDeviceList(jid: string): void {
    delete this.#deviceListCache[this.#deviceListKey(jid)];
  }

  async #getPreKeyBundle(jid: string): Promise<signal.PreKeyBundle> {
    const id = this.#nextId("pkb-");
    const iq: WANode = {
      tag: "iq",
      attrs: { id, to: "s.whatsapp.net", type: "get", xmlns: "encrypt" },
      content: [{ tag: "key", attrs: {}, content: [{ tag: "user", attrs: { jid } }] }],
    };
    const res = await this.#requestIQ(iq);
    const userNode = findDescendant(res, "user");
    if (!userNode) {
      throw new Error(`Missing user node in prekey bundle for ${jid}: ${JSON.stringify(summarizeNode(res))}`);
    }
    return this.#parsePreKeyBundle(userNode, jid, res);
  }

  async #getPreKeyBundles(
    jids: ReadonlyArray<string>,
  ): Promise<Record<string, signal.PreKeyBundle | Error>> {
    if (jids.length === 1) {
      const single = jids[0] as string;
      try {
        return { [single]: await this.#getPreKeyBundle(single) };
      } catch (err) {
        return { [single]: err as Error };
      }
    }
    const iq: WANode = {
      tag: "iq",
      attrs: { id: this.#nextId("pkb-"), to: "s.whatsapp.net", type: "get", xmlns: "encrypt" },
      content: [
        {
          tag: "key",
          attrs: {},
          content: jids.map((jid) => ({ tag: "user", attrs: { jid } })),
        },
      ],
    };
    const byAddress: Record<string, string> = {};
    for (const jid of jids) byAddress[signal.addressKey(jid)] = jid;
    let results: Record<string, signal.PreKeyBundle | Error> = {};
    try {
      const res = await this.#requestIQ(iq);
      for (const userNode of collectNodes(res, "user")) {
        const jid = userNode.attrs?.jid ? byAddress[signal.addressKey(userNode.attrs.jid)] : undefined;
        if (!jid) continue;
        try {
          results[jid] = this.#parsePreKeyBundle(userNode, jid);
        } catch (err) {
          results[jid] = err as Error;
        }
      }
    } catch (err) {
      this.log.warn({ err }, "Batched prekey fetch failed; falling back to per-device");
      results = {};
    }
    for (const jid of jids) {
      if (!results[jid]) {
        try {
          results[jid] = await this.#getPreKeyBundle(jid);
        } catch (err) {
          results[jid] = err as Error;
        }
      }
    }
    return results;
  }

  #parsePreKeyBundle(userNode: WANode, jid: string, keyScope?: WANode): signal.PreKeyBundle {
    const keyNode = findDescendant(keyScope ?? userNode, "key");
    if (!keyNode) {
      throw new Error(`Missing key node in prekey bundle for ${jid}: ${JSON.stringify(summarizeNode(userNode))}`);
    }
    const registration = findChild(userNode, "registration");
    const identity = findChild(userNode, "identity");
    const skey = findChild(userNode, "skey");
    if (!registration || !identity || !skey) {
      throw new Error(`Incomplete prekey bundle for ${jid}: ${JSON.stringify(summarizeNode(userNode))}`);
    }
    const key = findChild(keyNode, "key") ?? keyNode;
    const preKeyId = findChild(key, "id");
    const preKeyValue = findChild(key, "value");
    const signedId = findChild(skey, "id");
    const signedValue = findChild(skey, "value");
    const signedSig = findChild(skey, "signature");
    const readId = (node: WANode | null | undefined): number => {
      const content = node?.content;
      if (!node || !Buffer.isBuffer(content) || content.length === 0) return 0;
      return content.readUIntBE(0, Math.min(content.length, 3));
    };
    const prefixed = (node: WANode | null | undefined): Buffer => {
      const buf = Buffer.from(node?.content as Buffer);
      return buf.length === 32 ? Buffer.concat([Buffer.from([5]), buf]) : buf;
    };
    const parsed = signal.parseJid(jid);
    const bundle: signal.PreKeyBundle = {
      registrationId: Buffer.isBuffer(registration.content) ? registration.content.readUInt32BE(0) : 0,
      deviceId: parsed.device,
      identityKey: Buffer.from(identity.content as Buffer),
      signedPreKey: {
        keyId: readId(signedId),
        publicKey: prefixed(signedValue),
        signature: Buffer.from(signedSig?.content as Buffer),
      },
      ...(preKeyValue?.content
        ? { preKey: { keyId: readId(preKeyId), publicKey: prefixed(preKeyValue) } }
        : {}),
    };
    return bundle;
  }

  async #getServerPreKeyCount(): Promise<number> {
    const id = this.#nextId("pkc-");
    const iq: WANode = {
      tag: "iq",
      attrs: { id, to: "s.whatsapp.net", type: "get", xmlns: "encrypt" },
      content: [{ tag: "count", attrs: {} }],
    };
    try {
      const res = await this.#requestIQ(iq, 5000);
      const count = findDescendant(res, "count");
      return count ? parseInt(count.attrs.value || "0", 10) : 0;
    } catch {
      return 0;
    }
  }

  async #uploadPreKeys(count: number): Promise<void> {
    const store = this.#requireStore();
    const preKeys = store.generatePreKeys(count);
    const signed = store.rotateSignedPreKey();
    const payload = encodePreKeyUpload(
      this.#nextId("pk-"),
      store.registrationId,
      store.identityPublic(),
      { id: signed.id, pub: Buffer.from(signed.pub, "base64"), signature: Buffer.from(signed.signature, "base64") },
      preKeys.map((key) => ({ id: key.id, pub: key.pub })),
    );
    const socket = this.#socket;
    if (!socket) throw new Error("E2EE socket is not connected");
    socket.sendFrame(payload);
  }

  async #syncPreKeys(): Promise<void> {
    try {
      const count = await this.#getServerPreKeyCount();
      if (count < MIN_PREKEY_COUNT) await this.#uploadPreKeys(PREKEY_UPLOAD_COUNT);
    } catch (err) {
      this.log.warn({ err }, "E2EE prekey sync failed");
    }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /** Send a text message. Returns the message id Messenger assigns. */
  async sendTextMessage(
    threadId: string,
    text: string,
  ): Promise<{ messageId: string; timestamp: number }> {
    if (String(threadId).indexOf("@g.us") !== -1) {
      throw new Error("E2EE group messages are not supported (group E2EE needs sender keys)");
    }
    await this.connect();
    return this.#sendMessageApp(threadId, encodeTextMessage(text), "text", text, undefined);
  }

  async #sendMessageApp(
    threadId: string,
    consumerApp: Buffer,
    nodeType: "text" | "media",
    historyBody: string,
    protocolMediaType: string | undefined,
  ): Promise<{ messageId: string; timestamp: number }> {
    const store = this.#requireStore();
    const toJid = normalizeThreadJid(String(threadId));
    const selfJid = `${this.#deps.userId}.${store.jidDevice || 0}@msgr`;
    const selfBare = bareJid(selfJid);
    const messageId = this.#nextMessageId();

    const app = encodeMessageApplication(consumerApp);
    const devicePayload = encodeMessageTransport({
      messageApp: app.messageApp,
      messageRef: messageId,
    });
    const selfDevicePayload = encodeMessageTransport({
      messageApp: app.messageApp,
      dsm: { destinationJid: toJid, phash: "" },
    });

    this.#outboundCache[messageId] = {
      threadJid: toJid,
      messageApp: app.messageApp,
      frankingTag: app.frankingTag,
      createdAt: Date.now(),
    };
    const cacheIds = Object.keys(this.#outboundCache);
    if (cacheIds.length > 200) {
      const oldest = cacheIds
        .map((id) => ({ id, at: this.#outboundCache[id]?.createdAt ?? 0 }))
        .sort((a, b) => a.at - b.at)[0];
      if (oldest) delete this.#outboundCache[oldest.id];
    }

    try {
      const deviceJids = await this.#getDeviceListCached([toJid, selfBare]);
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const deviceJid of deviceJids) {
        const key = signal.addressKey(deviceJid);
        if (seen.has(key) || key === signal.addressKey(selfJid)) continue;
        seen.add(key);
        unique.push(deviceJid);
      }
      if (unique.length === 0) {
        throw new Error(`No E2EE devices found for ${threadId}`);
      }
      const failures: string[] = [];
      const needSession = unique.filter((deviceJid) => !signal.hasSession(store, deviceJid));
      const bundleResults = needSession.length
        ? await this.#getPreKeyBundles(needSession)
        : ({} as Record<string, signal.PreKeyBundle | Error>);
      const usable = unique.filter((deviceJid) => {
        if (!needSession.includes(deviceJid)) return true;
        const bundle = bundleResults[deviceJid];
        if (bundle instanceof Error || !bundle) {
          failures.push(`${deviceJid}: ${bundle instanceof Error ? bundle.message : "no prekey bundle"}`);
          return false;
        }
        signal.establishSession(store, deviceJid, bundle);
        return true;
      });
      if (usable.length === 0) {
        throw new Error(
          `Could not establish an E2EE session for ${threadId} (${failures.join("; ")})`,
        );
      }
      if (failures.length > 0) {
        this.log.warn({ failures }, `No E2EE session for ${failures.length} device(s) of ${threadId}`);
      }
      const participantNodes = usable.map((deviceJid) => {
        const own = signal.parseJid(deviceJid).user === signal.parseJid(selfJid).user;
        const payload = own ? selfDevicePayload : devicePayload;
        const encrypted = signal.encrypt(store, deviceJid, payload);
        const encAttrs: Record<string, string> = { v: "3", type: encrypted.type };
        if (protocolMediaType) encAttrs.mediatype = protocolMediaType;
        return binary.encodeNode("to", { jid: deviceJid }, [
          binary.encodeNode("enc", encAttrs, encrypted.ciphertext),
        ]);
      });
      const messageNode = binary.encodeNode(
        "message",
        { to: toJid, type: nodeType, id: messageId },
        [
          binary.encodeNode("participants", {}, participantNodes),
          binary.encodeNode("franking", {}, [
            binary.encodeNode("franking_tag", {}, app.frankingTag),
          ]),
          binary.encodeNode("trace", {}, [
            binary.encodeNode(
              "request_id",
              {},
              Buffer.from(randomUUID().replace(/-/g, ""), "hex"),
            ),
          ]),
        ],
      );
      const socket = this.#socket;
      if (!socket) throw new Error("E2EE socket is not connected");
      await new Promise<void>((resolve, reject) => {
        try {
          socket.sendFrame(Buffer.concat([Buffer.from([0]), messageNode]));
          resolve();
        } catch (err) {
          reject(err as Error);
        }
      });
      const timestamp = Date.now();
      store.threads[String(threadId)] = true;
      store.appendHistory(String(threadId), {
        messageID: messageId,
        threadID: String(threadId),
        senderID: this.#deps.userId,
        timestamp,
        body: historyBody || "",
      });
      store.save();
      return { messageId, timestamp };
    } catch (err) {
      this.#forgetDeviceList(toJid);
      this.#forgetDeviceList(selfBare);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  #handleFrame(frame: Buffer): void {
    if (!frame || frame.length === 0) return;
    if (this.#frameInterceptor?.(frame)) return;
    let node: WANode;
    try {
      node = binary.unmarshal(frame);
    } catch {
      return;
    }
    if (node.tag === "success") {
      const jid = node.attrs.jid;
      if (jid) {
        const parsed = signal.parseJid(jid);
        if (this.#store) {
          this.#store.jidUser = parsed.user;
          this.#store.jidDevice = parsed.device;
          this.#store.save();
        }
      }
      return;
    }
    if (node.tag === "iq") {
      this.#handleIQ(node);
      return;
    }
    if (node.tag === "failure") {
      this.log.warn({ reason: node.attrs.reason ?? "unknown" }, "E2EE socket reported a failure");
      return;
    }
    if (node.tag === "message" || node.tag === "appdata") {
      this.#handleEncryptedMessage(node);
      return;
    }
    if (node.tag === "notification") {
      this.#handleNotification(node);
      return;
    }
    if (node.tag === "receipt") {
      this.#handleReceipt(node);
      return;
    }
    this.#sendAck(node);
  }

  #handleEncryptedMessage(node: WANode): void {
    const senderJid = node.attrs.participant ?? node.attrs.from;
    let enc: WANode | null = null;
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        if (child?.tag === "enc" && !enc) enc = child;
      }
    } else if (
      node.content &&
      typeof node.content === "object" &&
      !Buffer.isBuffer(node.content) &&
      !Array.isArray(node.content) &&
      (node.content as WANode).tag === "enc"
    ) {
      enc = node.content as WANode;
    }
    if (!enc || !Buffer.isBuffer(enc.content) || !senderJid) {
      // Group / SKDM distribution frames are not supported; acknowledge only.
      this.#sendAck(node);
      return;
    }

    const store = this.#requireStore();
    let plaintext: Buffer;
    try {
      if (enc.attrs.type === "pkmsg") {
        plaintext = signal.decryptPreKey(store, senderJid, enc.content);
      } else if (enc.attrs.type === "msg") {
        plaintext = signal.decryptMessage(store, senderJid, enc.content);
      } else {
        this.#sendAck(node);
        return;
      }
    } catch (err) {
      this.log.warn({ err, senderJid }, "Could not decrypt E2EE message");
      this.#sendRetryReceipt(node);
      this.#sendAck(node);
      return;
    }

    const payload = decodeConsumerContent(plaintext);
    const chatJid = decodeDsmDestination(plaintext) ?? (node.attrs.from as string);
    const threadId = signal.parseJid(chatJid).user;
    const senderId = signal.parseJid(senderJid).user;
    const messageId = (node.attrs.id as string | undefined) ?? null;

    if (payload && threadId) {
      if (payload.kind === "reaction" && payload.targetMessageID) {
        this.#emit({
          type: "e2ee_message_reaction",
          timestamp: Date.now(),
          threadId: String(threadId),
          messageId: payload.targetMessageID,
          senderId: String(senderId),
          reaction: payload.text,
          isE2EE: true,
        });
      } else if (payload.kind === "edit" && payload.targetMessageID) {
        this.#emit({
          type: "e2ee_message_edit",
          timestamp: Date.now(),
          threadId: String(threadId),
          messageId: payload.targetMessageID,
          senderId: String(senderId),
          body: payload.text,
          isE2EE: true,
        });
      } else if (payload.kind === "revoke" && payload.targetMessageID) {
        this.#emit({
          type: "e2ee_message_unsend",
          timestamp: Date.now(),
          threadId: String(threadId),
          messageId: payload.targetMessageID,
          senderId: String(senderId),
          isE2EE: true,
        });
      } else if (payload.kind === "text") {
        const message = {
          type: "e2ee_message" as const,
          timestamp: Date.now(),
          threadId: String(threadId),
          messageId,
          senderId: String(senderId),
          body: payload.text,
          isE2EE: true as const,
        };
        store.threads[String(threadId)] = true;
        store.appendHistory(String(threadId), {
          messageID: messageId,
          threadID: String(threadId),
          senderID: String(senderId),
          timestamp: message.timestamp,
          body: payload.text,
        });
        store.save();
        const isSelf = String(senderId) === String(this.#deps.userId);
        if (!isSelf || this.#deps.selfListen) {
          this.#emit(message);
        }
      }
    }

    this.#sendAck(node);
  }

  #emit(event: E2EEIncomingEvent): void {
    const onEvent = this.#deps.onEvent;
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch (err) {
      this.log.warn({ err }, "E2EE onEvent handler threw");
    }
  }

  #sendRetryReceipt(node: WANode): void {
    const id = node.attrs.id;
    const from = node.attrs.from;
    if (!id || !from) return;
    const store = this.#requireStore();
    const regBuf = Buffer.alloc(4);
    regBuf.writeUInt32BE(store.registrationId);
    const receiptAttrs: Record<string, string> = { id, to: from, type: "retry" };
    if (node.attrs.participant) receiptAttrs.participant = node.attrs.participant;
    this.#buildRetryKeysNode()
      .then((keysNode) =>
        this.#sendNode(
          binary.encodeNode("receipt", receiptAttrs, [
            binary.encodeNode("retry", {
              count: "1",
              id,
              t: String(Math.floor(Date.now() / 1000)),
              v: "1",
            }),
            binary.encodeNode("registration", {}, regBuf),
            keysNode,
          ]),
        ),
      )
      .catch((err) => {
        this.log.warn({ err }, "Could not send E2EE retry receipt");
      });
  }

  async #buildRetryKeysNode(): Promise<Buffer> {
    const store = this.#requireStore();
    const preKey = store.generatePreKeys(1)[0] as { id: number; pub: Buffer };
    const signed = store.signedPreKey as { id: number; pub: string; signature: string };
    const keyIdBytes = (id: number): Buffer => {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(id);
      return buf.subarray(1);
    };
    const deviceIdentity = new ProtoWriter()
      .bytes(1, Buffer.alloc(0))
      .bytes(2, Buffer.alloc(32))
      .bytes(3, Buffer.alloc(64))
      .bytes(4, Buffer.alloc(64))
      .build();
    return binary.encodeNode("keys", {}, [
      binary.encodeNode("type", {}, Buffer.from([5])),
      binary.encodeNode("identity", {}, store.identityPublic()),
      binary.encodeNode("key", {}, [
        binary.encodeNode("id", {}, keyIdBytes(preKey.id)),
        binary.encodeNode("value", {}, preKey.pub),
      ]),
      binary.encodeNode("skey", {}, [
        binary.encodeNode("id", {}, keyIdBytes(signed.id)),
        binary.encodeNode("value", {}, Buffer.from(signed.pub, "base64")),
        binary.encodeNode("signature", {}, Buffer.from(signed.signature, "base64")),
      ]),
      binary.encodeNode("device-identity", {}, deviceIdentity),
    ]);
  }

  #handleNotification(node: WANode): void {
    const type = node.attrs.type;
    if (type === "encrypt") {
      const rawContent = node.content;
      const children: ReadonlyArray<WANode | Buffer | string> = Array.isArray(rawContent)
        ? rawContent
        : rawContent !== undefined && rawContent !== null
          ? [rawContent]
          : [];
      let countNode: WANode | null = null;
      let identityNode: WANode | null = null;
      for (const child of children) {
        if (!child || typeof child !== "object" || Buffer.isBuffer(child)) continue;
        const el = child as WANode;
        if (el.tag === "count") countNode = el;
        else if (el.tag === "identity") identityNode = el;
      }
      if (countNode) {
        const count = parseInt(countNode.attrs.value || "0", 10);
        if (count < MIN_PREKEY_COUNT) {
          this.#uploadPreKeys(PREKEY_UPLOAD_COUNT).catch((err: Error) => {
            this.log.warn({ err }, "E2EE prekey upload failed");
          });
        }
      } else if (identityNode && node.attrs.from && this.#store) {
        const key = signal.addressKey(node.attrs.from);
        delete this.#store.sessions[key];
        this.#store.save();
        this.log.warn({ from: node.attrs.from }, "E2EE identity changed; dropped session");
      }
    } else if (type === "devices" && node.attrs.from) {
      this.#forgetDeviceList(node.attrs.from);
    }
    this.#sendAck(node);
  }

  #handleReceipt(node: WANode): void {
    if (node.attrs.type === "retry") {
      this.#resendForRetry(node);
    }
    this.#sendAck(node);
  }

  #resendForRetry(node: WANode): void {
    const retryNode = findNode(node, "retry");
    const messageId = (retryNode?.attrs.id as string | undefined) ?? (node.attrs.id as string | undefined);
    const cached = messageId ? this.#outboundCache[messageId] : undefined;
    if (!cached) {
      this.log.warn({ messageId }, "E2EE retry requested for unknown message");
      return;
    }
    const requester = node.attrs.participant ?? node.attrs.from;
    if (!requester) return;
    const retryCount = Number(retryNode?.attrs.count ?? "1") || 1;
    if (retryCount >= 10) {
      this.log.warn({ retryCount, messageId }, "Ignoring E2EE retry");
      return;
    }
    const store = this.#requireStore();
    const requesterParsed = signal.parseJid(requester);
    const sameUser = requesterParsed.user === this.#deps.userId;
    const transport = encodeMessageTransport({
      messageApp: cached.messageApp,
      ...(sameUser ? { dsm: { destinationJid: cached.threadJid, phash: "" } } : {}),
    });
    const keysNode = findNode(node, "keys");
    const registration = findChild(node, "registration");
    const bundle = keysNode ? bundleFromRetryKeys(node, keysNode, requesterParsed.device, registration) : null;
    const threadJid = cached.threadJid;
    const messageApp = cached.messageApp;
    const frankingTag = cached.frankingTag;
    void (async () => {
      if (bundle) {
        signal.establishSession(store, requester, bundle);
      } else if (!signal.hasSession(store, requester)) {
        const fetched = await this.#getPreKeyBundle(requester);
        signal.establishSession(store, requester, fetched);
      }
      const encrypted = signal.encrypt(store, requester, transport);
      const attrs: Record<string, string> = {
        to: threadJid,
        type: "text",
        id: messageId as string,
        device_fanout: "false",
        t: String(retryNode?.attrs.t ?? Math.floor(Date.now() / 1000)),
      };
      const encAttrs = { v: "3", type: encrypted.type, count: String(retryCount) };
      const messageNode = binary.encodeNode("message", attrs, [
        binary.encodeNode("enc", encAttrs, encrypted.ciphertext),
        binary.encodeNode("franking", {}, [
          binary.encodeNode("franking_tag", {}, frankingTag),
        ]),
      ]);
      await this.#sendNode(messageNode);
      void messageApp;
    })().catch((err: Error) => {
      this.log.warn({ err, messageId }, "E2EE retry resend failed");
    });
  }

  #handleIQ(node: WANode): void {
    const id = node.attrs.id;
    if (node.attrs.type === "get" && node.attrs.xmlns === "urn:xmpp:ping") {
      this.#sendNode(binary.encodeNode("iq", { id: id as string, to: node.attrs.from as string, type: "result" })).catch(
        () => undefined,
      );
      return;
    }
    if (!id) return;
    const pending = this.#pendingIQs.get(id);
    if (!pending) return;
    this.#pendingIQs.delete(id);
    if (node.attrs.type === "error") {
      const rawContent = node.content;
      const errorAttrs =
        rawContent &&
        typeof rawContent === "object" &&
        !Buffer.isBuffer(rawContent) &&
        !Array.isArray(rawContent)
          ? (rawContent as WANode).attrs
          : undefined;
      pending.reject(
        new Error(`E2EE IQ error: ${JSON.stringify(errorAttrs)} id=${id}`),
      );
    } else {
      pending.resolve(node);
    }
  }

  #sendAck(node: WANode): void {
    const id = node.attrs.id;
    if (!id) return;
    const attrs: Record<string, string> = { class: node.tag, id, to: node.attrs.from ?? "" };
    if (node.attrs.participant) attrs.participant = node.attrs.participant;
    if (node.attrs.recipient) attrs.recipient = node.attrs.recipient;
    if (node.tag !== "message" && node.attrs.type) attrs.type = node.attrs.type;
    this.#sendNode(binary.encodeNode("ack", attrs)).catch(() => undefined);
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#socket) return;
      this.#sendNode(
        binary.encodeNode("iq", {
          id: String(Date.now() % 1000),
          to: "s.whatsapp.net",
          type: "get",
          xmlns: "w:p",
        }),
      ).catch(() => undefined);
      this.#rawHeartbeat();
    }, 30000);
    this.#rawHeartbeat();
    this.#prekeyTimer = setInterval(() => {
      void this.#syncPreKeys();
    }, 1800000);
  }

  #rawHeartbeat(): void {
    this.#socket?.writeRaw(Buffer.from([0, 0, 0]));
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#prekeyTimer) clearInterval(this.#prekeyTimer);
    this.#heartbeatTimer = null;
    this.#prekeyTimer = null;
  }

  #readLoop(): void {
    const pump = (): void => {
      if (!this.#socket) return;
      this.#socket.readFrame().then(
        (frame: Buffer) => {
          try {
            this.#handleFrame(frame);
          } catch (err) {
            this.log.warn({ err }, "E2EE frame handling failed");
          }
          pump();
        },
        (err: Error) => {
          if (this.#connected) {
            this.#connected = false;
            this.#connectPromise = null;
            this.#socket = null;
            this.#stopHeartbeat();
            this.log.warn({ err }, "E2EE socket closed");
          }
        },
      );
    };
    pump();
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function bundleFromRetryKeys(
  node: WANode,
  keysNode: WANode,
  deviceId: number,
  registration: WANode | null,
): signal.PreKeyBundle | null {
  const identity = findNode(keysNode, "identity");
  const keyNode = findNode(keysNode, "key");
  const skeyNode = findNode(keysNode, "skey");
  if (!identity || !skeyNode) return null;
  const signedValue = findNode(skeyNode, "value");
  const signedSignature = findNode(skeyNode, "signature");
  if (!signedValue || !signedSignature) return null;
  const readId = (keyNodeValue: WANode | null): number => {
    const content = keyNodeValue?.content;
    if (!content || !Buffer.isBuffer(content) || content.length === 0) return 0;
    return content.readUIntBE(0, Math.min(content.length, 3));
  };
  const prefixed = (keyNodeValue: WANode | null): Buffer => {
    const buf = Buffer.from((keyNodeValue?.content as Buffer | undefined) ?? Buffer.alloc(0));
    return buf.length === 32 ? Buffer.concat([Buffer.from([5]), buf]) : buf;
  };
  const bundle: signal.PreKeyBundle = {
    registrationId:
      registration && Buffer.isBuffer(registration.content) && registration.content.length === 4
        ? registration.content.readUInt32BE(0)
        : 0,
    deviceId,
    identityKey: Buffer.from(identity.content as Buffer),
    signedPreKey: {
      keyId: readId(findNode(skeyNode, "id")),
      publicKey: prefixed(signedValue),
      signature: Buffer.from(signedSignature.content as Buffer),
    },
    ...(findNode(keyNode, "value")?.content
      ? { preKey: { keyId: readId(findNode(keyNode, "id")), publicKey: prefixed(findNode(keyNode, "value")) } }
      : {}),
  };
  return bundle;
}

export { EncryptedFrameSocket };
