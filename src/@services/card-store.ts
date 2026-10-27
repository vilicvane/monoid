import {makeAutoObservable, runInAction, toJS} from 'mobx';

import type {MonoidIdHex, PublicKeyHex, SafeIndexHex} from '../@atomics.js';
import type {
  ScannedCardData,
  ScannedCardItemData,
  ScannedCardKeyData,
} from '../@components/views/safe/index.js';
import type {MonoidApplet, MonoidAppletHello} from '../@lib/monoid/index.js';
import type {AddressType} from '../@lib/wallet-address.js';
import {uint8ArrayToHex} from '../@utils/index.js';

import {
  type WalletKeyPublicKeyData,
  getWalletData,
  matchesWalletReference,
} from './wallet-storage-service.js';

export type CardIdentity = Pick<ScannedCardData, 'id' | 'publicKey'>;

export class CardItem implements ScannedCardItemData {
  readonly index: SafeIndexHex;
  type: ScannedCardItemData['type'];
  alias: string | undefined;
  metadata: string | undefined;
  secret: boolean;
  publicKey: PublicKeyHex | undefined;
  derivationRecord: ScannedCardItemData['derivationRecord'];
  derivations: ScannedCardItemData['derivations'];
  addressType: AddressType | undefined;
  refs: Partial<Record<AddressType, ScannedCardKeyData['ref']>> = {};

  constructor(item: ScannedCardItemData) {
    this.index = item.index;
    this.secret = item.secret;
    this.update(item);
    this.addressType ??= item.derivations?.[0]?.addressType;
    makeAutoObservable(this, {index: false});
  }

  get ref(): ScannedCardKeyData['ref'] | undefined {
    return this.addressType ? this.refs[this.addressType] : undefined;
  }

  set ref(value: ScannedCardKeyData['ref'] | undefined) {
    if (value) {
      this.refs[value.addressType] = value;
      this.addressType = value.addressType;
    } else if (this.addressType) {
      delete this.refs[this.addressType];
    }
  }

  update(item: ScannedCardItemData): void {
    this.type = item.type;
    this.alias = item.alias;
    this.metadata = item.metadata;
    this.secret = item.secret;
    this.publicKey = item.publicKey;
    this.derivationRecord = item.derivationRecord;
    this.derivations = item.derivations;

    for (const wallet of item.derivations ?? []) {
      this.refs[wallet.addressType] ??= {
        ...wallet,
        address: getWalletData(wallet).address,
      };
    }
    if (item.ref) this.ref = item.ref;
  }

  setRecordedWallets(wallets: WalletKeyPublicKeyData[]): void {
    const previous = this.ref;
    const displayed =
      wallets.find(
        wallet =>
          previous &&
          matchesWalletReference(wallet, {
            addressType: previous.addressType,
            seed: previous.seed,
            curve: previous.curve,
            path: previous.path,
          }),
      ) ??
      wallets.find(wallet => wallet.addressType === this.addressType) ??
      wallets[0];
    const refs: CardItem['refs'] = {};

    for (const wallet of wallets) {
      refs[wallet.addressType] ??= {
        ...wallet,
        address: getWalletData(wallet).address,
      };
    }
    if (displayed) {
      refs[displayed.addressType] = {
        ...displayed,
        address: getWalletData(displayed).address,
      };
    }

    this.derivations = wallets;
    this.refs = refs;
    this.addressType = displayed?.addressType ?? this.addressType;
  }
}

export class CardState implements ScannedCardData {
  readonly id: MonoidIdHex;
  readonly publicKey: PublicKeyHex;
  bundle: string | false;
  alias: string | false;
  authority: string | false;
  allowPeerExtension: boolean;
  items: CardItem[];
  /** Reset invalidates the initialization assumed by the original Card scan. */
  requiresPINSetup = false;

  constructor(card: ScannedCardData) {
    this.id = card.id;
    this.publicKey = card.publicKey;
    this.bundle = card.bundle;
    this.alias = card.alias;
    this.authority = card.authority;
    this.allowPeerExtension = card.allowPeerExtension;
    this.items = card.items.map(item => new CardItem(item));
    makeAutoObservable(this, {id: false, publicKey: false});
  }

  upsert(item: ScannedCardItemData): CardItem {
    const existing = this.items.find(current => current.index === item.index);

    if (existing) {
      existing.update(item);
      return existing;
    }

    const added = new CardItem(item);
    this.items.push(added);
    return added;
  }

  snapshot(): ScannedCardData {
    return {
      id: this.id,
      publicKey: this.publicKey,
      bundle: this.bundle,
      alias: this.alias,
      authority: this.authority,
      allowPeerExtension: this.allowPeerExtension,
      items: this.items.map(item => ({
        index: item.index,
        ...(item.type !== undefined && {type: item.type}),
        ...(item.alias !== undefined && {alias: item.alias}),
        ...(item.metadata !== undefined && {metadata: item.metadata}),
        secret: item.secret,
        ...(item.publicKey !== undefined && {publicKey: item.publicKey}),
        ...(item.ref !== undefined && {ref: toJS(item.ref)}),
        ...(item.derivations !== undefined && {
          derivations: toJS(item.derivations),
        }),
        ...(item.derivationRecord !== undefined && {
          derivationRecord: toJS(item.derivationRecord),
        }),
      })),
    };
  }
}

export class CardStore {
  private readonly cards = new Map<string, CardState>();

  constructor() {
    makeAutoObservable(this);
  }

  get(identity: CardIdentity): CardState | undefined {
    return this.cards.get(`${identity.id}:${identity.publicKey}`);
  }

  /** Card mutations can invalidate the scanned resource list and address previews. */
  forget(identity: CardIdentity): void {
    this.cards.delete(`${identity.id}:${identity.publicKey}`);
  }

  /** Observe each connection's Hello, including a new identity after reset. */
  observeApplet(
    applet: MonoidApplet,
    initialHello?: MonoidAppletHello,
  ): MonoidApplet {
    const identities = new WeakMap<MonoidApplet, MonoidAppletHello>();
    const store = this;
    const observe = (
      connection: MonoidApplet,
      hello: MonoidAppletHello,
    ): void => {
      identities.set(connection, hello);
      const cached = store.get({
        id: uint8ArrayToHex(hello.id),
        publicKey: uint8ArrayToHex(hello.publicKey),
      });
      if (cached)
        runInAction(() => {
          cached.alias = hello.alias;
          cached.authority = hello.authority;
          cached.allowPeerExtension = hello.allowPeerExtension;
          cached.bundle =
            hello.bundle === false ? false : uint8ArrayToHex(hello.bundle);
        });
    };
    const observed: MonoidApplet = Object.create(applet, {
      hello: {
        async value(
          this: MonoidApplet,
          request: Parameters<MonoidApplet['hello']>[0],
        ) {
          const hello = await applet.hello.call(this, request);
          observe(this, hello);
          return hello;
        },
      },
      // PINs and extension packets do not change cached items or membership.
      ...Object.fromEntries(
        (
          [
            'create',
            'set',
            'setAlias',
            'remove',
            'importItem',
            'createRandomKey',
            'setAppletGrant',
            'removeAppletGrant',
            'createBundle',
            'joinBundle',
            'reset',
          ] as const
        ).map(name => [
          name,
          {
            async value(this: MonoidApplet, request: never) {
              // Every writable connection greets the card before authentication.
              const hello = identities.get(this)!;
              const identity = {
                id: uint8ArrayToHex(hello.id),
                publicKey: uint8ArrayToHex(hello.publicKey),
              };
              try {
                const command: (request: never) => Promise<unknown> =
                  applet[name];
                return await command.call(this, request);
              } finally {
                // A lost acknowledgement may still have changed the card. Never retry.
                store.forget(identity);
              }
            },
          },
        ]),
      ),
    });
    if (initialHello) observe(observed, initialHello);
    return observed;
  }

  set(card: ScannedCardData): CardState {
    if (card instanceof CardState) {
      this.cards.set(`${card.id}:${card.publicKey}`, card);
      return card;
    }

    const existing = this.get(card);

    if (existing) {
      existing.bundle = card.bundle;
      existing.alias = card.alias;
      existing.authority = card.authority;
      existing.allowPeerExtension = card.allowPeerExtension;
      existing.items = card.items.map(item => new CardItem(item));
      existing.requiresPINSetup = false;
      return existing;
    }

    const added = new CardState(card);
    this.cards.set(`${card.id}:${card.publicKey}`, added);
    return added;
  }
}
