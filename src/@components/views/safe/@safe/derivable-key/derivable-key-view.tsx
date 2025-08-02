import {type ReactNode, useEffect} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../../@entrances.js';
import type {Router} from '../../../../../@routes.js';
import {KeyDerivationTag, KeyTags} from '../../../../@key/key-tags.js';
import {KeyType} from '../../../../@key/key-type.js';
import {Button, Buttons} from '../../../../@ui/button.js';
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
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
} from '../../../../@view/index.js';

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
        <ViewHeaderIdentifier identifier={{type: 'safe-item', index, alias}} />
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
        <Buttons>
          <Button onClick={() => view.$match.derive.$push()}>Derive</Button>
        </Buttons>
      </ViewContent>
    </View>
  );
};
