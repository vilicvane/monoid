import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../../@entrances.js';
import type {Router} from '../../../../../@routes.js';
import {DerivedKeyList} from '../../../../@key/derived-key-list.js';
import {KeyWalletList} from '../../../../@key/key-wallet-list.js';
import {Button} from '../../../../@ui/button.js';
import {View, ViewContent, ViewPlaceholder} from '../../../../@view/index.js';
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
      if (key?.type !== 'seed') {
        router.safe.$reset();
      }
    }, [key, router.safe]);

    if (key?.type !== 'seed') {
      return null;
    }

    const derivedKeys = key.derivedKeys ?? [];

    return (
      <View>
        <KeyHeader data={key} />
        <ViewContent
          footer={
            <Button onClick={() => view.$match.derive.$push()}>Derive</Button>
          }
          footerRef={buttonsRef}
        >
          {key.wallets.length === 0 && derivedKeys.length === 0 && (
            <ViewPlaceholder>No derived wallets or keys</ViewPlaceholder>
          )}
          {(key.wallets.length > 0 || derivedKeys.length > 0) && (
            <div>
              {key.wallets.length > 0 && (
                <KeyWalletList
                  data={key}
                  defaultExpandedChain={view.expandedChain}
                  emptyFocusRef={buttonsRef}
                />
              )}
              {derivedKeys.length > 0 && (
                <DerivedKeyList
                  keys={derivedKeys}
                  emptyFocusRef={buttonsRef}
                  onDelete={derived =>
                    walletStorageService.deleteDerivedKey(
                      index,
                      derived.derivation,
                    )
                  }
                />
              )}
            </div>
          )}
        </ViewContent>
      </View>
    );
  },
);
