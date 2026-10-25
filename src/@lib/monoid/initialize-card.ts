import {MonoidPIN} from '../../@atomics.js';

import {MonoidCardError} from './card-error.js';
import {
  assertSameCardWithBundle,
  readBackupCardIdentity,
} from './card-identity.js';
import {assertCardPINsNotBlocked} from './card-pins.js';
import {type MonoidApplet, MonoidAppletHello} from './monoid-applet.js';

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('Card setup was cancelled.'), {
      code: 'CANCELLED',
    });
  }
}

export async function initializeMonoidCard(
  applet: MonoidApplet,
  hello: MonoidAppletHello,
  pin: MonoidPIN,
  signal: AbortSignal,
  accessPIN?: MonoidPIN,
): Promise<MonoidAppletHello> {
  throwIfCancelled(signal);
  assertCardPINsNotBlocked(hello);

  if (!MonoidPIN.is(pin)) {
    throw new MonoidCardError('Secret PIN must contain 6 to 16 characters');
  }

  if (hello.pins.secret === false && hello.pins.access !== false) {
    throw new MonoidCardError('Card PIN state needs attention');
  }

  if (hello.pins.access !== false && hello.pins.secret !== false) {
    return hello;
  }
  if (hello.pins.access === false && !MonoidPIN.is(accessPIN)) {
    throw new MonoidCardError('Access PIN must contain 6 to 16 characters');
  }

  if (hello.pins.secret !== false) {
    await applet.authenticate({secret: true, pin});
    throwIfCancelled(signal);
    await applet.setPIN({pin: accessPIN!});
  } else {
    // A new Secret PIN also initializes an unset Access PIN in firmware.
    await applet.setPIN({secret: true, pin});
    if (accessPIN !== pin) {
      throwIfCancelled(signal);
      await applet.authenticate({secret: true, pin});
      throwIfCancelled(signal);
      await applet.setPIN({pin: accessPIN!});
    }
  }
  throwIfCancelled(signal);

  const initialized = MonoidAppletHello.satisfies(await applet.hello({}));
  throwIfCancelled(signal);

  assertSameCardWithBundle(initialized, readBackupCardIdentity(hello));

  assertCardPINsNotBlocked(initialized);

  if (initialized.pins.access === false || initialized.pins.secret === false) {
    throw new MonoidCardError('Card setup incomplete');
  }

  return initialized;
}
