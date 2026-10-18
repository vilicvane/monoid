import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../../@entrances.js';
import type {WalletConnectAddressType} from '../../../@lib/wallet-connect.js';
import {WalletAccountFieldset} from '../../@key/wallet-account-fieldset.js';
import {WalletAccountList} from '../../@key/wallet-account-list.js';
import {ChainTag} from '../../@ui/chain-name.js';
import {InfoSection} from '../../@ui/info-section.js';

export const WalletConnectMessage = observer(
  ({
    address,
    addressType = 'evm',
    chainId,
    accountLabel,
    children,
  }: {
    address: string;
    addressType?: WalletConnectAddressType;
    chainId?: string;
    accountLabel?: ReactNode;
    children: ReactNode;
  }): ReactNode => {
    const {walletStorageService} = useEntrances();
    return (
      <InfoSection>
        {chainId && <ChainTag chainId={chainId} />}
        {accountLabel ? (
          <WalletAccountFieldset
            keys={walletStorageService.keys}
            address={address}
            addressType={addressType}
            label={accountLabel}
          />
        ) : (
          <WalletAccountList
            keys={walletStorageService.keys}
            addressType={addressType}
            addresses={[address]}
            compact
          />
        )}
        {children}
      </InfoSection>
    );
  },
);
