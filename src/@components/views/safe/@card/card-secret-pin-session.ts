import {
  MONOID_PIN_MAX_LENGTH,
  MONOID_PIN_MIN_LENGTH,
  MonoidPIN,
} from '../../../../@atomics.js';
import {HeldPINs} from '../../../../@lib/held-pins.js';
import {
  type CardBackupIdentity,
  CardPINError,
  MonoidCardError,
  assertSameCardWithBundle,
} from '../../../../@lib/monoid/index.js';

type Identity = Pick<
  CardBackupIdentity,
  'id' | 'publicKey' | 'bundle' | 'alias'
>;
type Credentials = {pin: MonoidPIN; onAuthenticated: () => void};
type ProcedurePINs = {
  secretPINWriter(): (card: Identity, pin: MonoidPIN) => void;
  secretPIN(card: Identity): MonoidPIN | undefined;
  dropSecretPIN(card: Identity): void;
};

class SecretPINRequired extends Error {
  readonly code = 'CANCELLED';

  constructor(readonly card: Identity) {
    super('Enter Secret PIN');
  }
}

const key = (card: Identity): string =>
  JSON.stringify([card.id, card.publicKey, card.bundle]);

/** Verified Secret PINs for one visible page flow; never stored in the vault. */
export class CardSecretPINSession {
  private readonly pins = new HeldPINs<string, MonoidPIN>();

  constructor(private readonly procedure?: ProcedurePINs) {}

  private pin(card: Identity): MonoidPIN | undefined {
    return this.procedure
      ? this.procedure.secretPIN(card)
      : this.pins.get(key(card));
  }

  get signal(): AbortSignal {
    return this.pins.signal;
  }

  clear(): void {
    this.pins.clear();
  }

  private writer(): (card: Identity, pin: MonoidPIN) => void {
    const signal = this.signal;
    const hold = this.procedure?.secretPINWriter();
    return (card, pin) => {
      if (!signal.aborted) {
        if (hold) hold(card, pin);
        else this.pins.set(key(card), pin, signal);
      }
    };
  }

  onAuthenticated(card: Identity, pin: MonoidPIN): () => void {
    const hold = this.writer();
    return () => hold(card, pin);
  }

  async run(
    cards: readonly Identity[],
    requestPIN: (
      card: Identity | undefined,
      signal: AbortSignal,
      message?: string,
    ) => Promise<string | undefined>,
    scan: (
      credentials: (card: Identity) => Credentials,
      signal: AbortSignal,
    ) => Promise<void>,
  ): Promise<void> {
    const signal = this.signal;
    const hold = this.writer();
    let entered: MonoidPIN | undefined;
    let expected: Identity | undefined;
    let attempted: Identity | undefined;

    const request = async (
      card?: Identity,
      message?: string,
    ): Promise<boolean> => {
      const value = await requestPIN(card, signal, message);
      signal.throwIfAborted();
      if (value === undefined) return false;
      if (!MonoidPIN.is(value)) {
        throw new MonoidCardError(
          `Secret PIN must contain ${MONOID_PIN_MIN_LENGTH} to ${MONOID_PIN_MAX_LENGTH} characters`,
        );
      }
      entered = value;
      expected = card;
      return true;
    };

    try {
      if (!cards.some(card => this.pin(card) !== undefined)) {
        if (!(await request(cards.length === 1 ? cards[0] : undefined))) return;
      }
      for (;;) {
        signal.throwIfAborted();
        attempted = undefined;
        let authenticated = false;
        try {
          await scan(card => {
            signal.throwIfAborted();
            if (expected) assertSameCardWithBundle(card, expected);
            const pin = entered ?? this.pin(card);
            if (pin === undefined) throw new SecretPINRequired(card);
            // A PIN entered before an unknown card is scanned belongs only to
            // the first validated identity. It must never follow another tap.
            if (entered !== undefined) expected ??= card;
            attempted = card;
            return {
              pin,
              onAuthenticated: () => {
                authenticated = true;
                hold(card, pin);
              },
            };
          }, signal);
          return;
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof SecretPINRequired) {
            // The scanner has closed before opening a web PIN prompt. No
            // authentication or write was attempted on this handoff.
            if (!(await request(error.card))) return;
            continue;
          }
          if (
            attempted &&
            error instanceof CardPINError &&
            error.kind === 'Secret'
          ) {
            this.pins.delete(key(attempted));
            this.procedure?.dropSecretPIN(attempted);
            if (!authenticated && error.retryable && error.tries > 0) {
              entered = undefined;
              if (!(await request(attempted, error.message))) return;
              continue;
            }
          }
          throw error;
        }
      }
    } finally {
      entered = undefined;
    }
  }
}
