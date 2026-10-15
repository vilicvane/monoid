import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../../@entrances.js';
import type {Router} from '../../../../../@routes.js';
import {KeyWalletList} from '../../../../@key/key-wallet-list.js';
import {Button} from '../../../../@ui/button.js';
import {View, ViewContent} from '../../../../@view/index.js';
import {KeyHeader} from '../@key-header.js';

export const DerivableKeyView = observer(
  ({view}: RouteComponentProps<Router['safe']['derivableKey']>): ReactNode => {
    const {router, walletStorageService} = useEntrances();
    const buttonsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      // Consume the return hint after the list initializes its group state.
      runInAction(() => {
        view.expandedChain = undefined;
      });
    }, [view]);

    const {index} = view;

    const key = walletStorageService.indexToKeyMap.get(index);

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
          footerPlacement="fixed"
          footer={
            <Button onClick={() => view.$match.derive.$push()}>Derive</Button>
          }
          footerRef={buttonsRef}
        >
          <KeyWalletList
            data={key}
            defaultExpandedChain={view.expandedChain}
            emptyFocusRef={buttonsRef}
          />
        </ViewContent>
      </View>
    );
  },
);
