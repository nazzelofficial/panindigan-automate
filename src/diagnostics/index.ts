/**
 * Diagnostics collection.
 *
 * One collector per client, fed by the transports, cache, and event
 * emitter. `getSnapshot()` freezes everything into a plain object that is
 * safe to log or serialize.
 */

import type {
  DiagnosticsHandle,
  DiagnosticsSnapshot,
  LatencyStats,
} from "../types/index.js";

/** Number of latency samples kept for percentile computation. */
const LATENCY_SAMPLE_LIMIT = 1024;

/** Window over which event throughput is measured, in ms. */
const THROUGHPUT_WINDOW_MS = 60_000;

/** Number of event timestamps kept for throughput measurement. */
const THROUGHPUT_SAMPLE_LIMIT = 4096;

/** Computes min/max/avg and nearest-rank percentiles. */
function latencyStats(samples: readonly number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, min: null, max: null, avg: null, p50: null, p90: null, p95: null, p99: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (rank: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
    return sorted[index]!;
  };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    avg: total / sorted.length,
    p50: percentile(50),
    p90: percentile(90),
    p95: percentile(95),
    p99: percentile(99),
  };
}

/** A fixed-size ring buffer of latency samples. */
class SampleRing {
  readonly #samples: number[] = [];

  push(value: number): void {
    this.#samples.push(value);
    if (this.#samples.length > LATENCY_SAMPLE_LIMIT) {
      this.#samples.splice(0, this.#samples.length - LATENCY_SAMPLE_LIMIT);
    }
  }

  snapshot(): readonly number[] {
    return this.#samples;
  }

  reset(): void {
    this.#samples.length = 0;
  }
}

/**
 * Collects every metric the diagnostics snapshot exposes.
 */
export class DiagnosticsCollector implements DiagnosticsHandle {
  readonly #startedAt = Date.now();

  // HTTP
  readonly #httpLatency = new SampleRing();
  #httpTotal = 0;
  #httpSucceeded = 0;
  #httpFailed = 0;
  #httpRetried = 0;
  #httpBytesReceived = 0;
  #httpBytesSent = 0;

  // MQTT
  readonly #heartbeatLatency = new SampleRing();
  #heartbeatMissed = 0;
  #mqttConnected = false;
  #mqttReconnects = 0;
  #mqttDisconnects = 0;
  #mqttMessagesReceived = 0;
  #mqttMessagesSent = 0;
  #queueDepth = 0;
  #queueDropped = 0;

  // Cache
  #cacheHits = 0;
  #cacheMisses = 0;
  #cacheSets = 0;
  #cacheInvalidations = 0;

  // Events
  readonly #eventCounts = new Map<string, number>();
  readonly #eventTimestamps: number[] = [];

  /** Records a completed HTTP request. */
  recordHttpRequest(options: {
    readonly succeeded: boolean;
    readonly latencyMs: number;
    readonly bytesIn?: number | undefined;
    readonly bytesSent?: number | undefined;
  }): void {
    this.#httpTotal += 1;
    if (options.succeeded) {
      this.#httpSucceeded += 1;
    } else {
      this.#httpFailed += 1;
    }
    this.#httpLatency.push(options.latencyMs);
    this.#httpBytesReceived += options.bytesIn ?? 0;
    this.#httpBytesSent += options.bytesSent ?? 0;
  }

  /** Records a retried HTTP attempt. */
  recordHttpRetry(): void {
    this.#httpRetried += 1;
  }

  /** Records a completed MQTT heartbeat round trip. */
  recordHeartbeat(latencyMs: number): void {
    this.#heartbeatLatency.push(latencyMs);
  }

  /** Records a missed MQTT heartbeat response. */
  recordMissedHeartbeat(): void {
    this.#heartbeatMissed += 1;
  }

  /** Updates the reported connection state. */
  setMqttConnected(connected: boolean): void {
    this.#mqttConnected = connected;
  }

  /** Records a completed reconnect. */
  recordReconnect(): void {
    this.#mqttReconnects += 1;
  }

  /** Records a disconnect. */
  recordDisconnect(): void {
    this.#mqttDisconnects += 1;
  }

  /** Records an inbound MQTT message. */
  recordMqttMessageReceived(): void {
    this.#mqttMessagesReceived += 1;
  }

  /** Records an outbound MQTT publish. */
  recordMqttMessageSent(): void {
    this.#mqttMessagesSent += 1;
  }

  /** Updates the reported outgoing queue depth. */
  setQueueDepth(depth: number): void {
    this.#queueDepth = depth;
  }

  /** Records a packet dropped from a full outgoing queue. */
  recordQueueDrop(): void {
    this.#queueDropped += 1;
  }

  /** Records a cache hit. */
  recordCacheHit(): void {
    this.#cacheHits += 1;
  }

  /** Records a cache miss. */
  recordCacheMiss(): void {
    this.#cacheMisses += 1;
  }

  /** Records a cache write. */
  recordCacheSet(): void {
    this.#cacheSets += 1;
  }

  /** Records a tag or full cache invalidation. */
  recordCacheInvalidation(): void {
    this.#cacheInvalidations += 1;
  }

  /** Records one emitted event. */
  recordEvent(event: string): void {
    this.#eventCounts.set(event, (this.#eventCounts.get(event) ?? 0) + 1);
    this.#eventTimestamps.push(Date.now());
    if (this.#eventTimestamps.length > THROUGHPUT_SAMPLE_LIMIT) {
      this.#eventTimestamps.splice(0, this.#eventTimestamps.length - THROUGHPUT_SAMPLE_LIMIT);
    }
  }

  /** Additional, feature-specific sections merged into the snapshot. */
  #externalProvider: (() => Record<string, unknown>) | null = null;

  /** Registers an external stats provider (used by the Stealth Guard wiring). */
  setExternalProvider(provider: (() => Record<string, unknown>) | null): void {
    this.#externalProvider = provider;
  }

  getSnapshot(): DiagnosticsSnapshot {
    const memory = process.memoryUsage();
    const now = Date.now();
    const windowStart = now - THROUGHPUT_WINDOW_MS;
    while (this.#eventTimestamps.length > 0 && this.#eventTimestamps[0]! < windowStart) {
      this.#eventTimestamps.shift();
    }
    const windowSeconds = Math.max(1, Math.min(THROUGHPUT_WINDOW_MS, now - this.#startedAt)) / 1000;
    const heartbeat = latencyStats(this.#heartbeatLatency.snapshot());
    const totalEvents = [...this.#eventCounts.values()].reduce((sum, count) => sum + count, 0);

    return Object.freeze({
      capturedAt: now,
      uptimeMs: now - this.#startedAt,
      http: {
        requests: {
          total: this.#httpTotal,
          succeeded: this.#httpSucceeded,
          failed: this.#httpFailed,
          retried: this.#httpRetried,
        },
        latency: latencyStats(this.#httpLatency.snapshot()),
        bytes: { received: this.#httpBytesReceived, sent: this.#httpBytesSent },
      },
      mqtt: {
        connected: this.#mqttConnected,
        reconnects: this.#mqttReconnects,
        disconnects: this.#mqttDisconnects,
        messagesReceived: this.#mqttMessagesReceived,
        messagesSent: this.#mqttMessagesSent,
        heartbeat: {
          lastMs: this.#heartbeatLatency.snapshot().at(-1) ?? null,
          avgMs: heartbeat.avg,
          minMs: heartbeat.min,
          maxMs: heartbeat.max,
          missed: this.#heartbeatMissed,
        },
        queue: { depth: this.#queueDepth, dropped: this.#queueDropped },
      },
      cache: {
        hits: this.#cacheHits,
        misses: this.#cacheMisses,
        hitRate:
          this.#cacheHits + this.#cacheMisses === 0
            ? 0
            : this.#cacheHits / (this.#cacheHits + this.#cacheMisses),
        sets: this.#cacheSets,
        invalidations: this.#cacheInvalidations,
      },
      events: {
        total: totalEvents,
        throughput: this.#eventTimestamps.length / windowSeconds,
        counts: Object.freeze({ ...Object.fromEntries(this.#eventCounts) }),
      },
      process: {
        nodeVersion: process.version,
        platform: process.platform,
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
      },
      ...(this.#externalProvider !== null ? (this.#externalProvider() as Partial<DiagnosticsSnapshot>) : {}),
    });
  }

  /** Renders the snapshot as self-contained JSON. */
  exportJSON(): string {
    return JSON.stringify(this.getSnapshot(), null, 2);
  }

  /**
   * Renders a self-contained HTML diagnostics report: inline CSS, inline
   * data, zero external requests. Suitable for attaching to incident tickets.
   */
  exportHTML(): string {
    const snapshot = this.getSnapshot();
    const esc = (value: unknown): string =>
      String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    const row = (label: string, value: unknown): string =>
      `<tr><th>${esc(label)}</th><td>${esc(typeof value === "object" && value !== null ? JSON.stringify(value) : value)}</td></tr>`;
    const section = (title: string, obj: Record<string, unknown>): string =>
      `<section><h2>${esc(title)}</h2><table>${Object.entries(obj).map(([k, v]) => row(k, v)).join("")}</table></section>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>panindigan-automate diagnostics</title>
<style>
:root{color-scheme:dark}
body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0b1020;color:#dbe4ff;margin:0;padding:32px;line-height:1.5}
h1{font-size:1.4rem;margin:0 0 4px}
.sub{color:#8a97c7;font-size:.85rem;margin-bottom:24px}
h2{font-size:1rem;color:#7dd3fc;border-bottom:1px solid #1e2a52;padding-bottom:6px;margin:28px 0 8px}
table{border-collapse:collapse;width:100%;font-size:.85rem}
th,td{text-align:left;padding:4px 12px;border-bottom:1px solid #141c3a;vertical-align:top}
th{color:#a5b4fc;width:34%;font-weight:600}
td{word-break:break-word;white-space:pre-wrap}
</style></head>
<body>
<h1>panindigan-automate — diagnostics report</h1>
<div class="sub">captured ${esc(new Date(snapshot.capturedAt).toISOString())} · uptime ${Math.round(snapshot.uptimeMs / 1000)}s · node ${esc(snapshot.process.nodeVersion)} · ${esc(snapshot.process.platform)}</div>
${section("HTTP", snapshot.http as unknown as Record<string, unknown>)}
${section("MQTT", snapshot.mqtt as unknown as Record<string, unknown>)}
${section("Cache", snapshot.cache as unknown as Record<string, unknown>)}
${section("Events", snapshot.events as unknown as Record<string, unknown>)}
${section("Process", snapshot.process as unknown as Record<string, unknown>)}
${snapshot.stealth !== undefined ? section("Stealth Guard", snapshot.stealth as unknown as Record<string, unknown>) : ""}
</body></html>`;
  }

  reset(): void {
    this.#httpLatency.reset();
    this.#httpTotal = 0;
    this.#httpSucceeded = 0;
    this.#httpFailed = 0;
    this.#httpRetried = 0;
    this.#httpBytesReceived = 0;
    this.#httpBytesSent = 0;
    this.#heartbeatLatency.reset();
    this.#heartbeatMissed = 0;
    this.#mqttReconnects = 0;
    this.#mqttDisconnects = 0;
    this.#mqttMessagesReceived = 0;
    this.#mqttMessagesSent = 0;
    this.#queueDepth = 0;
    this.#queueDropped = 0;
    this.#cacheHits = 0;
    this.#cacheMisses = 0;
    this.#cacheSets = 0;
    this.#cacheInvalidations = 0;
    this.#eventCounts.clear();
    this.#eventTimestamps.length = 0;
  }
}
