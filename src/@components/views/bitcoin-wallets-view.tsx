import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {BITCOIN_ADDRESS_TYPES} from '../../@lib/bitcoin-wallet.js';
import type {Router} from '../../@routes.js';
import {useViewActive} from '../@view/index.js';

import {WalletsView} from './wallets-view.js';

export const BitcoinWalletsView = observer(
  ({view}: RouteComponentProps<Router['bitcoin']>): ReactNode => {
    const {router, walletStorageService} = useEntrances();
    const isViewActive = useViewActive(view);

    return (
      <WalletsView
        title="Bitcoin"
        active={isViewActive()}
        keys={walletStorageService.keys}
        addressType={BITCOIN_ADDRESS_TYPES}
        onOpen={address => {
          if (!isViewActive()) return;
          router.bitcoin.wallet({address}).$push();
        }}
      />
    );
  },
);
