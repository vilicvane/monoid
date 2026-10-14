import type {IObservableArray} from 'mobx';
import {computed, observable, reaction, toJS} from 'mobx';
import * as x from 'x-value';

import type {BIP39PathString, CurveName, SafeIndexHex} from '../@atomics.js';
import type {AddressType} from '../@lib/wallet-address.js';
import {ADDRESS_TYPES} from '../@lib/wallet-address.js';

import type {StorageService} from './index.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    walletKeys: WalletKeyData[];
  }
}

export class WalletStorageService {
  readonly keys: IObservableArray<WalletKeyData>;

  constructor(storage: StorageService, keys: WalletKeyData[]) {
    this.keys = observable(keys);

    reaction(
      () => toJS(this.keys),
      keys => {
        console.info('Saving wallet keys:', keys);
        storage.set('walletKeys', keys).catch(console.error);
      },
    );

    // this.keys.clear();
  }

  private computedIndexToKeyMap = computed(
    () => new Map(this.keys.map(key => [key.index, key])),
  );

  get indexToKeyMap(): Map<SafeIndexHex, WalletKeyData> {
    return this.computedIndexToKeyMap.get();
  }

  suggestNextDerivationPath(
    index: SafeIndexHex,
    addressType: AddressType,
  ): BIP39PathString {
    const key = this.indexToKeyMap.get(index);

    const pathSet = new Set(
      key?.wallets
        .filter(wallet => wallet.addressType === addressType)
        .map(wallet => wallet.path),
    );

    // eslint-disable-next-line no-constant-condition
    for (let index = 0; true; index++) {
      const path = ADDRESS_TYPES[addressType].path(index);

      if (!pathSet.has(path)) {
        return path;
      }
    }
  }

  static async create(storage: StorageService): Promise<WalletStorageService> {
    const keys = await storage.get('walletKeys');

    // Records saved before address types were introduced contain EVM addresses.
    for (const key of keys ?? []) {
      for (const wallet of key.wallets) {
        wallet.addressType ??= 'evm';
      }
    }

    return new WalletStorageService(storage, keys ?? []);
  }
}

export type WalletKeyData = {
  type: WalletKeyKnownType;
  index: SafeIndexHex;
  alias: string | undefined;
  wallets: WalletKeyWalletData[];
};

export type WalletKeyWalletData = {
  addressType: AddressType;
  seed: string | undefined;
  curve: CurveName | undefined;
  path: BIP39PathString | undefined;
  address: string;
};

export const WalletKeyKnownType = x.union([
  x.literal('seed').nominal<'safe known type'>(),
  x.literal('master').nominal<'safe known type'>(),
  x.literal('secp256k1').nominal<'safe known type'>(),
]);

export type WalletKeyKnownType = x.TypeOf<typeof WalletKeyKnownType>;
