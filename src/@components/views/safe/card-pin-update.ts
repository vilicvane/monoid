import {type MonoidIdHex, MonoidPIN} from '../../../@atomics.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import {
  type MonoidApplet,
  type MonoidAppletHelloWithSafe,
  MonoidAppletInvalidPINError,
  MonoidCardError,
} from '../../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';

import {assertCardForUpdate} from './card-alias-update.js';
import type {ScannedCardData} from './common.js';

export type CardPINKind = 'Access' | 'Safe';

export async function updateCardPIN(
  applet: MonoidApplet,
  hello: MonoidAppletHelloWithSafe,
  card: Pick<ScannedCardData, 'id' | 'publicKey'>,
  kind: CardPINKind,
  currentSafePIN: MonoidPIN,
  newPIN: MonoidPIN,
  signal: AbortSignal,
): Promise<MonoidIdHex> {
  assertCardForUpdate(hello, card);
  signal.throwIfAborted();
  if (hello.safe.pin === 0) throw new MonoidCardError('Safe PIN blocked');
  if (hello.safe.pin === false) throw new MonoidCardError('Safe PIN not set');
  if (!MonoidPIN.is(currentSafePIN) || !MonoidPIN.is(newPIN)) {
    throw new MonoidCardError('PIN must contain 6 to 16 characters');
  }

  try {
    await applet.authenticate({safe: true, pin: currentSafePIN});
  } catch (error) {
    if (
      error instanceof CBORAppletError &&
      MonoidAppletInvalidPINError.is(error.source)
    ) {
      throw new MonoidCardError(
        error.source.tries === 0
          ? 'Safe PIN blocked'
          : `Incorrect Safe PIN, tries remaining: ${error.source.tries}`,
      );
    }
    throw error;
  }

  signal.throwIfAborted();
  try {
    await applet.setPIN({pin: newPIN, ...(kind === 'Safe' && {safe: true})});
  } catch {
    // A lost response cannot tell us whether the PIN was changed. Never replay it.
    throw new MonoidCardError('PIN update not confirmed');
  }

  // Keep the acknowledged result even if the prompt was dismissed during setPIN.
  return uint8ArrayToHex(hello.id);
}
