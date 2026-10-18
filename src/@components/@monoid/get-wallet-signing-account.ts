import type {
  MonoidAppletED25519Key,
  MonoidAppletSECP256K1Key,
} from '../../@lib/monoid/index.js';
import {getAppletKey} from '../../@lib/monoid/index.js';
import {normalizeWalletAddress} from '../../@lib/wallet-address.js';
import type {
  WalletKeyData,
  WalletKeyWalletData,
} from '../../@services/index.js';
import {getKeyWallets} from '../../@services/index.js';

type WalletSigningAccount<Key> = {
  key: WalletKeyData;
  wallet: WalletKeyWalletData;
  reference: Key;
};

export function getWalletSigningAccount(
  keys: readonly WalletKeyData[],
  address: string,
  addressType?: 'evm',
): WalletSigningAccount<MonoidAppletSECP256K1Key> | undefined;
export function getWalletSigningAccount(
  keys: readonly WalletKeyData[],
  address: string,
  addressType: 'solana',
): WalletSigningAccount<MonoidAppletED25519Key> | undefined;
export function getWalletSigningAccount(
  keys: readonly WalletKeyData[],
  address: string,
  addressType: 'evm' | 'solana',
):
  | WalletSigningAccount<MonoidAppletSECP256K1Key | MonoidAppletED25519Key>
  | undefined;
export function getWalletSigningAccount(
  keys: readonly WalletKeyData[],
  address: string,
  addressType: 'evm' | 'solana' = 'evm',
):
  | WalletSigningAccount<MonoidAppletSECP256K1Key | MonoidAppletED25519Key>
  | undefined {
  for (const key of keys) {
    const wallet = getKeyWallets(key).find(
      wallet =>
        wallet.addressType === addressType &&
        normalizeWalletAddress(wallet.address) ===
          normalizeWalletAddress(address),
    );
    if (!wallet) continue;

    return {
      key,
      wallet,
      reference:
        addressType === 'solana'
          ? getAppletKey(key, 'solana', wallet.path)
          : getAppletKey(key, 'evm', wallet.path),
    };
  }

  return undefined;
}
