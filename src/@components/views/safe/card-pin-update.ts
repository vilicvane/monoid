import {type MonoidIdHex, MonoidPIN} from '../../../@atomics.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidCardError,
  assertCardPINNotBlocked,
  assertSameCard,
  authenticateCardPIN,
} from '../../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';

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
  assertSameCard(hello, card);
  signal.throwIfAborted();
  assertCardPINNotBlocked(hello, 'secret');
  if (hello.pins.secret === false)
    throw new MonoidCardError('Secret PIN not set');
  if (!MonoidPIN.is(currentSecretPIN) || !MonoidPIN.is(newPIN)) {
    throw new MonoidCardError('PIN must contain 6 to 16 characters');
  }

  await authenticateCardPIN(applet, currentSecretPIN);

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
