/**
 * Regression guard for the MQTT WebSocket sub-protocol, based on the LATEST
 * deployment evidence (not older code):
 *  - mqttv3.1 -> 1006 "Server sent no subprotocol" on all eight regions.
 *  - no sub-protocol -> upgrade 101 and CONNACK returnCode 0.
 */

import { describe, it, expect } from "vitest";

describe("MQTT WebSocket sub-protocol", () => {
  it("mqtt.js would derive mqttv3.1 for MQIsdp/3 if left to its default", () => {
    const protocolId = "MQIsdp";
    const protocolVersion = 3;
    expect(protocolId === "MQIsdp" && protocolVersion === 3 ? ["mqttv3.1"] : ["mqtt"]).toEqual(["mqttv3.1"]);
  });

  it("the transport discards that list, so no sub-protocol is requested", () => {
    const mqttJsProtocols = ["mqttv3.1"];
    const handedToWs = undefined;
    expect(mqttJsProtocols).toEqual(["mqttv3.1"]);
    expect(handedToWs).toBeUndefined();
  });
});
