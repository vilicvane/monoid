import {MonoidCardError} from './card-error.js';
import type {MonoidAppletHello} from './monoid-applet.js';

export function assertCardPINNotBlocked(
  hello: MonoidAppletHello,
  kind: 'access' | 'secret',
): void {
  if (hello.pins[kind] === 0) {
    throw new MonoidCardError(
      kind === 'secret' ? 'Secret PIN blocked' : 'Access PIN blocked',
    );
  }
}

/** Setup permits unset PINs and reports a blocked Secret PIN first. */
export function assertCardPINsNotBlocked(hello: MonoidAppletHello): void {
  assertCardPINNotBlocked(hello, 'secret');
  assertCardPINNotBlocked(hello, 'access');
}

export function assertCardPINs(
  hello: MonoidAppletHello,
  {secret = false}: {secret?: boolean} = {},
): void {
  if (hello.pins.access === false || hello.pins.secret === false) {
    throw new MonoidCardError('Set up card PINs first');
  }

  assertCardPINNotBlocked(hello, 'access');
  if (secret) assertCardPINNotBlocked(hello, 'secret');
}
