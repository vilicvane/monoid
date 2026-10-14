import {type ReactNode, useEffect} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../../@entrances.js';
import type {Router} from '../../../../../@routes.js';
import {KeyDerivationTag, KeyTags} from '../../../../@key/key-tags.js';
import {Button, Buttons} from '../../../../@ui/button.js';
import {
  InfoSection,
  InfoSectionItem,
  InfoSectionItemContent as InfoSectionItemContent_,
  InfoSectionItemLabel,
} from '../../../../@ui/info-section.js';
import {InteractiveAddress} from '../../../../@ui/interactive-address.js';
import {View, ViewContent} from '../../../../@view/index.js';
import {KeyHeader} from '../@key-header.js';

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

  const {wallets} = key;

  return (
    <View>
      <KeyHeader data={key} />
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
