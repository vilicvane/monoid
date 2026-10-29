import type {MonoidPIN} from '../../@atomics.js';
import {CBORAppletError} from '../cbor-applet.js';

import {MonoidCardError} from './card-error.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidAppletInvalidPINError,
} from './monoid-applet.js';

/** Only a rejected authentication before card writes permits another PIN attempt. */
export class CardPINError extends MonoidCardError {
  constructor(
    readonly kind: 'Secret' | 'Access',
    readonly tries: number,
    readonly retryable: boolean,
    cause: unknown,
  ) {
    super(
      tries === 0
        ? `${kind} PIN blocked`
        : `Incorrect PIN, tries remaining: ${tries}`,
      {cause},
    );
  }
}

export async function authenticateCardPIN(
  applet: MonoidApplet,
  pin: MonoidPIN,
  {
    kind = 'Secret',
    retryable = true,
  }: {
    kind?: 'Secret' | 'Access';
    retryable?: boolean;
  } = {},
): Promise<void> {
  try {
    await applet.authenticate({pin, ...(kind === 'Secret' && {secret: true})});
  } catch (error) {
    if (
      error instanceof CBORAppletError &&
      MonoidAppletInvalidPINError.is(error.source)
    ) {
      throw new CardPINError(kind, error.source.tries, retryable, error);
    }
    throw error;
  }
}

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
