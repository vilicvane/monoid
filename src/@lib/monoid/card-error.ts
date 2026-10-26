import {type NamedCard, cardNameWithId} from './card-name.js';

/** A card failure with a message suitable for the scan prompt. */
export class MonoidCardError extends Error {}

export class MonoidWrongCardError extends MonoidCardError {
  constructor(readonly card: NamedCard) {
    super(`Wrong card, scan ${cardNameWithId(card)}`);
  }
}
