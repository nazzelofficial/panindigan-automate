/**
 * Tests for the structured MQTT dial diagnostic.
 *
 * A WebSocket close code is NOT an HTTP upgrade status, and an unavailable
 * field is `null` — never guessed or derived from message parsing. These
 * tests pin those invariants and the redaction of handshake headers.
 */

import { describe, expect, it } from "vitest";
import {
  formatMqttDiagnostic,
  sanitizeMqttDiagnosticText,
  isValidMqttWsUrl,
  type MqttDialDiagnostic,
} from "../src/index.js";

const base: MqttDialDiagnostic = {
  stage: "websocket-close",
  region: "hil",
  attempt: 1,
  connectionId: "1-abc12345",
  elapsedMs: 742,
  upgradeStatus: null,
  upgradeStatusText: null,
  wsCloseCode: 1002,
  wsCloseReason: "protocol error",
  socketErrorCode: null,
  socketErrorMessage: null,
  mqttPacketType: null,
  mqttReturnCode: null,
  subProtocol: "mqttv3.1",
  url: "wss://edge-chat.facebook.com/chat?region=hil&sid=123&cid=abc",
  handshakeHeaders: { origin: "[present]", cookie: "[REDACTED]" },
};

describe("formatMqttDiagnostic", () => {
  it("reports the real stage and WebSocket close code", () => {
    const line = formatMqttDiagnostic(base);
    expect(line).toContain("stage=websocket-close");
    expect(line).toContain("wsCloseCode=1002");
    expect(line).toContain("region=hil");
    expect(line).toContain("elapsedMs=742");
  });

  it("does NOT invent an upgradeStatus when none was observed", () => {
    const line = formatMqttDiagnostic(base);
    expect(line).not.toContain("upgradeStatus=");
    expect(line).not.toContain("socketErrorCode=");
  });

  it("reports an observed HTTP upgrade rejection separately from a close code", () => {
    const line = formatMqttDiagnostic({
      ...base,
      stage: "websocket-upgrade",
      upgradeStatus: 403,
      upgradeStatusText: "Forbidden",
      wsCloseCode: null,
      wsCloseReason: null,
    });
    expect(line).toContain("stage=websocket-upgrade");
    expect(line).toContain("upgradeStatus=403");
    expect(line).toContain("upgradeStatusText=Forbidden");
    expect(line).not.toContain("wsCloseCode=");
  });

  it("reports CONNACK return codes distinctly", () => {
    const line = formatMqttDiagnostic({
      ...base,
      stage: "mqtt-connack",
      mqttPacketType: "connack",
      mqttReturnCode: 5,
      wsCloseCode: null,
      wsCloseReason: null,
    });
    expect(line).toContain("stage=mqtt-connack");
    expect(line).toContain("mqttPacketType=connack");
    expect(line).toContain("mqttReturnCode=5");
  });

  it("never includes handshake header values in the formatted line", () => {
    const line = formatMqttDiagnostic(base);
    expect(line).not.toContain("[REDACTED]");
    expect(line).not.toContain("cookie=");
    expect(line).not.toContain("origin=");
  });

  it("distinguishes timeout from immediate rejection", () => {
    expect(formatMqttDiagnostic({ ...base, stage: "connack-timeout", elapsedMs: 10000 }))
      .toContain("stage=connack-timeout");
    expect(formatMqttDiagnostic({ ...base, stage: "socket-error", socketErrorCode: "ECONNREFUSED" }))
      .toContain("socketErrorCode=ECONNREFUSED");
  });

  it("includes attempt and connectionId for correlating retries", () => {
    const line = formatMqttDiagnostic({ ...base, attempt: 4, connectionId: "4-deadbeef" });
    expect(line).toContain("attempt=4");
    expect(line).toContain("connectionId=4-deadbeef");
  });
});

describe("MQTT diagnostic security and URL validation", () => {
  it("redacts cookie values and sensitive query params from free-text errors", () => {
    const clean = sanitizeMqttDiagnosticText(
      'upgrade failed c_user=61596880191204 xs=secret wss://edge-chat.facebook.com/chat?sid=123&cid=abc',
    );
    expect(clean).not.toContain("61596880191204");
    expect(clean).not.toContain("secret");
    expect(clean).not.toContain("sid=123");
    expect(clean).toContain("[REDACTED]");
  });

  it("returns null for unavailable text rather than inventing a value", () => {
    expect(sanitizeMqttDiagnosticText(null)).toBeNull();
    expect(sanitizeMqttDiagnosticText(undefined)).toBeNull();
    expect(sanitizeMqttDiagnosticText("")).toBeNull();
  });

  it("accepts a valid wss URL and rejects malformed ones", () => {
    expect(isValidMqttWsUrl("wss://edge-chat.facebook.com/chat?region=hil&sid=1&cid=x")).toBe(true);
    expect(isValidMqttWsUrl("ws://edge-chat.facebook.com/chat")).toBe(false);
    expect(isValidMqttWsUrl("not a url")).toBe(false);
    expect(isValidMqttWsUrl("wss://edge-chat.facebook.com/chat\nX- evil: 1")).toBe(false);
  });

  it("reports the negotiated sub-protocol and dialed URL in the diagnostic", () => {
    const line = formatMqttDiagnostic(base);
    expect(line).toContain("subProtocol=mqttv3.1");
    expect(line).toContain("url=wss://edge-chat.facebook.com/chat");
  });

  it("keeps the observed puback parser warning as a warning, not a disconnect", () => {
    // Before 0.2.7 this warning was logged while the connection stayed up and
    // login succeeded. Treating it as fatal made every region cycle forever.
    const message = "Invalid header flag bits, must be 0x0 for puback packet";
    expect(sanitizeMqttDiagnosticText(message)).toBe(message);
  });
});
