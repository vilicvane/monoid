import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {BITCOIN_ADDRESS_TYPES} from '../../@lib/bitcoin-wallet.js';
import type {Router} from '../../@routes.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

export const BitcoinWalletsView = observer(
  ({view}: RouteComponentProps<Router['bitcoin']>): ReactNode => {
    const {router, walletStorageService} = useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Bitcoin</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent>
          <WalletAccountList
            selectionLabel="Choose wallet"
            keys={walletStorageService.keys}
            addressType={BITCOIN_ADDRESS_TYPES}
            onOpen={address => router.bitcoin.wallet({address}).$push()}
          />
        </ViewContent>
      </View>
    );
  },
);
