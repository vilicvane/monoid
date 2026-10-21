import {makeAutoObservable, observable} from 'mobx';

import type {
  CardBundleSession,
  CardResetSession,
} from '../@components/views/safe/index.js';
import {type MonoidAppletHello, MonoidCardError} from '../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../@utils/index.js';

/** Only non-secret flow state survives the Card maintenance detour. */
export class BundleSetupState {
  sourceConsumed = false;
  informationForwarded = false;
  bundleEnabled = false;
  pendingReset: CardResetSession | undefined;

  constructor(readonly session: CardBundleSession) {
    makeAutoObservable(this, {
      session: false,
      pendingReset: observable.ref,
    });
  }
}

export class CardBundleStore {
  private readonly flows = new Map<string, BundleSetupState>();

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
