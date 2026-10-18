import type {IObservableArray} from 'mobx';
import {computed, observable, reaction, runInAction, toJS} from 'mobx';
import * as x from 'x-value';

import type {
  BIP39PathString,
  CurveName,
  PublicKeyHex,
  SafeIndexHex,
} from '../@atomics.js';
import type {AddressType} from '../@lib/wallet-address.js';
import {ADDRESS_TYPES, computeWalletAddress} from '../@lib/wallet-address.js';
import {hexToUint8Array} from '../@utils/index.js';

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

  addWallet(index: SafeIndexHex, source: WalletKeyPublicKeyData): void {
    const key = this.indexToKeyMap.get(index);

    if (!key || (key.type !== 'seed' && key.type !== 'master')) {
      return;
    }

    const existingIndex = key.wallets.findIndex(existing =>
      matchesWalletReference(existing, source),
    );

    runInAction(() => {
      if (existingIndex === -1) {
        key.wallets.push(source);
      } else {
        key.wallets[existingIndex] = source;
      }
    });
  }

  deleteWallet(
    index: SafeIndexHex,
    reference: WalletKeyWalletParameters,
  ): void {
    const key = this.indexToKeyMap.get(index);

    if (!key || (key.type !== 'seed' && key.type !== 'master')) {
      return;
    }

    const walletIndex = key.wallets.findIndex(wallet =>
      matchesWalletReference(wallet, reference),
    );

    if (walletIndex === -1) {
      return;
    }

    runInAction(() => {
      key.wallets.splice(walletIndex, 1);

      if (
        key.defaultWallet &&
        matchesWalletReference(key.defaultWallet, reference)
      ) {
        delete key.defaultWallet;
      }
    });
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

    return new WalletStorageService(storage, keys ?? []);
  }
}

export type WalletKeyData = {
  type: WalletKeyKnownType;
  index: SafeIndexHex;
  alias: string | undefined;
  publicKey?: PublicKeyHex;
  // The card returns an already tweaked, x-only Taproot output key.
  taprootOutputKey?: PublicKeyHex;
  wallets: WalletKeyPublicKeyData[];
  defaultWallet?: WalletKeyWalletParameters;
};

export type WalletKeyWalletParameters = {
  addressType: AddressType;
  seed: string | undefined;
  curve: CurveName | undefined;
  path: BIP39PathString | undefined;
};

export type WalletKeyWalletData = WalletKeyWalletParameters & {
  address: string;
};

export type WalletKeyPublicKeyData = WalletKeyWalletParameters & {
  publicKey: PublicKeyHex;
};

export function getWalletReference({
  addressType,
  seed,
  curve,
  path,
}: WalletKeyWalletParameters): WalletKeyWalletParameters {
  return {addressType, seed, curve, path};
}

export function matchesWalletReference(
  wallet: WalletKeyWalletParameters,
  reference: WalletKeyWalletParameters,
): boolean {
  return (
    wallet.addressType === reference.addressType &&
    wallet.seed === reference.seed &&
    wallet.curve === reference.curve &&
    wallet.path === reference.path
  );
}

export function getWalletData(
  source: WalletKeyPublicKeyData,
): WalletKeyWalletData {
  return {
    ...getWalletReference(source),
    address: computeWalletAddress(
      source.addressType,
      hexToUint8Array(source.publicKey),
    ),
  };
}

export function getKeyWallets(key: WalletKeyData): WalletKeyWalletData[] {
  if (key.type === 'seed' || key.type === 'master') {
    return key.wallets.map(getWalletData);
  }

  const wallets: WalletKeyWalletData[] = [];
  const add = (addressType: AddressType, publicKey: PublicKeyHex): void => {
    wallets.push(
      getWalletData({
        addressType,
        seed: undefined,
        curve: undefined,
        path: undefined,
        publicKey,
      }),
    );
  };

  if (key.publicKey) {
    if (key.type === 'secp256k1') {
      add('evm', key.publicKey);
      add('bitcoin-segwit', key.publicKey);
    } else {
      add('solana', key.publicKey);
    }
  }

  if (key.type === 'secp256k1' && key.taprootOutputKey) {
    add('bitcoin-taproot', key.taprootOutputKey);
  }

  return wallets;
}

export function getDefaultWallet(
  key: WalletKeyData,
  wallets: readonly WalletKeyWalletData[] = getKeyWallets(key),
): WalletKeyWalletData | undefined {
  const {defaultWallet} = key;

  return (
    (defaultWallet &&
      wallets.find(wallet => matchesWalletReference(wallet, defaultWallet))) ??
    wallets[0]
  );
}

export const WalletKeyKnownType = x.union([
  x.literal('seed').nominal<'safe known type'>(),
  x.literal('master').nominal<'safe known type'>(),
  x.literal('secp256k1').nominal<'safe known type'>(),
  x.literal('ed25519').nominal<'safe known type'>(),
]);

export type WalletKeyKnownType = x.TypeOf<typeof WalletKeyKnownType>;
