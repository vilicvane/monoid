import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {KeyWalletList} from '../../../@key/key-wallet-list.js';
import {View, ViewContent} from '../../../@view/index.js';

import {KeyHeader} from './@key-header.js';

export const RawKeyView = observer(
  ({view}: RouteComponentProps<Router['safe']['rawKey']>): ReactNode => {
    const {router, walletStorageService} = useEntrances();
    const key = walletStorageService.indexToKeyMap.get(view.index);

    useEffect(() => {
      if (!key) {
        router.safe.$reset();
      }
    }, [key, router.safe]);

    if (!key) {
      return null;
    }

    return (
      <View>
        <KeyHeader data={key} />
        <ViewContent>
          <KeyWalletList data={key} />
        </ViewContent>
      </View>
    );
  },
);
