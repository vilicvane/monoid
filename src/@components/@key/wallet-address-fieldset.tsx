import type {ReactNode} from 'react';

import {
  type AddressType,
  normalizeWalletAddress,
} from '../../@lib/wallet-address.js';
import {type WalletKeyData, getKeyWallets} from '../../@services/index.js';
import {ExpandableAddress} from '../@ui/expandable-address.js';
import {InfoFieldset, InfoLegend} from '../@ui/info-section.js';

import {WalletAccountFieldset} from './wallet-account-fieldset.js';

export function WalletAddressFieldset({
  keys,
  address,
  addressType,
  label,
}: {
  keys: readonly WalletKeyData[];
  address: string;
  addressType: AddressType;
  label: ReactNode;
}): ReactNode {
  const normalizedAddress = normalizeWalletAddress(address);
  const known = keys.some(key =>
    getKeyWallets(key).some(
      wallet =>
        wallet.addressType === addressType &&
        normalizeWalletAddress(wallet.address) === normalizedAddress,
    ),
  );

  return known ? (
    <WalletAccountFieldset
      keys={keys}
      address={address}
      addressType={addressType}
      label={label}
    />
  ) : (
    <InfoFieldset>
      <InfoLegend>{label}</InfoLegend>
      <ExpandableAddress>{address}</ExpandableAddress>
    </InfoFieldset>
  );
}
