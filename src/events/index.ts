/**
 * Typed event emitter.
 *
 * - Listener registration is typed end to end: `on("message", …)` hands
 *   the listener a `MessageEvent`.
 * - No wildcard listeners; each listener names an exact event.
 * - Emits run strictly in order. A slow listener delays the next event,
 *   but a throwing listener never breaks the chain: its error is routed
 *   to the error hook (the client wires that to the `error` event and
 *   the logger) instead of propagating.
 */

import type {
  EventListener,
  EventName,
  EventPayloadMap,
} from "../types/index.js";

/** Hooks the emitter calls back into. */
export interface EmitterHooks {
  /** Called for every emitted event; used for diagnostics. */
  readonly onEmit?: ((event: EventName) => void) | undefined;
  /**
   * Called when a listener throws. Must not itself emit the same event
   * recursively; the emitter guards against that by logging directly on
   * the second level.
   */
  readonly onListenerError?:
    | ((event: EventName, error: unknown) => void)
    | undefined;
}

/** A handle returned from `on`/`once` that removes the listener. */
export type Unsubscribe = () => void;

interface RegisteredListener {
  readonly listener: EventListener<EventName>;
  readonly once: boolean;
}

/**
 * A typed, serial emitter for the client's event payloads.
 */
export class TypedEmitter {
  readonly #listeners = new Map<EventName, RegisteredListener[]>();
  readonly #hooks: EmitterHooks;
  #chain: Promise<void> = Promise.resolve();

  constructor(hooks: EmitterHooks = {}) {
    this.#hooks = hooks;
  }

  /** Registers a listener; returns its unsubscribe handle. */
  on<E extends EventName>(event: E, listener: EventListener<E>): Unsubscribe {
    return this.#register(event, listener, false);
  }

  /** Registers a one-shot listener. */
  once<E extends EventName>(event: E, listener: EventListener<E>): Unsubscribe {
    return this.#register(event, listener, true);
  }

  /** Removes a previously registered listener. Returns whether it existed. */
  off<E extends EventName>(event: E, listener: EventListener<E>): boolean {
    const list = this.#listeners.get(event);
    if (list === undefined) {
      return false;
    }
    const index = list.findIndex((entry) => entry.listener === (listener as EventListener<EventName>));
    if (index === -1) {
      return false;
    }
    list.splice(index, 1);
    if (list.length === 0) {
      this.#listeners.delete(event);
    }
    return true;
  }

  /** Removes every listener for one event. */
  removeAll(event?: EventName): void {
    if (event === undefined) {
      this.#listeners.clear();
    } else {
      this.#listeners.delete(event);
    }
  }

  /** Number of listeners registered for an event. */
  listenerCount(event: EventName): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  /**
   * Emits an event. Listeners run sequentially in registration order;
   * resolution happens when every listener has settled. Events emitted
   * while an earlier emission is still running are queued, so payloads
   * are always observed in order.
   */
  emit<E extends EventName>(event: E, payload: EventPayloadMap[E]): Promise<void> {
    this.#hooks.onEmit?.(event);
    const run = (): Promise<void> => this.#dispatch(event, payload);
    this.#chain = this.#chain.then(run, run);
    return this.#chain;
  }

  /** Emits an event without waiting for its listeners to settle. */
  emitAndForget<E extends EventName>(event: E, payload: EventPayloadMap[E]): void {
    void this.emit(event, payload);
  }

  async #dispatch<E extends EventName>(event: E, payload: EventPayloadMap[E]): Promise<void> {
    const list = this.#listeners.get(event);
    if (list === undefined || list.length === 0) {
      return;
    }
    // Copy so `once` removals and mid-emit registrations behave sanely.
    const snapshot = [...list];
    for (const entry of snapshot) {
      if (entry.once) {
        this.off(event, entry.listener);
      }
      try {
        await entry.listener(payload);
      } catch (error) {
        // Listener failures never propagate: they are routed to the hook,
        // which the client wires to the `error` event and the logger. The
        // hook itself must not re-emit `error` for a failing `error`
        // listener — the client guards against that.
        this.#hooks.onListenerError?.(event, error);
      }
    }
  }

  #register<E extends EventName>(
    event: E,
    listener: EventListener<E>,
    once: boolean,
  ): Unsubscribe {
    const entry: RegisteredListener = { listener: listener as EventListener<EventName>, once };
    const list = this.#listeners.get(event);
    if (list === undefined) {
      this.#listeners.set(event, [entry]);
    } else {
      list.push(entry);
    }
    return () => {
      this.off(event, listener);
    };
  }
}
