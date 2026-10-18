import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {KeyWalletList} from '../../../@key/key-wallet-list.js';
import {Button} from '../../../@ui/button.js';
import {View, ViewContent} from '../../../@view/index.js';

import {KeyHeader} from './@key-header.js';

export const RawKeyView = observer(
  ({view}: RouteComponentProps<Router['safe']['rawKey']>): ReactNode => {
    const {router, walletStorageService} = useEntrances();
    const key = walletStorageService.indexToKeyMap.get(view.index);
    const buttonsRef = useRef<HTMLDivElement>(null);

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
        <ViewContent
          footer={
            key.wallets.length === 0 && (
              <Button
                color="neutral"
                onClick={() => router.safe.scanCard.$push()}
              >
                Scan card
              </Button>
            )
          }
          footerRef={buttonsRef}
        >
          <KeyWalletList data={key} emptyFocusRef={buttonsRef} />
        </ViewContent>
      </View>
    );
  },
);
