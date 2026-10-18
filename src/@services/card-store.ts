import {makeAutoObservable, toJS} from 'mobx';

import type {MonoidSafeIdHex, PublicKeyHex, SafeIndexHex} from '../@atomics.js';
import type {
  ScannedCardData,
  ScannedCardItemData,
  ScannedCardKeyData,
} from '../@components/views/safe/index.js';
import type {AddressType} from '../@lib/wallet-address.js';

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
  key: string | undefined;
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
    this.key = item.key;
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
  readonly id: MonoidSafeIdHex;
  readonly publicKey: PublicKeyHex;
  items: CardItem[];

  constructor(card: ScannedCardData) {
    this.id = card.id;
    this.publicKey = card.publicKey;
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
      items: this.items.map(item => ({
        index: item.index,
        ...(item.type !== undefined && {type: item.type}),
        ...(item.alias !== undefined && {alias: item.alias}),
        ...(item.key !== undefined && {key: item.key}),
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

  set(card: ScannedCardData): CardState {
    const existing = this.get(card);

    if (existing) {
      existing.items = card.items.map(item => new CardItem(item));
      return existing;
    }

    const added = new CardState(card);
    this.cards.set(`${card.id}:${card.publicKey}`, added);
    return added;
  }
}
