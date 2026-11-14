/**
 * Middleware pipeline.
 *
 * Hooks wrap every HTTP-backed operation. Execution order is
 * deterministic: `before` runs global → plugin → user registrations;
 * `after` runs user → plugin → global; `error` runs in reverse of
 * `before` — user → plugin → global, and within each tier in reverse
 * registration order. Calling `next()` continues the chain; returning
 * without calling it short-circuits the remainder of that phase.
 */

import type {
  HeadersView,
  MiddlewareContext,
  MiddlewareHook,
  MiddlewarePhase,
  MiddlewareRegistrationOptions,
} from "../types/index.js";
import type { LibraryError } from "../errors/index.js";

/** Who registered a hook; determines execution tier. */
export type MiddlewareSource = "global" | "plugin" | "user";

interface RegisteredHook {
  readonly phase: MiddlewarePhase;
  readonly hook: MiddlewareHook;
  readonly operations: readonly string[] | null;
  readonly name: string;
  readonly source: MiddlewareSource;
  readonly owner: string;
}

const TIER_ORDER: readonly MiddlewareSource[] = ["global", "plugin", "user"];

/** Mutable header view over a plain record. */
export class HeaderMap implements HeadersView {
  readonly #headers: Record<string, string>;

  constructor(initial: Readonly<Record<string, string>>) {
    this.#headers = { ...initial };
  }

  get(name: string): string | null {
    return this.#headers[name.toLowerCase()] ?? null;
  }

  set(name: string, value: string): void {
    this.#headers[name.toLowerCase()] = value;
  }

  has(name: string): boolean {
    return this.#headers[name.toLowerCase()] !== undefined;
  }

  delete(name: string): void {
    delete this.#headers[name.toLowerCase()];
  }

  toJSON(): Readonly<Record<string, string>> {
    return { ...this.#headers };
  }

  /** A frozen copy of the current headers. */
  snapshot(): Readonly<Record<string, string>> {
    return Object.freeze({ ...this.#headers });
  }
}

/** Internal, mutable middleware context handed to hooks. */
export class MiddlewareContextImpl implements MiddlewareContext {
  readonly operation: string;
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: HeaderMap;
  };
  response: { readonly status: number; readonly headers: HeadersView; readonly body: unknown } | null = null;
  error: LibraryError | null = null;
  readonly metadata: Record<string, unknown>;

  constructor(
    operation: string,
    url: string,
    method: string,
    headers: Readonly<Record<string, string>>,
  ) {
    this.operation = operation;
    this.request = { url, method, headers: new HeaderMap(headers) };
    this.metadata = {};
  }

  /** The possibly-mutated request headers. */
  mutatedHeaders(): Readonly<Record<string, string>> {
    return this.request.headers.snapshot();
  }
}

/**
 * Registry and executor for middleware hooks.
 */
export class MiddlewareManager {
  readonly #hooks: RegisteredHook[] = [];

  /** Registers a hook for a phase. */
  register(
    phase: MiddlewarePhase,
    hook: MiddlewareHook,
    options: MiddlewareRegistrationOptions,
    source: MiddlewareSource,
    owner: string,
  ): void {
    this.#hooks.push({
      phase,
      hook,
      operations: options.operations !== undefined ? [...options.operations] : null,
      name: options.name ?? `${owner}:${phase}`,
      source,
      owner,
    });
  }

  /** Removes every hook registered by one owner (e.g. a plugin). */
  unregisterOwner(owner: string): void {
    for (let i = this.#hooks.length - 1; i >= 0; i -= 1) {
      if (this.#hooks[i]!.owner === owner) {
        this.#hooks.splice(i, 1);
      }
    }
  }

  /** Number of registered hooks, optionally filtered by phase. */
  count(phase?: MiddlewarePhase): number {
    return this.#hooks.filter((hook) => phase === undefined || hook.phase === phase).length;
  }

  /**
   * Runs the `before` chain for an operation. Returns whether the chain
   * ran to completion (`false` when a hook short-circuited it).
   */
  async runBefore(context: MiddlewareContextImpl): Promise<boolean> {
    return this.#run("before", context);
  }

  /** Runs the `after` chain for an operation. */
  async runAfter(context: MiddlewareContextImpl): Promise<void> {
    await this.#run("after", context);
  }

  /** Runs the `error` chain for an operation. */
  async runError(context: MiddlewareContextImpl): Promise<void> {
    await this.#run("error", context);
  }

  async #run(phase: MiddlewarePhase, context: MiddlewareContextImpl): Promise<boolean> {
    const ordered = this.#orderedHooks(phase, context.operation);
    let completed = true;

    const runFrom = (index: number): Promise<void> => {
      const hook = ordered[index];
      if (hook === undefined) {
        return Promise.resolve();
      }
      let nextCalled = false;
      return Promise.resolve(
        hook.hook(context, () => {
          nextCalled = true;
          return runFrom(index + 1);
        }),
      ).then(() => {
        if (!nextCalled) {
          completed = false;
        }
      });
    };

    await runFrom(0);
    return completed;
  }

  /** Hooks matching a phase and operation, in their execution order. */
  #orderedHooks(phase: MiddlewarePhase, operation: string): readonly RegisteredHook[] {
    const tiers: Record<MiddlewareSource, RegisteredHook[]> = { global: [], plugin: [], user: [] };
    for (const hook of this.#hooks) {
      if (hook.phase !== phase) {
        continue;
      }
      if (hook.operations !== null && !hook.operations.includes(operation)) {
        continue;
      }
      tiers[hook.source].push(hook);
    }

    let tierOrder: readonly MiddlewareSource[];
    if (phase === "before") {
      tierOrder = TIER_ORDER;
    } else {
      // `after` and `error` reverse the tier order; `error` additionally
      // reverses within each tier, mirroring the `before` chain.
      tierOrder = [...TIER_ORDER].reverse();
    }

    const ordered: RegisteredHook[] = [];
    for (const tier of tierOrder) {
      const bucket = tiers[tier];
      if (phase === "error") {
        ordered.push(...[...bucket].reverse());
      } else {
        ordered.push(...bucket);
      }
    }
    return ordered;
  }
}
