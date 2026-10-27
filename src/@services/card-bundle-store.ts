import {makeAutoObservable, observable, runInAction} from 'mobx';

import type {
  AuthorityBundleSession,
  CardBundleExtensionSession,
  CardBundleSession,
  CardResetSession,
} from '../@components/views/safe/index.js';
import {type MonoidAppletHello, MonoidCardError} from '../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../@utils/index.js';

/** Flow state survives Card Applets; Secret PINs use their expiring memory holder. */
export class BundleSetupState {
  sourceConsumed = false;
  informationForwarded = false;
  bundle: 'card' | 'authority' | undefined;
  pendingReset: CardResetSession | undefined;
  authority: AuthorityBundleSession | undefined;

  constructor(readonly session: CardBundleSession) {
    makeAutoObservable(this, {
      session: false,
      pendingReset: observable.ref,
      authority: observable.ref,
    });
  }
}

export class CardBundleStore {
  private readonly flows = new Map<string, BundleSetupState>();
  private readonly extensions = new Map<string, CardBundleExtensionSession>();
  private readonly extensionCards = observable.map<string, MonoidAppletHello>(
    {},
    {deep: false},
  );

  getOrCreateExtension(
    id: string,
    createSession: () => CardBundleExtensionSession,
  ): CardBundleExtensionSession {
    let session = this.extensions.get(id);
    if (!session) {
      session = createSession();
      this.extensions.set(id, session);
    }
    return session;
  }

  async acceptExtensionCard(
    id: string,
    hello: MonoidAppletHello,
  ): Promise<void> {
    const session = this.extensions.get(id);
    if (!session) {
      throw new MonoidCardError('Bundle extension is no longer available');
    }
    if (!['collecting', 'requesting'].includes(session.phase)) {
      throw new MonoidCardError('New card is already confirmed');
    }
    if (!hello.pins.access || !hello.pins.secret) {
      throw new MonoidCardError('Set up the card first');
    }
    // Installation can retain a foreign Bundle. Let the addition flow request
    // its existing reset confirmation after returning from Card Applets.
    runInAction(() => this.extensionCards.set(id, hello));
  }

  getExtensionCard(id: string): MonoidAppletHello | undefined {
    return this.extensionCards.get(id);
  }

  consumeExtensionCard(id: string): void {
    runInAction(() => this.extensionCards.delete(id));
  }

  get(id: string): BundleSetupState | undefined {
    return this.flows.get(id);
  }

  getOrCreate(
    id: string,
    createSession: () => CardBundleSession,
  ): BundleSetupState {
    let flow = this.flows.get(id);
    if (!flow) {
      flow = new BundleSetupState(createSession());
      this.flows.set(id, flow);
    }
    return flow;
  }

  async acceptInstalledCard(
    id: string,
    hello: MonoidAppletHello,
  ): Promise<void> {
    const flow = this.get(id);
    if (flow?.bundle === 'authority') {
      if (!flow.authority || flow.authority.complete) {
        throw new MonoidCardError('Bundle setup is no longer accepting cards');
      }
      runInAction(() => {
        flow.authority!.installedCard = hello;
      });
      return;
    }
    if (!flow || flow.session.phase !== 'collecting') {
      throw new MonoidCardError('Bundle setup is no longer accepting cards');
    }
    if (hello.bundle !== false || !hello.pins.access || !hello.pins.secret) {
      throw new MonoidCardError('Set up the card first');
    }
    const existing = flow.session.cards.find(
      card => card.publicKey === uint8ArrayToHex(hello.publicKey),
    );
    if (existing) {
      if (existing.id !== uint8ArrayToHex(hello.id)) {
        throw new MonoidCardError('Card identity changed');
      }
      return;
    }
    await flow.session.addCard(hello);
  }
}
