import {observable, runInAction} from 'mobx';

import {
  MonoidIdHex,
  MonoidPIN,
  PublicKey,
  PublicKeyHex,
} from '../../../../@atomics.js';
import {CBORAppletError} from '../../../../@lib/cbor-applet.js';
import {
  type CardIdentity,
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidAppletInvalidPINError,
  MonoidCardError,
  assertCardPINsNotBlocked,
  assertSameCard,
} from '../../../../@lib/monoid/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../../@utils/index.js';
import type {ScannedCardData} from '../common.js';

export type CardBundleExtensionPhase =
  | 'collecting'
  | 'requesting'
  | 'approving'
  | 'joining'
  | 'complete';

type ExtensionState = {
  phase: CardBundleExtensionPhase;
  target?: CardIdentity;
  requester?: CardIdentity;
  approver?: CardIdentity;
};

function readIdentity(
  card: Pick<ScannedCardData, 'id' | 'publicKey' | 'bundle'>,
): CardIdentity {
  if (
    !/^[0-9a-f]{8}$/i.test(card.id) ||
    !/^04[0-9a-f]{128}$/i.test(card.publicKey) ||
    (card.bundle !== false && !/^[0-9a-f]{64}$/i.test(card.bundle))
  ) {
    throw new MonoidCardError('Invalid card identity');
  }
  return {
    id: MonoidIdHex.satisfies(card.id.toLowerCase()),
    publicKey: PublicKeyHex.satisfies(card.publicKey.toLowerCase()),
  };
}

function readCardIdentity(hello: MonoidAppletHello): CardIdentity {
  return readIdentity({
    id: uint8ArrayToHex(hello.id),
    publicKey: uint8ArrayToHex(hello.publicKey),
    bundle: hello.bundle === false ? false : uint8ArrayToHex(hello.bundle),
  });
}

function requireReadyCard(hello: MonoidAppletHello): void {
  assertCardPINsNotBlocked(hello);
  if (hello.pins.secret === false || hello.pins.access === false) {
    throw new MonoidCardError('Set up the card first');
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('Bundle extension cancelled'), {
      code: 'CANCELLED',
    });
  }
}

/** Keeps one target and its opaque extension packets in the current flow. */
export class CardBundleExtensionSession {
  readonly source: CardIdentity;
  readonly bundle: string;
  private readonly current = observable.box<ExtensionState>(
    {phase: 'collecting'},
    {deep: false},
  );
  private readonly running = observable.box(false);
  private request?: Uint8Array;
  private enrollment?: Awaited<
    ReturnType<MonoidApplet['approveBundleExtension']>
  >;

  constructor(source: Pick<ScannedCardData, 'id' | 'publicKey' | 'bundle'>) {
    this.source = readIdentity(source);
    if (source.bundle === false) {
      throw new MonoidCardError('Card does not belong to a bundle');
    }
    this.bundle = source.bundle.toLowerCase();
  }

  get phase(): CardBundleExtensionPhase {
    return this.current.get().phase;
  }

  get target(): CardIdentity | undefined {
    return this.current.get().target;
  }

  get requester(): CardIdentity | undefined {
    return this.current.get().requester;
  }

  get approver(): CardIdentity | undefined {
    return this.current.get().approver;
  }

  get busy(): boolean {
    return this.running.get();
  }

  private setState(state: ExtensionState): void {
    runInAction(() => this.current.set(state));
  }

  private async exclusive(
    operation: () => void | Promise<void>,
  ): Promise<void> {
    if (this.busy) throw new MonoidCardError('Card setup already in progress');
    runInAction(() => this.running.set(true));
    try {
      await operation();
    } finally {
      runInAction(() => this.running.set(false));
    }
  }

  private requireEditableTarget(): void {
    if (this.phase !== 'collecting' && this.phase !== 'requesting') {
      throw new MonoidCardError('New card is already confirmed');
    }
  }

  private validateTarget(
    card: CardIdentity,
    bundle: string | false,
    allowOtherBundle = false,
  ): void {
    this.requireEditableTarget();
    if (card.publicKey === this.source.publicKey) {
      throw new MonoidCardError('Scan a new card');
    }
    if (bundle !== false && (!allowOtherBundle || bundle === this.bundle)) {
      throw new MonoidCardError('Card already belongs to a bundle');
    }
    if (this.target) {
      assertSameCard(card, this.target);
    }
  }

  /** Check identity before PIN initialization or a Card Applets handoff. */
  validateAddition(hello: MonoidAppletHello): void {
    this.validateTarget(
      readCardIdentity(hello),
      hello.bundle === false ? false : uint8ArrayToHex(hello.bundle),
      true,
    );
  }

  addCard(hello: MonoidAppletHello): Promise<void> {
    return this.exclusive(() => {
      const target = readCardIdentity(hello);
      this.validateTarget(
        target,
        hello.bundle === false ? false : uint8ArrayToHex(hello.bundle),
      );
      requireReadyCard(hello);
      this.setState({...this.current.get(), phase: 'requesting', target});
    });
  }

  /** Return from Card Applets after that flow has initialized the new card. */
  addPreparedCard(
    card: Pick<ScannedCardData, 'id' | 'publicKey' | 'bundle'>,
  ): Promise<void> {
    return this.exclusive(() => {
      const target = readIdentity(card);
      this.validateTarget(target, card.bundle);
      this.setState({...this.current.get(), phase: 'requesting', target});
    });
  }

  removeTarget(): Promise<void> {
    return this.exclusive(() => {
      this.requireEditableTarget();
      this.setState({phase: 'collecting'});
    });
  }

  /** Validate every tap before sending credentials to the card. */
  validateCard(hello: MonoidAppletHello): void {
    const card = readCardIdentity(hello);
    const bundle =
      hello.bundle === false ? false : uint8ArrayToHex(hello.bundle);
    switch (this.phase) {
      case 'requesting':
        if (this.requester) assertSameCard(card, this.requester);
        if (card.publicKey === this.target!.publicKey) {
          throw new MonoidCardError('Scan a bundle card');
        }
        if (bundle !== this.bundle) {
          throw new MonoidCardError('Card belongs to a different bundle');
        }
        break;
      case 'approving':
        if (card.publicKey === this.requester!.publicKey) {
          throw new MonoidCardError('Scan another bundle card');
        }
        if (
          card.publicKey === this.target!.publicKey ||
          bundle !== this.bundle
        ) {
          throw new MonoidCardError('Scan another bundle card');
        }
        break;
      case 'joining':
        assertSameCard(card, this.target!);
        if (bundle !== false && bundle !== this.bundle) {
          throw new MonoidCardError('Card belongs to a different bundle');
        }
        break;
      default:
        throw new MonoidCardError(
          this.phase === 'complete'
            ? 'Bundle extension complete'
            : 'Add a card first',
        );
    }
    requireReadyCard(hello);
  }

  configureCard(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    pin: string,
    signal: AbortSignal,
    onAuthenticated?: () => void,
  ): Promise<void> {
    return this.exclusive(async () => {
      this.validateCard(hello);
      if (!MonoidPIN.is(pin)) {
        throw new MonoidCardError('Secret PIN must contain 6 to 16 characters');
      }
      throwIfCancelled(signal);
      try {
        await applet.authenticate({secret: true, pin});
      } catch (error) {
        if (
          error instanceof CBORAppletError &&
          MonoidAppletInvalidPINError.is(error.source)
        ) {
          throw new MonoidCardError(
            error.source.tries === 0
              ? 'Secret PIN blocked'
              : `Incorrect Secret PIN, tries remaining: ${error.source.tries}`,
            {cause: error},
          );
        }
        throw error;
      }
      onAuthenticated?.();
      throwIfCancelled(signal);

      switch (this.phase) {
        case 'requesting': {
          // An uncertain response must be retried with the same requester.
          this.setState({
            ...this.current.get(),
            requester: readCardIdentity(hello),
          });
          const response = await applet.extendBundle({
            publicKey: PublicKey.satisfies(
              hexToUint8Array(this.target!.publicKey),
            ),
          });
          if (response.data.length === 0) {
            throw new MonoidCardError('Incomplete bundle response');
          }
          this.request = response.data.slice();
          this.setState({...this.current.get(), phase: 'approving'});
          break;
        }
        case 'approving': {
          const response = await applet.approveBundleExtension({
            data: this.request!.slice(),
          });
          const approver = readCardIdentity(hello);
          if (
            uint8ArrayToHex(response.publicKey) !== approver.publicKey ||
            response.data.length === 0
          ) {
            throw new MonoidCardError('Incomplete bundle response');
          }
          this.enrollment = {
            publicKey: PublicKey.satisfies(response.publicKey.slice()),
            data: response.data.slice(),
          };
          this.setState({...this.current.get(), phase: 'joining', approver});
          break;
        }
        case 'joining': {
          const response = await applet.joinBundle({
            publicKey: PublicKey.satisfies(this.enrollment!.publicKey.slice()),
            data: this.enrollment!.data.slice(),
          });
          if (uint8ArrayToHex(response.bundle) !== this.bundle) {
            throw new MonoidCardError('Card returned a different bundle');
          }
          this.request = undefined;
          this.enrollment = undefined;
          this.setState({...this.current.get(), phase: 'complete'});
          break;
        }
      }
      // Keep acknowledged progress if cancellation arrived during the APDU.
      throwIfCancelled(signal);
    });
  }
}
