import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../../@entrances.js';
import {WalletAccountList} from '../../@key/wallet-account-list.js';
import {ChainTag} from '../../@ui/chain-name.js';
import {InfoFieldset, InfoLegend, InfoSection} from '../../@ui/info-section.js';

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
    const account = (
      <WalletAccountList
        keys={walletStorageService.keys}
        addressType="evm"
        addresses={[address]}
        compact={!!accountLabel}
        contained={!!accountLabel}
      />
    );

    return (
      <InfoSection>
        {chainId && <ChainTag chainId={chainId} />}
        {accountLabel ? (
          <InfoFieldset>
            <InfoLegend>{accountLabel}</InfoLegend>
            {account}
          </InfoFieldset>
        ) : (
          account
        )}
        {children}
      </InfoSection>
    );
  },
);
