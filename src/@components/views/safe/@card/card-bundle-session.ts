import {observable, runInAction} from 'mobx';

import {MonoidPIN, PublicKey} from '../../../../@atomics.js';
import {CBORAppletError} from '../../../../@lib/cbor-applet.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidAppletInvalidPINError,
  MonoidCardError,
  MonoidWrongCardError,
} from '../../../../@lib/monoid/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../../@utils/index.js';
import type {ScannedCardData} from '../common.js';

export type CardBundleIdentity = {id: string; publicKey: string};
export type CardBundleCard = CardBundleIdentity & {
  status: 'pending' | 'complete';
  /** Latest round-two observation or ACK, absent after uncertain creation. */
  bundle?: string | false;
};
export type CardBundlePhase = 'collecting' | 'configuring' | 'complete';

type BundleState = {
  cards: readonly CardBundleCard[];
  phase: CardBundlePhase;
  bundle?: string;
  creator?: CardBundleIdentity;
  generationUncertain: boolean;
};

function readIdentity(
  card: CardBundleIdentity & {bundle: string | false},
): CardBundleIdentity {
  if (
    !/^[0-9a-f]{8}$/i.test(card.id) ||
    !/^04[0-9a-f]{128}$/i.test(card.publicKey) ||
    (card.bundle !== false && !/^[0-9a-f]{64}$/i.test(card.bundle))
  ) {
    throw new MonoidCardError('Invalid card identity');
  }
  return {id: card.id.toLowerCase(), publicKey: card.publicKey.toLowerCase()};
}

function readCardIdentity(hello: MonoidAppletHello): CardBundleIdentity {
  return readIdentity({
    id: uint8ArrayToHex(hello.id),
    publicKey: uint8ArrayToHex(hello.publicKey),
    bundle: hello.bundle === false ? false : uint8ArrayToHex(hello.bundle),
  });
}

function readCard(hello: MonoidAppletHello): CardBundleIdentity {
  const identity = readCardIdentity(hello);
  if (hello.pins.secret === 0) throw new MonoidCardError('Secret PIN blocked');
  if (hello.pins.access === 0) throw new MonoidCardError('Access PIN blocked');
  if (hello.pins.secret === false || hello.pins.access === false) {
    throw new MonoidCardError('Set up the card first');
  }

  return identity;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('Bundle setup cancelled'), {
      code: 'CANCELLED',
    });
  }
}

/** Keeps one fixed member list and its encrypted enrollment packets in memory. */
export class CardBundleSession {
  private readonly current = observable.box<BundleState>(
    {cards: [], phase: 'collecting', generationUncertain: false},
    {deep: false},
  );
  private readonly running = observable.box(false);
  private packets = new Map<string, string>();

  get cards(): readonly CardBundleCard[] {
    return this.current.get().cards;
  }

  get phase(): CardBundlePhase {
    return this.current.get().phase;
  }

  get bundle(): string | undefined {
    return this.current.get().bundle;
  }

  get creator(): CardBundleIdentity | undefined {
    return this.current.get().creator;
  }

  get generationUncertain(): boolean {
    return this.current.get().generationUncertain;
  }

  get configuredCount(): number {
    return this.cards.filter(card => card.status === 'complete').length;
  }

  get busy(): boolean {
    return this.running.get();
  }

  private setState(state: BundleState): void {
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

  private requireCollecting(): void {
    if (this.phase !== 'collecting') {
      throw new MonoidCardError('Bundle members are already confirmed');
    }
  }

  private validateAdditionIdentity(card: CardBundleIdentity): void {
    if (this.cards.some(current => current.publicKey === card.publicKey)) {
      throw new MonoidCardError('Card already added');
    }
    // All recipient packets share a signed-short-sized buffer in Identity:
    // (members - 1) * (116 + 65 * members) must fit within 32767 bytes.
    if (this.cards.length === 22) {
      throw new MonoidCardError('Too many cards');
    }
  }

  /** Validate collection before closing the scan or starting PIN/reset setup. */
  validateAddition(hello: MonoidAppletHello): void {
    this.requireCollecting();
    this.validateAdditionIdentity(readCardIdentity(hello));
  }

  private addIdentity(card: CardBundleIdentity, bundle: string | false): void {
    this.requireCollecting();
    if (bundle !== false) {
      throw new MonoidCardError('Card already belongs to a bundle');
    }
    this.validateAdditionIdentity(card);
    this.setState({
      ...this.current.get(),
      cards: [...this.cards, {...card, status: 'pending'}],
    });
  }

  addCard(hello: MonoidAppletHello): Promise<void> {
    return this.exclusive(() =>
      this.addIdentity(
        readCard(hello),
        hello.bundle === false ? false : uint8ArrayToHex(hello.bundle),
      ),
    );
  }

  /** Seed collection from a Card scan that already checked initialization. */
  addPreparedCard(
    card: Pick<ScannedCardData, 'id' | 'publicKey' | 'bundle'>,
  ): Promise<void> {
    return this.exclusive(() =>
      this.addIdentity(readIdentity(card), card.bundle),
    );
  }

  removeCard(publicKey: string): Promise<void> {
    return this.exclusive(() => {
      this.requireCollecting();
      if (!this.cards.some(card => card.publicKey === publicKey)) {
        throw new MonoidCardError('Card not found');
      }
      this.setState({
        ...this.current.get(),
        cards: this.cards.filter(card => card.publicKey !== publicKey),
      });
    });
  }

  beginRoundTwo(): Promise<void> {
    return this.exclusive(() => {
      this.requireCollecting();
      if (this.cards.length < 2) {
        throw new MonoidCardError('Add at least two cards');
      }
      this.setState({...this.current.get(), phase: 'configuring'});
    });
  }

  private requireConfiguring(): void {
    if (this.generationUncertain) {
      throw new MonoidCardError('Bundle creation not confirmed');
    }
    if (this.phase !== 'configuring') {
      throw new MonoidCardError(
        this.phase === 'complete'
          ? 'Bundle setup complete'
          : 'Confirm cards first',
      );
    }
  }

  private validateMember(hello: MonoidAppletHello): CardBundleCard {
    this.requireConfiguring();
    const identity = readCardIdentity(hello);
    const card = this.cards.find(card => card.publicKey === identity.publicKey);
    if (!card) throw new MonoidCardError('Scan one of the added cards');
    if (card.id !== identity.id) throw new MonoidWrongCardError(card.id);
    if (card.status === 'complete') {
      throw new MonoidCardError('Card already configured');
    }
    return card;
  }

  /** Validate the current tap before the caller sends any credentials. */
  validateCard(hello: MonoidAppletHello): CardBundleCard {
    const card = this.validateMember(hello);
    this.requireReadyCard(hello);
    return card;
  }

  private requireReadyCard(hello: MonoidAppletHello): void {
    readCard(hello);
    if (
      hello.bundle !== false &&
      uint8ArrayToHex(hello.bundle) !== this.bundle
    ) {
      throw new MonoidCardError('Card already belongs to another bundle');
    }
  }

  private setCardBundle(
    publicKey: string,
    bundle: string | false | undefined,
  ): void {
    this.setState({
      ...this.current.get(),
      cards: this.cards.map(card =>
        card.publicKey === publicKey ? {...card, bundle} : card,
      ),
    });
  }

  private markComplete(publicKey: string): void {
    const cards = this.cards.map(card =>
      card.publicKey === publicKey
        ? {...card, status: 'complete' as const, bundle: this.bundle!}
        : card,
    );
    this.setState({
      ...this.current.get(),
      cards,
      phase: cards.every(card => card.status === 'complete')
        ? 'complete'
        : 'configuring',
    });
  }

  private acceptCreation(
    creator: CardBundleCard,
    response: Awaited<ReturnType<MonoidApplet['createBundle']>>,
  ): void {
    const recipients = this.cards.filter(
      card => card.publicKey !== creator.publicKey,
    );
    const members = this.cards.map(card => card.publicKey).sort();
    if (
      response.bundle.length !== 32 ||
      response.data.length !== recipients.length
    ) {
      throw new MonoidCardError('Incomplete bundle response');
    }
    const packets = new Map<string, string>();
    for (const [index, data] of response.data.entries()) {
      if (
        data.length !== 116 + 65 * members.length ||
        data[0] !== 1 ||
        ((data[1] << 8) | data[2]) !== members.length ||
        members.some(
          (key, index) =>
            uint8ArrayToHex(
              data.subarray(3 + index * 65, 3 + (index + 1) * 65),
            ) !== key,
        )
      ) {
        throw new MonoidCardError('Incomplete bundle response');
      }
      packets.set(recipients[index].publicKey, uint8ArrayToHex(data));
    }
    this.packets = packets;
    this.setState({
      ...this.current.get(),
      bundle: uint8ArrayToHex(response.bundle),
      generationUncertain: false,
    });
    this.markComplete(creator.publicKey);
  }

  configureCard(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    pin: string,
    signal: AbortSignal,
  ): Promise<void> {
    return this.exclusive(async () => {
      const card = this.validateCard(hello);
      if (!MonoidPIN.is(pin)) {
        throw new MonoidCardError('Secret PIN must contain 6 to 16 characters');
      }
      throwIfCancelled(signal);
      const currentBundle =
        hello.bundle === false ? false : uint8ArrayToHex(hello.bundle);
      this.setCardBundle(card.publicKey, currentBundle);
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
          );
        }
        throw error;
      }
      throwIfCancelled(signal);

      if (this.bundle === undefined) {
        this.setCardBundle(card.publicKey, undefined);
        this.setState({
          ...this.current.get(),
          creator: {id: card.id, publicKey: card.publicKey},
          generationUncertain: true,
        });
        try {
          const response = await applet.createBundle({
            publicKeys: this.cards
              .filter(member => member.publicKey !== card.publicKey)
              .map(member =>
                PublicKey.satisfies(hexToUint8Array(member.publicKey)),
              ),
          });
          this.acceptCreation(card, response);
        } catch {
          // The card may have published its key before the response was lost.
          // Create cannot recover the lost packets once the Bundle exists.
          throw new MonoidCardError('Bundle creation not confirmed');
        }
      } else {
        const response = await applet.joinBundle({
          publicKey: PublicKey.satisfies(
            hexToUint8Array(this.creator!.publicKey),
          ),
          data: hexToUint8Array(this.packets.get(card.publicKey)!),
        });
        if (uint8ArrayToHex(response.bundle) !== this.bundle) {
          this.setCardBundle(card.publicKey, undefined);
          throw new MonoidCardError('Card returned a different bundle');
        }
        this.markComplete(card.publicKey);
      }
      // Publish acknowledged progress even if cancellation arrived during an APDU.
      throwIfCancelled(signal);
    });
  }
}
