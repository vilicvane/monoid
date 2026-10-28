import {
  type MonoidApplet,
  MonoidAppletHello,
  MonoidCardError,
  assertSameCardWithBundle,
  cardNameWithId,
  readBackupCardIdentity,
} from '../../../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import type {ScannedCardData} from '../common.js';

export type CardResetIdentity = Pick<ScannedCardData, 'id' | 'publicKey'> &
  Partial<Pick<ScannedCardData, 'alias'>> & {
    bundle: string;
  };

/** One explicit reset approval, bound to the old and observed replacement keys. */
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
      // Reset keeps the ID but rotates the keys. Without an observed replacement,
      // the unauthenticated ID cannot establish that a later tap is the same card.
      if (!this.replacement) {
        throw new MonoidCardError(
          'Card reset not confirmed, add the card again',
        );
      }
      assertSameCardWithBundle(
        hello,
        readBackupCardIdentity(this.replacement),
        `Card bundle changed, scan card ${cardNameWithId(this.replacement)} again`,
      );
      return hello;
    }

    assertSameCardWithBundle(
      hello,
      this.card,
      `Card bundle changed, scan card ${cardNameWithId(this.card)} again`,
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
      uint8ArrayToHex(reset.id) !== this.card.id ||
      uint8ArrayToHex(reset.publicKey) === this.card.publicKey
    ) {
      throw new MonoidCardError('Card reset state not confirmed');
    }
    // Keep the observed replacement key even when cancellation follows Hello.
    this.replacement = reset;
    signal.throwIfAborted();
    return reset;
  }
}
