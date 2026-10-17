import type {ReactNode} from 'react';

import {ADDRESS_TYPES, ADDRESS_TYPE_LABELS} from '../../@lib/wallet-address.js';
import type {WalletKeyWalletData} from '../../@services/index.js';

import {KeyAliasTag, KeyDerivationTag} from './key-tags.js';

export const WalletAccountTags = ({
  alias,
  wallet,
  showAddressType = false,
}: {
  alias?: string;
  wallet: Pick<WalletKeyWalletData, 'addressType' | 'path'>;
  showAddressType?: boolean;
}): ReactNode => (
  <>
    {alias && <KeyAliasTag>{alias}</KeyAliasTag>}
    {(wallet.path || showAddressType) && (
      <KeyDerivationTag chain={ADDRESS_TYPES[wallet.addressType].chain}>
        {wallet.path ?? ADDRESS_TYPE_LABELS[wallet.addressType]}
      </KeyDerivationTag>
    )}
  </>
);
