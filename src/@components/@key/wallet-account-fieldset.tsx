import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {
  type WalletKeyData,
  type WalletKeyWalletData,
  getKeyWallets,
} from '../../@services/index.js';
import {
  InfoFieldset,
  InfoFieldsetHeader,
  InfoLegend,
} from '../@ui/info-section.js';
import {InteractiveAddress} from '../@ui/interactive-address.js';

import {KeyListAddress, KeyListPlaceholder} from './key-list.js';
import {KeyTags} from './key-tags.js';
import {WalletAccountTags} from './wallet-account-tags.js';

const HeaderTags = styled(KeyTags)`
  min-width: 0;
  margin-left: auto;
  margin-right: calc(
    var(--info-fieldset-label-inset) - var(--info-fieldset-padding) - var(
        --info-fieldset-border-width
      ) - var(--tag-inline-margin)
  );

  > * {
    min-width: 0;
    flex-shrink: 1;
  }
`;

export const WalletAccountFieldset = observer(function WalletAccountFieldset({
  keys,
  address,
  label,
}: {
  keys: readonly WalletKeyData[];
  address: string;
  label: ReactNode;
}): ReactNode {
  let account: {key: WalletKeyData; wallet: WalletKeyWalletData} | undefined;
  const normalizedAddress = address.toLowerCase();

  for (const key of keys) {
    const wallet = getKeyWallets(key).find(
      wallet =>
        wallet.addressType === 'evm' &&
        wallet.address.toLowerCase() === normalizedAddress,
    );
    if (wallet) {
      account = {key, wallet};
      break;
    }
  }

  return (
    <InfoFieldset>
      <InfoFieldsetHeader>
        <InfoLegend as="span">{label}</InfoLegend>
        {account && (account.key.alias || account.wallet.path) && (
          <HeaderTags>
            <WalletAccountTags
              alias={account.key.alias}
              wallet={account.wallet}
            />
          </HeaderTags>
        )}
      </InfoFieldsetHeader>
      {!account && <KeyListPlaceholder>Not in Safe</KeyListPlaceholder>}
      <KeyListAddress as={InteractiveAddress} copyable>
        {account?.wallet.address ?? address}
      </KeyListAddress>
    </InfoFieldset>
  );
});
