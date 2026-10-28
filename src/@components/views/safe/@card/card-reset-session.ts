import {
  type MonoidApplet,
  MonoidAppletHello,
  MonoidCardError,
  assertSameCardWithBundle,
  cardNameWithId,
  readBackupCardIdentity,
} from '../../../../@lib/monoid/index.js';
import type {MonoidPINSession} from '../../../../@services/index.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import type {ScannedCardData} from '../common.js';

export type CardResetIdentity = Pick<ScannedCardData, 'id' | 'publicKey'> &
  Partial<Pick<ScannedCardData, 'alias'>> & {
    bundle: string;
  };

class ResetPINUnlockRequired extends Error {
  readonly code = 'CANCELLED';

  constructor() {
    super('Unlock saved Access PINs before resetting the card');
  }
}

/** One explicit reset approval, bound to the old and observed replacement keys. */
export class CardResetSession {
  attempted = false;
  confirmed = false;
  replacement: MonoidAppletHello | undefined;

  constructor(readonly card: CardResetIdentity) {}

  async run(
    pinSession: MonoidPINSession,
    signal: AbortSignal,
    scan: (removePIN: (signal: AbortSignal) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      try {
        await scan(async scanSignal => {
          try {
            await pinSession.removePIN(
              this.card.id,
              undefined,
              scanSignal,
              false,
            );
          } catch (error) {
            if (
              error !== null &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'AUTHORIZATION_EXPIRED'
            ) {
              // A normal handoff closes NFC without sending Reset or presenting
              // an error. The page-owned signal survives that reader's cleanup.
              throw new ResetPINUnlockRequired();
            }
            throw error;
          }
        });
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ResetPINUnlockRequired)) throw error;
        // scan() has awaited native cleanup and presentation exit. Renew and
        // retry only the removal here; a refused unlock or second expiry fails.
        await pinSession.removePIN(this.card.id, undefined, signal);
      }
    }
  }

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
