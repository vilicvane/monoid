import {type MonoidIdHex, MonoidPIN} from '../../../@atomics.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidAppletInvalidPINError,
  MonoidCardError,
} from '../../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';

import {assertCardForUpdate} from './card-alias-update.js';
import type {ScannedCardData} from './common.js';

export type CardPINKind = 'Access' | 'Secret';

export async function updateCardPIN(
  applet: MonoidApplet,
  hello: MonoidAppletHello,
  card: Pick<ScannedCardData, 'id' | 'publicKey'>,
  kind: CardPINKind,
  currentSecretPIN: MonoidPIN,
  newPIN: MonoidPIN,
  signal: AbortSignal,
): Promise<MonoidIdHex> {
  assertCardForUpdate(hello, card);
  signal.throwIfAborted();
  if (hello.pins.secret === 0) throw new MonoidCardError('Secret PIN blocked');
  if (hello.pins.secret === false)
    throw new MonoidCardError('Secret PIN not set');
  if (!MonoidPIN.is(currentSecretPIN) || !MonoidPIN.is(newPIN)) {
    throw new MonoidCardError('PIN must contain 6 to 16 characters');
  }

  try {
    await applet.authenticate({secret: true, pin: currentSecretPIN});
  } catch (error) {
    if (
      error instanceof CBORAppletError &&
      MonoidAppletInvalidPINError.is(error.source)
    ) {
      throw new MonoidCardError(
        error.source.tries === 0
          ? 'Secret PIN blocked'
          : `Incorrect Secret PIN, tries remaining: ${error.source.tries}`,
      );
    }
    throw error;
  }

  signal.throwIfAborted();
  try {
    await applet.setPIN({
      pin: newPIN,
      ...(kind === 'Secret' && {secret: true}),
    });
  } catch {
    // A lost response cannot tell us whether the PIN was changed. Never replay it.
    throw new MonoidCardError('PIN update not confirmed');
  }

  // Keep the acknowledged result even if the prompt was dismissed during setPIN.
  return uint8ArrayToHex(hello.id);
}
