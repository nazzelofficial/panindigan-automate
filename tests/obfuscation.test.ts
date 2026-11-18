/**
 * Basic smoke test for MQTT obfuscation
 */

import { describe, it, expect } from "vitest";
import {
  MqttObfuscationManager,
  PublishRateTracker,
  applyObfuscationDelay,
} from "../src/transport/mqtt/obfuscation.js";

describe("MqttObfuscationManager", () => {
  it("randomizes topic order", () => {
    const manager = new MqttObfuscationManager({ enabled: true });
    const topics = ["/topic1", "/topic2", "/topic3", "/topic4", "/topic5"];
    
    const randomized = manager.randomizeTopicOrder(topics);
    
    expect(randomized).toHaveLength(topics.length);
    expect(randomized).toEqual(expect.arrayContaining(topics));
  });

  it("calculates operation delays", () => {
    const manager = new MqttObfuscationManager({ enabled: true });
    
    const delay = manager.getOperationDelay();
    
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(500);
  });

  it("calculates subscription delays", () => {
    const manager = new MqttObfuscationManager({ enabled: true });
    
    const delay1 = manager.getSubscriptionDelay(0, 10);
    const delay2 = manager.getSubscriptionDelay(5, 10);
    
    expect(delay1).toBe(0);
    expect(delay2).toBeGreaterThan(0);
  });

  it("generates connection jitter", () => {
    const manager = new MqttObfuscationManager({ enabled: true });
    
    const jitter = manager.getConnectionJitter();
    
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(5000);
  });

  it("applies jitter to base delays", () => {
    const manager = new MqttObfuscationManager({ enabled: true });
    
    const baseMs = 1000;
    const jittered = manager.applyJitter(baseMs, 20);
    
    expect(jittered).toBeGreaterThanOrEqual(800); // -20%
    expect(jittered).toBeLessThanOrEqual(1200); // +20%
  });

  it("respects disabled state", () => {
    const manager = new MqttObfuscationManager({ enabled: false });
    
    expect(manager.getOperationDelay()).toBe(0);
    expect(manager.getConnectionJitter()).toBe(0);
    expect(manager.applyJitter(1000)).toBe(1000);
  });

  it("tracks presence publish timing", () => {
    const manager = new MqttObfuscationManager({ enabled: true });
    
    manager.recordPresencePublish();
    const delay = manager.getPresencePublishDelay();
    
    expect(delay).toBeGreaterThan(0);
  });

  it("generates client ID entropy", () => {
    const manager = new MqttObfuscationManager({ enabled: true });
    
    const entropy1 = manager.generateClientIdEntropy();
    const entropy2 = manager.generateClientIdEntropy();
    
    expect(entropy1).toHaveLength(8); // 4 bytes = 8 hex chars
    expect(entropy1).not.toBe(entropy2);
  });
});

describe("PublishRateTracker", () => {
  it("tracks recent publishes", () => {
    const tracker = new PublishRateTracker();
    
    expect(tracker.getRecentCount()).toBe(0);
    
    tracker.recordPublish();
    tracker.recordPublish();
    
    expect(tracker.getRecentCount()).toBe(2);
  });

  it("resets count", () => {
    const tracker = new PublishRateTracker();
    
    tracker.recordPublish();
    tracker.reset();
    
    expect(tracker.getRecentCount()).toBe(0);
  });
});

describe("applyObfuscationDelay", () => {
  it("completes immediately for zero delay", async () => {
    const start = Date.now();
    await applyObfuscationDelay(0);
    const elapsed = Date.now() - start;
    
    expect(elapsed).toBeLessThan(10);
  });

  it("applies actual delay", async () => {
    const delayMs = 50;
    const start = Date.now();
    await applyObfuscationDelay(delayMs);
    const elapsed = Date.now() - start;
    
    expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);
  });
});
