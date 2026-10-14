import {type ReactNode, useEffect} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {
  InfoSection,
  InfoSectionItem,
  InfoSectionItemContent,
  InfoSectionItemLabel,
} from '../../../@ui/info-section.js';
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
