import {BIP39Seed} from '../../@atomics.js';
import {parseDerivationPath} from '../../@lib/bip39.js';
import type {MonoidAppletKey} from '../../@lib/monoid/index.js';
import type {
  WalletKeyData,
  WalletKeyWalletData,
} from '../../@services/index.js';
import {getKeyWallets} from '../../@services/index.js';
import {hexToUint8Array} from '../../@utils/index.js';

export function getWalletSigningAccount(
  keys: readonly WalletKeyData[],
  address: string,
):
  | {
      key: WalletKeyData;
      wallet: WalletKeyWalletData;
      reference: MonoidAppletKey;
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
      reference: {
        index: hexToUint8Array(key.index),
        ...(wallet.seed !== undefined && {
          seed: BIP39Seed.satisfies(wallet.seed),
        }),
        ...(wallet.path !== undefined && {
          curve: wallet.curve!,
          path: parseDerivationPath(wallet.path),
        }),
      },
    };
  }

  return undefined;
}
