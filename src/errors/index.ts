/**
 * Typed error hierarchy.
 *
 * Everything the library throws is a `LibraryError`. Each error carries a
 * machine-readable `code`, a `retryable` flag telling callers whether a retry
 * could plausibly succeed, and a `context` object with non-secret details.
 *
 * Never branch on `message` — it is for humans and may change between
 * releases. Branch on `code` or use `instanceof`.
 */

/** Machine-readable error codes. */
export type ErrorCode =
  // Authentication
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_SESSION_EXPIRED"
  | "AUTH_LOGIN_REJECTED"
  // Cookies
  | "COOKIE_MISSING"
  | "COOKIE_EXPIRED"
  | "COOKIE_MALFORMED"
  // Session
  | "SESSION_NOT_AUTHENTICATED"
  | "SESSION_INVALID_STATE"
  | "SESSION_CORRUPT"
  // Transport
  | "TRANSPORT_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  // Input validation
  | "VALIDATION_FAILED"
  // Permissions
  | "PERMISSION_DENIED"
  | "PERMISSION_NOT_ADMIN"
  | "PERMISSION_NOT_PARTICIPANT"
  | "PERMISSION_BLOCKED"
  // Facebook API errors
  | "API_ERROR"
  | "API_RATE_LIMIT"
  | "MEDIA_NOT_FOUND"
  | "ATTACHMENT_URL_UNAVAILABLE"
  // MQTT
  | "MQTT_CONNECTION_FAILED"
  | "MQTT_PROTOCOL_ERROR"
  | "MQTT_QUEUE_OVERFLOW"
  | "MQTT_NOT_CONNECTED"
  // Plugins
  | "PLUGIN_LOAD_FAILED"
  | "PLUGIN_LIFECYCLE_FAILED";

export interface LibraryErrorOptions {
  /** Whether a retry of the failed operation could plausibly succeed. */
  retryable?: boolean | undefined;
  /** Non-secret structured details attached to the error. */
  context?: Record<string, unknown> | undefined;
  /** The underlying cause, if any. */
  cause?: unknown;
}

/**
 * Base class of every error thrown by this library.
 */
export class LibraryError extends Error {
  /** Machine-readable code. Stable across releases. */
  readonly code: ErrorCode;

  /** Whether a retry could plausibly succeed. */
  readonly retryable: boolean;

  /** Non-secret structured details. */
  readonly context: Record<string, unknown>;

  constructor(
    message: string,
    code: ErrorCode,
    options: LibraryErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.context = options.context ?? {};
  }

  /** JSON-safe representation, used when errors are logged or serialized. */
  toJSON(): { name: string; code: ErrorCode; message: string; retryable: boolean; context: Record<string, unknown> } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }

  /**
   * Wraps an unknown thrown value into a `LibraryError`. Values that already
   * are `LibraryError` instances pass through unchanged.
   */
  static wrap(value: unknown, fallbackCode: ErrorCode, message?: string): LibraryError {
    if (value instanceof LibraryError) {
      return value;
    }
    const detail = value instanceof Error ? value.message : String(value);
    return new LibraryError(message ?? `Unexpected failure: ${detail}`, fallbackCode, {
      retryable: false,
      cause: value,
      context: value instanceof Error ? { originalName: value.name } : {},
    });
  }
}

/**
 * Login was rejected, or the session is no longer accepted by Facebook.
 */
export class AuthenticationError extends LibraryError {
  constructor(message: string, code: ErrorCode, options: LibraryErrorOptions = {}) {
    super(message, code, options);
  }
}

/**
 * A cookie problem: missing required cookie, expired cookie, or input that
 * cannot be parsed into cookies at all.
 */
export class CookieError extends LibraryError {
  constructor(message: string, code: ErrorCode, options: LibraryErrorOptions = {}) {
    super(message, code, options);
  }
}

/**
 * The session is in a state that forbids the requested operation, or
 * persisted session state is unusable.
 */
export class SessionError extends LibraryError {
  constructor(message: string, code: ErrorCode, options: LibraryErrorOptions = {}) {
    super(message, code, options);
  }
}

/**
 * Base class for HTTP transport failures.
 */
export class TransportError extends LibraryError {
  constructor(message: string, code: ErrorCode, options: LibraryErrorOptions = {}) {
    super(message, code, options);
  }
}

/**
 * A network-level failure: DNS, TCP, TLS, connection refused or reset.
 */
export class NetworkError extends TransportError {
  constructor(message: string, options: LibraryErrorOptions = {}) {
    super(message, "NETWORK_ERROR", { ...options, retryable: options.retryable ?? true });
  }
}

/**
 * A request exceeded the configured timeout.
 */
export class TimeoutError extends TransportError {
  constructor(message: string, options: LibraryErrorOptions = {}) {
    super(message, "TIMEOUT", { ...options, retryable: options.retryable ?? true });
  }
}

/**
 * Invalid input to a public method.
 */
export class ValidationError extends LibraryError {
  constructor(message: string, options: LibraryErrorOptions = {}) {
    super(message, "VALIDATION_FAILED", options);
  }
}

/**
 * The authenticated account lacks permission for the operation: not an
 * admin, not a participant, blocked, or the target is unreachable.
 */
export class PermissionError extends LibraryError {
  constructor(message: string, code: ErrorCode, options: LibraryErrorOptions = {}) {
    super(message, code, options);
  }
}

/**
 * Facebook returned a structured error payload.
 */
export class APIError extends LibraryError {
  constructor(message: string, code: ErrorCode, options: LibraryErrorOptions = {}) {
    super(message, code, options);
  }
}

/**
 * MQTT connection or protocol failure.
 */
export class MQTTError extends LibraryError {
  constructor(message: string, code: ErrorCode, options: LibraryErrorOptions = {}) {
    super(message, code, options);
  }
}

/**
 * Plugin registration or lifecycle failure.
 */
export class PluginError extends LibraryError {
  constructor(message: string, code: ErrorCode, options: LibraryErrorOptions = {}) {
    super(message, code, options);
  }
}
