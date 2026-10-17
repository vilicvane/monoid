import type {MonoidAppletSECP256K1Key} from '../../@lib/monoid/index.js';
import {getAppletKey} from '../../@lib/monoid/index.js';
import type {
  WalletKeyData,
  WalletKeyWalletData,
} from '../../@services/index.js';
import {getKeyWallets} from '../../@services/index.js';

export function getWalletSigningAccount(
  keys: readonly WalletKeyData[],
  address: string,
):
  | {
      key: WalletKeyData;
      wallet: WalletKeyWalletData;
      reference: MonoidAppletSECP256K1Key;
    }
  | undefined {
  for (const key of keys) {
    const wallet = getKeyWallets(key).find(
      wallet =>
        wallet.addressType === 'evm' &&
        wallet.address.toLowerCase() === address.toLowerCase(),
    );
    if (!wallet) continue;

    return {
      key,
      wallet,
      reference: getAppletKey(key, 'evm', wallet.path),
    };
  }

  return undefined;
}
