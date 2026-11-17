/**
 * Suspension Signal Detector.
 *
 * Matches Facebook's restriction surfaces across HTTP responses, GraphQL
 * errors, MQTT deltas, and raw text against a catalog of real restriction
 * signals. Every pattern here corresponds to a documented Facebook error
 * code or a message Facebook actually serves; nothing is invented.
 *
 * Output is a typed `SuspensionSignal` with severity:
 *   warn < pause < halt < critical
 */

import type { SuspensionSignal, SuspensionSeverity } from "./index.js";

interface RestrictionInfo {
  readonly severity: SuspensionSeverity;
  readonly message: string;
}

/** Facebook error codes with verified restriction meaning. */
const RESTRICTION_ERROR_CODES: Readonly<Record<number, RestrictionInfo>> = {
  // Authentication & session
  1357001: { severity: "critical", message: "Not logged in" },
  1357004: { severity: "critical", message: "Session too stale — fb_dtsg must be refreshed" },
  392024945: { severity: "critical", message: "Checkpoint required" },
  459: { severity: "critical", message: "Session invalidated (authenticator removed)" },
  460: { severity: "critical", message: "Password changed elsewhere" },
  463: { severity: "critical", message: "Session expired" },
  467: { severity: "critical", message: "Invalid session" },
  102: { severity: "critical", message: "API session error" },
  190: { severity: "critical", message: "Access token invalid or expired" },
  170: { severity: "critical", message: "Session invalidated (account security event)" },
  2500: { severity: "critical", message: "Account disabled" },

  // Rate limiting & abuse
  368: { severity: "halt", message: "Temporarily blocked from action (abuse policy)" },
  1675035: { severity: "halt", message: "Too many requests" },
  341: { severity: "pause", message: "Rate limited — slow down" },
  506: { severity: "halt", message: "Duplicate post / spam heuristic" },

  // Messaging restrictions
  2061011: { severity: "halt", message: "Cannot send messages in this conversation" },
  1545012: { severity: "pause", message: "Not a participant in the conversation" },
  1545014: { severity: "pause", message: "Cannot message this account" },
  1545003: { severity: "halt", message: "Action only available in group threads" },
  1357031: { severity: "halt", message: "Operation blocked by policy (permission denied)" },

  // Permissions & policy
  200: { severity: "halt", message: "Permission denied" },
  197: { severity: "halt", message: "Login approval / permission required" },
};

interface TextPattern {
  readonly pattern: RegExp;
  readonly severity: SuspensionSeverity;
  readonly message: string;
}

/** String patterns Facebook actually renders or returns. */
const RESTRICTION_PATTERNS: readonly TextPattern[] = [
  // Checkpoint & verification
  { pattern: /checkpoint|two_step_verification|identity_verification/i, severity: "critical", message: "Checkpoint or verification required" },
  { pattern: /confirm.*identity|verify.*(your )?account/i, severity: "critical", message: "Identity confirmation required" },
  { pattern: /unusual (activity|login)|suspicious (login|activity|sign.?in)/i, severity: "critical", message: "Unusual activity flagged" },
  { pattern: /help us (secure|confirm)|to keep your account safe/i, severity: "critical", message: "Facebook asked for account verification" },

  // Rate limiting
  { pattern: /too many requests|rate limit|rate-limit(ed)?/i, severity: "halt", message: "Rate limit detected" },
  { pattern: /temporarily blocked|action blocked|temporarily restricted/i, severity: "halt", message: "Temporarily blocked from action" },
  { pattern: /try again later|please wait/i, severity: "pause", message: "Temporary restriction" },
  { pattern: /slow down|too quickly|spamming/i, severity: "pause", message: "Pace too fast — slow down" },

  // Spam & abuse
  { pattern: /spam|abusive behavior|abusive/i, severity: "halt", message: "Flagged as spam or abuse" },
  { pattern: /suspicious activity/i, severity: "halt", message: "Suspicious activity flag" },
  { pattern: /community standards|against (our )?(policies|terms)/i, severity: "critical", message: "Policy violation wording detected" },

  // Session issues
  { pattern: /not logged in|login required|please log in|session expired/i, severity: "critical", message: "Session no longer valid" },
  { pattern: /invalid session|session (has )?(error|expired|invalidated)/i, severity: "critical", message: "Session error" },
  { pattern: /log ?out|signed out/i, severity: "warn", message: "Session appears signed out" },

  // Account status
  { pattern: /account (has been )?(disabled|suspended|restricted|locked)/i, severity: "critical", message: "Account restricted or disabled" },
  { pattern: /violate.*(standards|policies|terms)/i, severity: "critical", message: "Policy violation" },

  // Messaging restrictions
  { pattern: /can'?t send messages|messaging.*(disabled|restricted)/i, severity: "halt", message: "Messaging restricted" },
  { pattern: /message request|can'?t reply|blocked this conversation/i, severity: "warn", message: "Conversation participation restricted" },
];

/** HTTP status codes with restriction meaning. */
const RESTRICTION_STATUS_CODES: Readonly<Record<number, RestrictionInfo>> = {
  403: { severity: "halt", message: "Forbidden — access denied" },
  429: { severity: "halt", message: "Too many requests" },
  503: { severity: "warn", message: "Service temporarily unavailable" },
};

function makeSignal(
  type: string,
  severity: SuspensionSeverity,
  message: string,
  context: Record<string, unknown>,
  code?: number | string,
): SuspensionSignal {
  const signal: SuspensionSignal = {
    type,
    severity,
    message,
    timestamp: Date.now(),
    context,
    ...(code !== undefined ? { code } : {}),
  };
  return signal;
}

/**
 * Detects suspension signals from every surface Facebook can emit them on.
 */
export class SuspensionDetector {
  /** Signals from an HTTP response (status, headers, body). */
  detectFromHTTP(args: {
    status: number;
    body: string;
    headers?: Readonly<Record<string, string>> | undefined;
  }): SuspensionSignal | null {
    const { status, body, headers } = args;

    const statusSignal = RESTRICTION_STATUS_CODES[status];
    if (statusSignal !== undefined) {
      return makeSignal("http_status", statusSignal.severity, statusSignal.message, { status, bodyLength: body.length }, status);
    }

    if (headers?.["retry-after"] !== undefined) {
      return makeSignal("rate_limit_header", "halt", "Rate limit with Retry-After header", {
        retryAfter: headers["retry-after"],
        status,
      });
    }

    for (const { pattern, severity, message } of RESTRICTION_PATTERNS) {
      if (pattern.test(body)) {
        return makeSignal("body_pattern", severity, message, { pattern: pattern.source, status });
      }
    }

    return null;
  }

  /** Signals from a structured Facebook API/GraphQL error. */
  detectFromAPIError(args: {
    code?: number | string | undefined;
    message?: string | undefined;
    errorSummary?: string | undefined;
    errorDescription?: string | undefined;
  }): SuspensionSignal | null {
    const { code, message, errorSummary, errorDescription } = args;

    if (typeof code === "number") {
      const errorInfo = RESTRICTION_ERROR_CODES[code];
      if (errorInfo !== undefined) {
        return makeSignal("api_error_code", errorInfo.severity, errorInfo.message, {
          code,
          summary: errorSummary,
          description: errorDescription,
        }, code);
      }
    }

    const textToCheck = [message, errorSummary, errorDescription].filter(Boolean).join(" ");
    if (textToCheck.length > 0) {
      for (const { pattern, severity, message: msg } of RESTRICTION_PATTERNS) {
        if (pattern.test(textToCheck)) {
          return makeSignal("api_error_message", severity, msg, { originalMessage: textToCheck.slice(0, 200) }, code);
        }
      }
    }

    return null;
  }

  /** Signals from an MQTT delta or control payload. */
  detectFromMQTTPayload(topic: string, payload: unknown): SuspensionSignal | null {
    if (typeof payload !== "object" || payload === null) {
      return null;
    }
    const obj = payload as Record<string, unknown>;

    if (typeof obj["error"] === "number") {
      const errorInfo = RESTRICTION_ERROR_CODES[obj["error"]];
      if (errorInfo !== undefined) {
        return makeSignal("mqtt_error", errorInfo.severity, errorInfo.message, { topic, code: obj["error"] }, obj["error"]);
      }
    }

    if (topic === "/t_ms") {
      const errorCode = obj["errorCode"];
      if (errorCode === "ERROR_QUEUE_OVERFLOW" || errorCode === "ERROR_QUEUE_NOT_FOUND") {
        return makeSignal("mqtt_queue_error", "warn", `MQTT queue error: ${String(errorCode)}`, { errorCode });
      }
    }

    // Text patterns are only meaningful on the control plane; the data
    // plane carries user content, where a word like "spam" in chat must
    // never halt the bot. Restrict the scan accordingly.
    if (/^\/(t_ms|ls_req|ls_resp|orca_|foreground_state|browser_close)/.test(topic)) {
      const text = JSON.stringify(payload);
      for (const { pattern, severity, message } of RESTRICTION_PATTERNS) {
        if (pattern.test(text)) {
          return makeSignal("mqtt_pattern", severity, message, { topic, pattern: pattern.source });
        }
      }
    }

    return null;
  }

  /** Last-resort raw text scan. */
  detectFromText(text: string, source: string): SuspensionSignal | null {
    for (const { pattern, severity, message } of RESTRICTION_PATTERNS) {
      if (pattern.test(text)) {
        return makeSignal("text_pattern", severity, message, { source, pattern: pattern.source });
      }
    }
    return null;
  }

  /** True when the code means Facebook demands an identity verification. */
  isCheckpoint(code: number): boolean {
    if (code === 392024945) {
      return true;
    }
    const info = RESTRICTION_ERROR_CODES[code];
    return info?.severity === "critical" && /checkpoint|verification|approval/i.test(info.message);
  }

  /** True when the code means the session is dead or stale. */
  isSessionExpired(code: number): boolean {
    return code === 1357001 || code === 1357004 || code === 459 || code === 463 || code === 467;
  }
}

/** Shared detector instance (stateless). */
export const detector = new SuspensionDetector();
