import {isAppHidden, watchAppHidden} from './app-hidden.js';

const IDLE_TIMEOUT = 5 * 60 * 1000;

/** One plaintext lifetime, guarded against late writes after a drop. */
export class HeldPINValue<T> {
  private value: T | undefined;
  private owner = new AbortController();
  private lastUsed = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unwatch: (() => void) | undefined;

  constructor(private readonly onClear?: (value: T | undefined) => void) {}

  get signal(): AbortSignal {
    return this.check() ? this.owner.signal : AbortSignal.abort();
  }

  get(): T | undefined {
    if (!this.check()) return;
    this.touch();
    return this.value;
  }

  /** Inspect availability without extending the idle lifetime. */
  peek(): T | undefined {
    return this.check() ? this.value : undefined;
  }

  set(value: T, owner?: AbortSignal): void {
    if (
      !this.check() ||
      (owner && (owner !== this.owner.signal || owner.aborted))
    )
      return;
    this.value = value;
    this.touch();
  }

  delete(): void {
    this.value = undefined;
    this.watch();
  }

  clear(): void {
    const owner = this.owner;
    const value = this.value;
    this.owner = new AbortController();
    this.delete();
    owner.abort();
    this.onClear?.(value);
  }

  private check(): boolean {
    const hidden = isAppHidden();
    if (
      hidden ||
      (this.value !== undefined && Date.now() - this.lastUsed >= IDLE_TIMEOUT)
    ) {
      this.clear();
    }
    return !hidden;
  }

  private touch(): void {
    this.lastUsed = Date.now();
    this.watch();
  }

  private readonly hidden = (): void => {
    this.check();
  };

  private watch(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const needed = this.value !== undefined;
    if (!needed && this.unwatch) {
      this.unwatch();
      this.unwatch = undefined;
    }
    if (needed && !this.unwatch) {
      this.unwatch = watchAppHidden(this.hidden);
    }
    if (needed && typeof document !== 'undefined') {
      this.timer = setTimeout(
        () => {
          this.check();
          this.watch();
        },
        Math.max(0, this.lastUsed + IDLE_TIMEOUT - Date.now()),
      );
    }
  }
}

/** Every card in a keyed holder shares the same idle clock and owner. */
export class HeldPINs<K, V> {
  private readonly held = new HeldPINValue<ReadonlyMap<K, V>>();

  get signal(): AbortSignal {
    return this.held.signal;
  }

  get(key: K): V | undefined {
    return this.held.get()?.get(key);
  }

  set(key: K, value: V, owner?: AbortSignal): void {
    if (owner && owner !== this.signal) return;
    this.held.set(new Map(this.held.get()).set(key, value), owner);
  }

  delete(key: K): void {
    const values = new Map(this.held.get());
    values.delete(key);
    if (values.size) this.held.set(values);
    else this.held.delete();
  }

  clear(): void {
    this.held.clear();
  }
}
