import {type ReactNode, useEffect} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../../@entrances.js';
import {ADDRESS_TYPES} from '../../../../../@lib/wallet-address.js';
import type {Router} from '../../../../../@routes.js';
import {
  KeyList,
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
} from '../../../../@key/key-list.js';
import {KeyDerivationTag, KeyTags} from '../../../../@key/key-tags.js';
import {Button, Buttons} from '../../../../@ui/button.js';
import {InteractiveAddress} from '../../../../@ui/interactive-address.js';
import {View, ViewContent} from '../../../../@view/index.js';
import {KeyHeader} from '../@key-header.js';

export const DerivableKeyView = ({
  view,
}: RouteComponentProps<Router['safe']['derivableKey']>): ReactNode => {
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

  const {wallets} = key;

  return (
    <View>
      <KeyHeader data={key} />
      <ViewContent>
        <KeyList>
          {wallets.map(wallet => (
            <KeyListItem key={`${wallet.addressType}:${wallet.address}`}>
              <KeyListItemContent>
                <KeyTags>
                  <KeyDerivationTag
                    chain={ADDRESS_TYPES[wallet.addressType].chain}
                  >
                    {wallet.path}
                  </KeyDerivationTag>
                </KeyTags>
                <KeyListAddress as={InteractiveAddress} copyable>
                  {wallet.address}
                </KeyListAddress>
              </KeyListItemContent>
            </KeyListItem>
          ))}
        </KeyList>
        <Buttons>
          <Button onClick={() => view.$match.derive.$push()}>Derive</Button>
        </Buttons>
      </ViewContent>
    </View>
  );
};
