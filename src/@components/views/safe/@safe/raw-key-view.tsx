import {type ReactNode, useEffect} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {
  KeyList,
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
} from '../../../@key/key-list.js';
import {InteractiveAddress} from '../../../@ui/interactive-address.js';
import {View, ViewContent} from '../../../@view/index.js';

import {KeyHeader} from './@key-header.js';

export const RawKeyView = ({
  view,
}: RouteComponentProps<Router['safe']['rawKey']>): ReactNode => {
  const {router, walletStorageService} = useEntrances();

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

  const {
    wallets: [wallet],
  } = key;

  return (
    <View>
      <KeyHeader data={key} />
      <ViewContent>
        <KeyList>
          <KeyListItem>
            <KeyListItemContent>
              <KeyListAddress as={InteractiveAddress} copyable>
                {wallet.address}
              </KeyListAddress>
            </KeyListItemContent>
          </KeyListItem>
        </KeyList>
      </ViewContent>
    </View>
  );
};
