import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../../@entrances.js';
import {WalletAccountList} from '../../@key/wallet-account-list.js';
import {ChainName} from '../../@ui/chain-name.js';
import {InfoSection} from '../../@ui/info-section.js';

export const WalletConnectMessage = observer(
  ({
    address,
    chainId,
    children,
  }: {
    address: string;
    chainId?: string;
    children: ReactNode;
  }): ReactNode => {
    const {walletStorageService} = useEntrances();

    return (
      <InfoSection>
        {chainId && <ChainName chainId={chainId} />}
        <WalletAccountList
          keys={walletStorageService.keys}
          addressType="evm"
          addresses={[address]}
        />
        {children}
      </InfoSection>
    );
  },
);
