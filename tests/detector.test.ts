/**
 * Regression tests for suspension-signal detection.
 *
 * The 0.3.0 deployment scanned /t_ms (a data-plane topic carrying message
 * bodies) with restriction patterns. Ordinary chat text containing words like
 * "checkpoint" produced critical signals that halted the bot for 24 hours.
 */

import { describe, expect, it } from "vitest";
import { SuspensionDetector } from "../src/index.js";

const detector = new SuspensionDetector();

describe("SuspensionDetector — data plane must not halt the bot", () => {
  it("ignores restriction wording in /t_ms message bodies", () => {
    const payload = {
      deltas: [
        {
          deltaMessageBody: JSON.stringify({
            body: "please log in to check the checkpoint — session expired",
          }),
        },
      ],
    };
    expect(detector.detectFromMQTTPayload("/t_ms", payload)).toBeNull();
  });

  it("ignores restriction wording in /orca_* notifications", () => {
    const payload = { body: "this looks like spam, account restricted" };
    expect(detector.detectFromMQTTPayload("/orca_message_notifications", payload)).toBeNull();
  });

  it("still detects restriction wording on control-plane topics", () => {
    const payload = { error: "checkpoint required" };
    const signal = detector.detectFromMQTTPayload("/ls_resp", payload);
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("mqtt_pattern");
    expect(signal?.severity).toBe("critical");
  });

  it("still detects numeric restriction codes on /t_ms", () => {
    // Control information inside a delta is still a real signal.
    const signal = detector.detectFromMQTTPayload("/t_ms", { error: 1357004 });
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("mqtt_error");
  });
});
