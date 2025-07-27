import type {IObservableArray} from 'mobx';
import {observable, reaction, toJS} from 'mobx';
import * as x from 'x-value';

import type {
  BIP39PathString,
  CurveName,
  EthereumAddress,
  MonoidAppletIdHex,
  SafeIndexHex,
} from '../@atomics.js';

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
  }

  static async create(storage: StorageService): Promise<WalletStorageService> {
    const keys = await storage.get('walletKeys');

    return new WalletStorageService(storage, keys ?? []);
  }
}

export type WalletKeyData = {
  type: WalletKeyKnownType;
  index: SafeIndexHex;
  alias: string | undefined;
  wallets: WalletKeyWalletData[];
  source: MonoidAppletIdHex;
};

export type WalletKeyWalletData = {
  seed: string | undefined;
  curve: CurveName | undefined;
  path: BIP39PathString | undefined;
  address: EthereumAddress;
};

export const WalletKeyKnownType = x.union([
  x.literal('seed').nominal<'safe known type'>(),
  x.literal('master').nominal<'safe known type'>(),
  x.literal('secp256k1').nominal<'safe known type'>(),
]);

export type WalletKeyKnownType = x.TypeOf<typeof WalletKeyKnownType>;
