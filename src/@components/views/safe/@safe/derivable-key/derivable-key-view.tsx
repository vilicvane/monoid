import {IonFabButton, IonIcon} from '@ionic/react';
import {keyOutline, linkOutline} from 'ionicons/icons';
import {type ReactNode, useEffect} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../../@entrances.js';
import type {Router} from '../../../../../@routes.js';
import {KeyDerivationTag, KeyTags} from '../../../../@key/key-tags.js';
import {KeyType} from '../../../../@key/key-type.js';
import {
  InfoSection,
  InfoSectionItem,
  InfoSectionItemContent as InfoSectionItemContent_,
  InfoSectionItemLabel,
} from '../../../../@ui/info-section.js';
import {InteractiveAddress} from '../../../../@ui/interactive-address.js';
import {
  View,
  ViewContent,
  ViewFab,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
} from '../../../../@view/index.js';

const INDEX_DISPLAY_OFFSET = 2;
const INDEX_DISPLAY_END = INDEX_DISPLAY_OFFSET + 8;

const InfoSectionItemContent = styled(InfoSectionItemContent_)`
  flex: 1;

  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Item = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

export const DerivableKeyView = ({
  view,
  transition,
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

  const {type, alias, wallets} = key;

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
            <InfoSectionItemLabel>Addresses</InfoSectionItemLabel>
            <InfoSectionItemContent>
              {wallets.map(wallet => (
                <Item key={wallet.address}>
                  <KeyTags>
                    <KeyDerivationTag>{wallet.path}</KeyDerivationTag>
                  </KeyTags>
                  <InteractiveAddress copyable>
                    {wallet.address}
                  </InteractiveAddress>
                </Item>
              ))}
            </InfoSectionItemContent>
          </InfoSectionItem>
        </InfoSection>
      </ViewContent>
      <ViewFab view={view} transition={transition}>
        <IonFabButton onClick={() => view.$match.derive.$push()}>
          <IonIcon icon={linkOutline} />
        </IonFabButton>
      </ViewFab>
    </View>
  );
};
