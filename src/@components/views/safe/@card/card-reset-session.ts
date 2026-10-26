import {
  type MonoidApplet,
  MonoidAppletHello,
  MonoidCardError,
  assertSameCardWithBundle,
  readBackupCardIdentity,
} from '../../../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import type {ScannedCardData} from '../common.js';

export type CardResetIdentity = Pick<ScannedCardData, 'id' | 'publicKey'> & {
  bundle: string;
};

/** One explicit reset approval, bound to the old and observed replacement IDs. */
export class CardResetSession {
  attempted = false;
  confirmed = false;
  replacement: MonoidAppletHello | undefined;

  constructor(readonly card: CardResetIdentity) {}

  async readOrReset(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    beforeReset: () => Promise<void>,
    onReset: () => void,
    signal: AbortSignal,
  ): Promise<MonoidAppletHello> {
    signal.throwIfAborted();
    if (this.attempted) {
      // Reset rotates identity. Without an observed replacement, a later tap
      // cannot establish that it is the same physical card.
      if (!this.replacement) {
        throw new MonoidCardError(
          'Card reset not confirmed, add the card again',
        );
      }
      assertSameCardWithBundle(
        hello,
        readBackupCardIdentity(this.replacement),
        `Card bundle changed, scan card ${uint8ArrayToHex(this.replacement.id)} again`,
      );
      return hello;
    }

    assertSameCardWithBundle(
      hello,
      this.card,
      `Card bundle changed, scan card ${this.card.id} again`,
    );

    await beforeReset();
    signal.throwIfAborted();
    this.attempted = true;
    await applet.reset({});
    // Preserve the acknowledged deletion even if navigation follows the APDU.
    this.confirmed = true;
    onReset();
    signal.throwIfAborted();

    const reset = MonoidAppletHello.satisfies(await applet.hello({}));
    if (
      reset.bundle !== false ||
      reset.pins.secret !== false ||
      reset.pins.access !== false ||
      uint8ArrayToHex(reset.id) === this.card.id ||
      uint8ArrayToHex(reset.publicKey) === this.card.publicKey
    ) {
      throw new MonoidCardError('Card reset state not confirmed');
    }
    // Keep an acknowledged new identity even when cancellation follows Hello.
    this.replacement = reset;
    signal.throwIfAborted();
    return reset;
  }
}
