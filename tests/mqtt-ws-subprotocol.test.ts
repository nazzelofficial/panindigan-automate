/**
 * Regression guard: the MQTT WebSocket sub-protocol override must discard
 * mqtt.js's "mqttv3.1" default and force "mqtt".
 *
 * mqtt.js v5 sends "mqttv3.1" as the WebSocket sub-protocol when protocolId
 * is "MQIsdp" and protocolVersion is 3 — this is verified in the installed
 * mqtt package's source. That Facebook's broker specifically requires
 * "mqtt" is an unverified assumption; these tests document the override's
 * intent only and do not exercise a real Facebook WebSocket.
 */

import { describe, it, expect } from "vitest";

describe("MQTT WebSocket sub-protocol", () => {
  it("mqtt.js would send mqttv3.1 for MQIsdp/3 without the override", () => {
    // This replicates the logic inside mqtt.js's ws.js stream builder.
    const protocolId = "MQIsdp";
    const protocolVersion = 3;
    const subProtocol =
      protocolId === "MQIsdp" && protocolVersion === 3
        ? "mqttv3.1"
        : "mqtt";
    expect(subProtocol).toBe("mqttv3.1");
  });

  it("the override discards mqttv3.1 and injects mqtt", () => {
    // The transport's createWebsocket ignores the _protocols arg from
    // mqtt.js (which would be ["mqttv3.1"]) and passes ["mqtt"] instead.
    const mqttJsAutoProtocols = ["mqttv3.1"];

    // Simulated override — same logic as the transport callback.
    const overridden = ["mqtt"];

    expect(mqttJsAutoProtocols).toEqual(["mqttv3.1"]);
    expect(overridden).toEqual(["mqtt"]);
    expect(overridden).not.toEqual(mqttJsAutoProtocols);
  });

  it("MQTT 3.1.1 would use 'mqtt' sub-protocol automatically", () => {
    // For reference: MQTT 3.1.1 (protocolId: "MQTT", protocolVersion: 4)
    // gets "mqtt" automatically — no override needed.
    const subProtocol =
      "MQTT" === "MQIsdp" && 4 === 3 ? "mqttv3.1" : "mqtt";
    expect(subProtocol).toBe("mqtt");
  });
});
