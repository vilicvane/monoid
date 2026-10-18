import type {PublicKeyHex} from '../@atomics.js';
import {
  type WalletKeyData,
  type WalletKeyWalletData,
  getKeyWallets,
} from '../@services/index.js';

import type {MonoidAppletSECP256K1Key} from './monoid/index.js';
import {getAppletKey} from './monoid/index.js';

export const BITCOIN_ADDRESS_TYPES = [
  'bitcoin-segwit',
  'bitcoin-taproot',
] as const;

export type BitcoinAddressType = (typeof BITCOIN_ADDRESS_TYPES)[number];

export type BitcoinWalletSigningAccount = {
  key: WalletKeyData;
  wallet: WalletKeyWalletData & {
    addressType: BitcoinAddressType;
    publicKey: PublicKeyHex;
  };
  reference: MonoidAppletSECP256K1Key;
};

export function hasBitcoinWallet(keys: readonly WalletKeyData[]): boolean {
  return keys.some(key =>
    getKeyWallets(key).some(
      wallet =>
        wallet.addressType === 'bitcoin-segwit' ||
        wallet.addressType === 'bitcoin-taproot',
    ),
  );
}

export function getBitcoinWalletSigningAccount(
  keys: readonly WalletKeyData[],
  address: string,
): BitcoinWalletSigningAccount | undefined {
  for (const key of keys) {
    for (const wallet of getKeyWallets(key)) {
      const {addressType} = wallet;
      if (
        (addressType !== 'bitcoin-segwit' &&
          addressType !== 'bitcoin-taproot') ||
        wallet.address !== address
      ) {
        continue;
      }

      const publicKey =
        key.type === 'seed' || key.type === 'master'
          ? key.wallets.find(
              source =>
                source.addressType === addressType &&
                source.seed === wallet.seed &&
                source.curve === wallet.curve &&
                source.path === wallet.path,
            )!.publicKey
          : addressType === 'bitcoin-taproot'
            ? key.taprootOutputKey!
            : key.publicKey!;

      return {
        key,
        wallet: {...wallet, addressType, publicKey},
        reference: getAppletKey(key, addressType, wallet.path),
      };
    }
  }

  return undefined;
}
