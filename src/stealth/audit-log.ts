/**
 * Guard Audit Log (G8)
 *
 * A fixed-size ring buffer of the last `limit` (default 200) guard
 * decisions — allowed sends, denied sends, halts, warnings, cap hits,
 * checkpoint freezes, resets. This never leaves the process unless the
 * app explicitly reads it (diagnostics export), so it is invisible to
 * Facebook and invaluable when debugging "why did my bot stop?".
 */

/** Kinds of decisions the guard can record. */
export type GuardDecision =
  | "allow"
  | "deny"
  | "halt"
  | "warn"
  | "cap_warning"
  | "cap_reached"
  | "checkpoint"
  | "reset"
  | "error";

export interface GuardAuditEntry {
  /** Epoch ms. */
  readonly at: number;
  readonly decision: GuardDecision;
  /** Human-readable reason, safe to log (no payloads). */
  readonly reason: string;
  /** Operation that triggered the decision, if any. */
  readonly operation?: string | undefined;
  /** Thread/user the operation targeted, if any. */
  readonly target?: string | undefined;
  /** Extra non-secret context (counts, severities — never message bodies). */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface AuditLogSnapshot {
  readonly total: number;
  readonly entries: readonly GuardAuditEntry[];
}

export class GuardAuditLog {
  readonly #limit: number;
  #entries: GuardAuditEntry[] = [];
  #total = 0;

  constructor(limit: number = 200) {
    this.#limit = limit;
  }

  /** Records one decision and trims the buffer. */
  record(entry: GuardAuditEntry): void {
    this.#entries.push(entry);
    this.#total += 1;
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit);
    }
  }

  /** Returns the most recent entries, newest last. */
  recent(limit?: number | undefined): readonly GuardAuditEntry[] {
    const count = limit === undefined ? this.#entries.length : Math.min(limit, this.#entries.length);
    return this.#entries.slice(this.#entries.length - count);
  }

  /** Total decisions ever recorded (including trimmed ones). */
  get total(): number {
    return this.#total;
  }

  get size(): number {
    return this.#entries.length;
  }

  snapshot(): AuditLogSnapshot {
    return {
      total: this.#total,
      entries: Object.freeze([...this.#entries]),
    };
  }

  clear(): void {
    this.#entries = [];
  }
}
