import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../../@entrances.js';
import {WalletAccountFieldset} from '../../@key/wallet-account-fieldset.js';
import {WalletAccountList} from '../../@key/wallet-account-list.js';
import {ChainTag} from '../../@ui/chain-name.js';
import {InfoSection} from '../../@ui/info-section.js';

export const WalletConnectMessage = observer(
  ({
    address,
    chainId,
    accountLabel,
    children,
  }: {
    address: string;
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
            label={accountLabel}
          />
        ) : (
          <WalletAccountList
            keys={walletStorageService.keys}
            addressType="evm"
            addresses={[address]}
            compact
          />
        )}
        {children}
      </InfoSection>
    );
  },
);
