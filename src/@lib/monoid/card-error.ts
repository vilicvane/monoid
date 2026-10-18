/** A card failure with a message suitable for the scan prompt. */
export class MonoidCardError extends Error {}

export class MonoidWrongCardError extends MonoidCardError {
  constructor(readonly expectedId: string) {
    super(`Wrong card, scan ${expectedId}`);
  }
}
