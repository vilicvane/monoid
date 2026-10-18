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
import {getKeyWallets, matchesWalletReference} from '../../@services/index.js';

type WalletSigningAccount<Key> = {
  key: WalletKeyData;
  wallet: WalletKeyWalletData;
  reference: Key;
};

export function assertWalletSigningAccount(
  keys: readonly WalletKeyData[],
  account: Pick<WalletSigningAccount<unknown>, 'key' | 'wallet'>,
): void {
  const key = keys.find(key => key.index === account.key.index);
  if (
    !key ||
    !getKeyWallets(key).some(
      wallet =>
        matchesWalletReference(wallet, account.wallet) &&
        normalizeWalletAddress(wallet.address) ===
          normalizeWalletAddress(account.wallet.address),
    )
  ) {
    throw new Error('This account is no longer in Safe.');
  }
}

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
