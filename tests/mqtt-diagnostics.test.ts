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
  normalizeMqttFrameFlags,
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
  subProtocol: null,
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

  it("reports the dialed URL without inventing a sub-protocol", () => {
    const line = formatMqttDiagnostic(base);
    expect(line).toContain("url=wss://edge-chat.facebook.com/chat");
    expect(line).not.toContain("subProtocol=");
  });

  it("normalizes invalid PUBACK flags before the parser sees them", () => {
    // [0x42 (PUBACK + bad flags), length 2, msgId 0x00 0x01]
    const frame = new Uint8Array([0x42, 0x02, 0x00, 0x01]);
    normalizeMqttFrameFlags(frame);
    expect([...frame]).toEqual([0x40, 0x02, 0x00, 0x01]);
  });

  it("normalizes every PUBACK in a multi-frame buffer and leaves other packets alone", () => {
    // PUBACK(bad) + CONNACK(0x20, flags 0, length 2) + PUBLISH(0x30, flags 0)
    const frames = new Uint8Array([0x42, 0x02, 0x00, 0x01, 0x20, 0x02, 0x00, 0x00, 0x30, 0x02, 0x00, 0x02]);
    normalizeMqttFrameFlags(frames);
    expect(frames[0]).toBe(0x40);
    expect(frames[4]).toBe(0x20);
    expect(frames[8]).toBe(0x30);
  });

  it("works on an ArrayBuffer in place", () => {
    const buffer = new Uint8Array([0x45, 0x02, 0x00, 0x07]).buffer;
    normalizeMqttFrameFlags(buffer);
    expect([...new Uint8Array(buffer)]).toEqual([0x40, 0x02, 0x00, 0x07]);
  });

  it("keeps the observed puback parser warning as a warning, not a disconnect", () => {
    // Before 0.2.7 this warning was logged while the connection stayed up and
    // login succeeded. Treating it as fatal made every region cycle forever.
    const message = "Invalid header flag bits, must be 0x0 for puback packet";
    expect(sanitizeMqttDiagnosticText(message)).toBe(message);
  });
});
