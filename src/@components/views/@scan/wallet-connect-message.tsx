import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../../@entrances.js';
import {WalletAccountList} from '../../@key/wallet-account-list.js';
import {ChainName} from '../../@ui/chain-name.js';
import {InfoSection} from '../../@ui/info-section.js';
import {MessageContent} from '../../@ui/message-content.js';

export const WalletConnectMessage = observer(
  ({
    address,
    chainId,
    message,
    label = 'Message',
  }: {
    address: string;
    chainId: string;
    message: string;
    label?: string;
  }): ReactNode => {
    const {walletStorageService} = useEntrances();

    return (
      <InfoSection>
        <ChainName chainId={chainId} />
        <WalletAccountList
          keys={walletStorageService.keys}
          addressType="evm"
          addresses={[address]}
          compact
        />
        <MessageContent aria-label={label}>{message}</MessageContent>
      </InfoSection>
    );
  },
);
