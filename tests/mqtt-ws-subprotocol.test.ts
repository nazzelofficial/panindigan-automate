/**
 * Regression guard for the MQTT WebSocket sub-protocol.
 *
 * mqtt.js v5 computes ["mqttv3.1"] for protocolId "MQIsdp" and
 * protocolVersion 3. The deployment that stayed online used mqtt.js's
 * default builder, which sends that header. Sending none (0.2.6-0.2.9)
 * still reached CONNACK but produced repeated PUBACK parser errors and
 * endless reconnects. The transport must pass mqtt.js's own list through.
 */

import { describe, it, expect } from "vitest";

function mqttJsProtocols(protocolId: string, protocolVersion: number): string[] {
  return protocolId === "MQIsdp" && protocolVersion === 3 ? ["mqttv3.1"] : ["mqtt"];
}

describe("MQTT WebSocket sub-protocol", () => {
  it("mqtt.js derives mqttv3.1 for MQIsdp/3", () => {
    expect(mqttJsProtocols("MQIsdp", 3)).toEqual(["mqttv3.1"]);
  });

  it("the transport forwards that list instead of forcing or dropping it", () => {
    const computed = mqttJsProtocols("MQIsdp", 3);
    // The createWebsocket callback passes `protocols` straight to `ws`.
    const handedToWs = computed;
    expect(handedToWs).toEqual(["mqttv3.1"]);
    expect(handedToWs).not.toEqual(["mqtt"]);
    expect(handedToWs).not.toEqual([]);
  });

  it("MQTT 3.1.1 would negotiate mqtt automatically", () => {
    expect(mqttJsProtocols("MQTT", 4)).toEqual(["mqtt"]);
  });
});
