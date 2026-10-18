import {MonoidPIN} from '../../@atomics.js';
import {uint8ArrayToHex} from '../../@utils/index.js';

import {MonoidCardError, MonoidWrongCardError} from './card-error.js';
import {type MonoidApplet, MonoidAppletHelloWithSafe} from './monoid-applet.js';

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('Card setup was cancelled.'), {
      code: 'CANCELLED',
    });
  }
}

function assertPINsNotBlocked(hello: MonoidAppletHelloWithSafe): void {
  if (hello.safe.pin === 0) {
    throw new MonoidCardError('Safe PIN blocked');
  }

  if (hello.pin === 0) {
    throw new MonoidCardError('Access PIN blocked');
  }
}

export async function initializeMonoidCard(
  applet: MonoidApplet,
  hello: MonoidAppletHelloWithSafe,
  pin: MonoidPIN,
  signal: AbortSignal,
): Promise<MonoidAppletHelloWithSafe> {
  throwIfCancelled(signal);
  assertPINsNotBlocked(hello);

  if (!MonoidPIN.is(pin)) {
    throw new MonoidCardError('Safe PIN must contain 6 to 16 characters');
  }

  if (hello.safe.pin === false && hello.pin !== false) {
    throw new MonoidCardError('Card PIN state needs attention');
  }

  if (hello.pin !== false && hello.safe.pin !== false && hello.safe.unlocked) {
    return hello;
  }

  if (hello.safe.pin !== false) {
    await applet.authenticate({safe: true, pin});
    throwIfCancelled(signal);
  }

  // The firmware also initializes an unset Access PIN to this value, while
  // preserving any existing Access PIN and restoring access to an existing Safe.
  await applet.setPIN({safe: true, pin});
  throwIfCancelled(signal);

  const initialized = MonoidAppletHelloWithSafe.satisfies(
    await applet.hello({safe: true}),
  );
  throwIfCancelled(signal);

  if (
    uint8ArrayToHex(initialized.id) !== uint8ArrayToHex(hello.id) ||
    uint8ArrayToHex(initialized.safe.publicKey) !==
      uint8ArrayToHex(hello.safe.publicKey)
  ) {
    throw new MonoidWrongCardError(uint8ArrayToHex(hello.safe.id));
  }

  assertPINsNotBlocked(initialized);

  if (
    initialized.pin === false ||
    initialized.safe.pin === false ||
    !initialized.safe.unlocked
  ) {
    throw new MonoidCardError('Card setup incomplete');
  }

  return initialized;
}
