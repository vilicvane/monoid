import {keyOutline} from 'ionicons/icons';
import {type ReactNode, useEffect} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {KeyType} from '../../../@key/key-type.js';
import {
  InfoSection,
  InfoSectionItem,
  InfoSectionItemContent,
  InfoSectionItemLabel,
} from '../../../@ui/info-section.js';
import {InteractiveAddress} from '../../../@ui/interactive-address.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
} from '../../../@view/index.js';

const INDEX_DISPLAY_OFFSET = 2;
const INDEX_DISPLAY_END = INDEX_DISPLAY_OFFSET + 8;

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
    type,
    alias,
    wallets: [wallet],
  } = key;

  return (
    <View>
      <ViewHeader>
        <ViewHeaderTitle>
          <KeyType type={type} />
        </ViewHeaderTitle>
        <ViewHeaderIdentifier icon={keyOutline}>
          {alias ?? index.slice(INDEX_DISPLAY_OFFSET, INDEX_DISPLAY_END)}
        </ViewHeaderIdentifier>
      </ViewHeader>
      <ViewContent>
        <InfoSection>
          <InfoSectionItem>
            <InfoSectionItemLabel>Address</InfoSectionItemLabel>
            <InfoSectionItemContent>
              <InteractiveAddress copyable>{wallet.address}</InteractiveAddress>
            </InfoSectionItemContent>
          </InfoSectionItem>
        </InfoSection>
      </ViewContent>
    </View>
  );
};
