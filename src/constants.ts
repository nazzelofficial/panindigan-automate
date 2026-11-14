/**
 * Protocol and library constants.
 *
 * Everything Facebook-specific that the library needs to talk to Messenger
 * lives here: endpoints, GraphQL document IDs, MQTT topics, and the default
 * headers. When Facebook rotates a value, this file is the single place to
 * patch.
 */

/** Library name, used in loggers and the MQTT client identification. */
export const LIBRARY_NAME = "panindigan-automate";

/** Library version. Mirrors package.json. */
export const VERSION = "0.1.2";

/**
 * Default User-Agent: a reduced Chrome UA string. The major version is kept
 * current; platform tokens are omitted exactly like the browser does.
 */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Facebook web host serving the HTML and AJAX endpoints. */
export const FB_BASE_URL = "https://www.facebook.com";

/** Facebook upload host serving attachment uploads. */
export const FB_UPLOAD_URL = "https://upload.facebook.com";

/** Default MQTT-over-WebSocket endpoint. */
export const MQTT_WS_URL = "wss://edge-chat.facebook.com/chat";

/** Fallback MQTT regions, tried when the account's region is unknown. */
export const MQTT_FALLBACK_REGIONS = [
  "prn",
  "pnb",
  "vll",
  "hkg",
  "sin",
  "ftw",
  "ash",
] as const;

/**
 * MQTT topics subscribed on every (re)connect. Facebook delivers sync
 * payloads, typing and presence notifications across these.
 */
export const MQTT_TOPICS = [
  "/ls_req",
  "/ls_resp",
  "/legacy_web",
  "/webrtc",
  "/rtc_multi",
  "/onevc",
  "/br_sr",
  "/sr_res",
  "/t_ms",
  "/thread_typing",
  "/orca_typing_notifications",
  "/notify_disconnect",
  "/orca_presence",
  "/inbox",
  "/mercury",
  "/messaging_events",
  "/orca_message_notifications",
  "/pp",
  "/webrtc_response",
] as const;

/** Sync queue creation, published once per connection. */
export const TOPIC_SYNC_CREATE_QUEUE = "/messenger_sync_create_queue";

/** Sync diff fetch, published on reconnects that still hold a sync token. */
export const TOPIC_SYNC_GET_DIFFS = "/messenger_sync_get_diffs";

/** Main delta stream; payloads carry sequence ids and sync tokens. */
export const TOPIC_MS = "/t_ms";

/** Lightweight-service request/response topics (edits, typing, tasks). */
export const TOPIC_LS_REQ = "/ls_req";
export const TOPIC_LS_RESP = "/ls_resp";

/** Marks the client foreground, so presence is emitted for it. */
export const TOPIC_FOREGROUND_STATE = "/foreground_state";

/** Client capability flags published after connecting. */
export const TOPIC_CLIENT_SETTINGS = "/set_client_settings";

/** Graceful-close signal published before ending a healthy connection. */
export const TOPIC_BROWSER_CLOSE = "/browser_close";

/** Read-state marking over MQTT. */
export const TOPIC_MARK_THREAD = "/mark_thread";

/** Facebook's web-messenger application ID (MQTT `aid`). */
export const FB_CHAT_APP_ID = "219994525426954";

/** The lightweight-service application ID used for `/ls_req` tasks. */
export const FB_LS_APP_ID = "2220391788200892";

/** GraphQL document IDs for the endpoints the library queries. */
export const DOC_IDS = {
  /**
   * Thread list and inbox sync sequence id. `MessengerGraphQLThreadlistFetcher`
   * batch; `includeSeqID: true` yields `sync_sequence_id` for MQTT.
   */
  threadList: "3336396659757871",
  /** Thread information via the `MessengerGraphQLThreadFetcher` batch. */
  threadInfo: "3449967031715030",
  /** Message history for one thread. */
  threadHistory: "1498317363570230",
  /** Message reactions (add/remove). */
  reaction: "1491398900900362",
  /** Forced fetch of a specific delta's full payload. */
  forcedFetch: "2848441488556444",
} as const;

/** Batch names paired with the GraphQL document IDs above. */
export const BATCH_NAMES = {
  threadList: "MessengerGraphQLThreadlistFetcher",
  threadInfo: "MessengerGraphQLThreadFetcher",
} as const;

/** Sync protocol version sent in the sync queue creation payload. */
export const SYNC_API_VERSION = 11;

/** Maximum deltas requested per sync queue connection. */
export const SYNC_MAX_DELTAS = 100;

/** Delta batch size requested per sync queue connection. */
export const SYNC_DELTA_BATCH_SIZE = 500;

/** Maximum message body length accepted by Messenger. */
export const MESSAGE_MAX_LENGTH = 20_000;

/** Maximum number of user IDs per `getUser` batch request. */
export const USER_INFO_BATCH_LIMIT = 200;

/** Default TTLs, in seconds, for cache entity types. */
export const CACHE_TTL_SECONDS = {
  thread: 300,
  user: 3_600,
  message: 120,
  attachmentUrl: 3_600,
  presence: 30,
} as const;

/** Tag names usable for cache tag-based invalidation. */
export const CACHE_TAGS = {
  thread: "thread",
  user: "user",
  message: "message",
  attachmentUrl: "attachment-url",
  presence: "presence",
} as const;

/** Official Messenger thread colors accepted by the color mutation. */
export const THREAD_COLORS = {
  MessengerBlue: "0000ff",
  GoldenPoppy: "f2ba0c",
  RadicalRed: "f44236",
  ShoobertShoe: "a442f4",
  Pumpkin: "fa810d",
  LightBlue: "5ec1ff",
  BrightPink: "ff5ca1",
  OrangeSoda: "ff7f4b",
  NeonGreen: "5bfbaa",
  Aqua: "30d5c8",
  RobinsEggBlue: "00c6ff",
  RoseGold: "f5b9d4",
  LavenderPurple: "bdaef4",
  Mango: "ffc300",
  NeonBlue: "1987ff",
  LightGreen: "9ef5c6",
  PicnicGreen: "54d267",
  PinkHeart: "ffafbe",
  GrayBlue: "adaff4",
  Cleopatra: "ffb379",
  SteelBlue: "6b98f4",
  Periwinkle: "8c9fd6",
  Coral: "fa9e91",
  Salmon: "ff8f80",
  NeonRose: "ff5c8d",
  NeonMint: "9fffce",
  SpaceBlack: "000000",
  Cardinal: "d51b21",
  Deer: "a95065",
  WildSand: "d5d0cd",
  Fern: "55ae4c",
  Copper: "c97941",
  Saffron: "ffb673",
  CeruleanBlue: "0072d6",
  ShockingOrange: "ff7c40",
  FuchsiaPink: "e85ab4",
  RobinsEgg: "00c8c8",
  Bamboo: "d0c8b2",
  OldPricetag: "837775",
  BrightTeal: "28cfd1",
  GreenApple: "4bd677",
  DeepOrange: "ff5722",
  ArcticWhite: "f0f0f4",
  Antelope: "caaca2",
  Gray: "a0a0a0",
  Cantaloupe: "ffa900",
  Banana: "ffe600",
  Avocado: "a9d34a",
  Lime: "b7dc1c",
  Blueberry: "00a1f1",
  BlueJay: "4a9cf5",
  DeepPurple: "8a2be2",
  Amethyst: "9b59b6",
  Ruby: "e0115f",
  DeepPink: "ff1493",
  Mandarin: "ff7847",
  OrangePeel: "ff9f00",
  NeonCarrot: "ff9933",
  CadmiumYellow: "fff600",
  Eggplant: "614051",
  Coffee: "6f4e37",
  Mocha: "967259",
} as const;

/** Reaction emoji shortcuts accepted by `addReaction`. */
export const REACTION_EMOJI = {
  like: "\u{1F44D}",
  love: "\u{1F60D}",
  haha: "\u{1F606}",
  wow: "\u{1F62E}",
  sad: "\u{1F622}",
  angry: "\u{1F620}",
} as const;

/** Cookie names required for an authenticated session. */
export const REQUIRED_COOKIES = ["c_user", "xs", "datr"] as const;

/** Cookie domain used for all Facebook requests. */
export const FB_COOKIE_DOMAIN = ".facebook.com";

/** Facebook URLs the cookie jar is scoped to. */
export const FB_COOKIE_URLS = [
  "https://www.facebook.com",
  "https://facebook.com",
  "https://messenger.com",
] as const;

/**
 * How far from expiry (ms) `xs`/`datr` must be before the session manager
 * schedules a cookie refresh.
 */
export const COOKIE_REFRESH_LEAD_TIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Interval between cookie expiry checks while a session is active. */
export const COOKIE_REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Storage keys used by the session persistence layer. */
export const STORAGE_KEYS = {
  session: "session",
  cookies: "cookies",
} as const;

/** How long to wait for the first `/t_ms` before treating a fresh MQTT
 * connection as broken and cycling it. */
export const TMS_TIMEOUT_MS = 5_000;

/** MQTT CONNECT timeout; short so region fallback rotates quickly. */
export const MQTT_CONNECT_TIMEOUT_MS = 5_000;

/** Default timeout for lightweight-service (`/ls_req`) responses. */
export const LS_REQUEST_TIMEOUT_MS = 10_000;

/** Default storage directory for the file adapter. */
export const DEFAULT_STORAGE_DIRECTORY = "./panindigan-session";
