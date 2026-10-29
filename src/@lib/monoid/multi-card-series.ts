import {MonoidCardError} from './card-error.js';

/** Card completion is separate from per-item ACKs and pending writes. */
export class MultiCardSeries {
  constructor(private readonly finished = new Set<string>()) {}

  /** Derive finite flows from their existing checkpoints, without a second state. */
  static from(
    cards: readonly {publicKey: string; complete: boolean}[],
  ): MultiCardSeries {
    return new MultiCardSeries(
      new Set(cards.filter(card => card.complete).map(card => card.publicKey)),
    );
  }

  get completedCount(): number {
    return this.finished.size;
  }

  hasFinished(publicKey: string): boolean {
    return this.finished.has(publicKey);
  }

  assertPending(
    publicKey: string,
    message = 'Card already done, scan another card',
  ): void {
    if (this.hasFinished(publicKey)) throw new MonoidCardError(message);
  }

  /** Failures escape to end/pause the caller's series. No operation is retried. */
  async run<T>(publicKey: string, operation: () => Promise<T>): Promise<T> {
    this.assertPending(publicKey);
    const result = await operation();
    this.finished.add(publicKey);
    return result;
  }
}
