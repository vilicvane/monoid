import {AppletISOError} from '../applet.js';

import {type NamedCard, cardName, cardNameWithId} from './card-name.js';

/** A card failure with a message suitable for the scan prompt. */
export class MonoidCardError extends Error {}

export class MonoidWrongCardError extends MonoidCardError {
  constructor(
    readonly card: NamedCard,
    readonly keyChanged = false,
  ) {
    super(
      keyChanged
        ? `Card ${cardNameWithId(card)} was reset or reinstalled, start over`
        : `Wrong card, scan ${cardNameWithId(card)}`,
    );
  }
}

/** Only Authority Join interprets 6985 as a trusted-key mismatch. */
export function rethrowAuthorityJoinError(
  error: unknown,
  card: NamedCard,
): never {
  if (error instanceof AppletISOError && error.sw === 0x6985) {
    throw new MonoidCardError(
      `Card ${cardName(card)} trusts a different authority key.`,
      {cause: error},
    );
  }
  throw error;
}
