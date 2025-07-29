import type {UseIonAlertResult} from '@ionic/react';
import {IonAlert, useIonAlert} from '@ionic/react';
import {wallet} from 'ionicons/icons';
import {type ReactNode, useState} from 'react';
import {styled} from 'styled-components';

import {BIP39PathString} from '../../../../../@atomics.js';
import {ETHEREUM_DERIVATION_PATH} from '../../../../../@constants.js';
import {useEntrances} from '../../../../../@entrances.js';
import type {WalletKeyData} from '../../../../../@services/index.js';
import {KeyDerivationTag, KeyTags} from '../../../../@key/key-tags.js';
import {Address} from '../../../../@ui/address.js';
import {Button, Buttons} from '../../../../@ui/button.js';
import {
  InfoSection,
  InfoSectionItem,
  InfoSectionItemContent as InfoSectionItemContent_,
  InfoSectionItemLabel,
} from '../../../../@ui/info-section.js';
import {InteractiveAddress} from '../../../../@ui/interactive-address.js';
import {ViewContent} from '../../../../@view/index.js';

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

export const DerivableKeyContent = ({
  data: key,
}: {
  data: WalletKeyData;
}): ReactNode => {
  const {router} = useEntrances();

  return (
    <>
      <ViewContent>
        <InfoSection>
          <InfoSectionItem>
            <InfoSectionItemLabel>Address</InfoSectionItemLabel>
            <InfoSectionItemContent>
              {key.wallets.map(wallet => (
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
          <Button onClick={() => router.safe.key.derive.$push()}>Derive</Button>
        </Buttons>
      </ViewContent>
    </>
  );
};

async function promptAndDerive(key: WalletKeyData): Promise<void> {
  const pathSet = new Set<string>(
    key.wallets.map(wallet => wallet.path).filter(path => path !== undefined),
  );

  let path: string;

  // eslint-disable-next-line no-constant-condition
  for (let index = 0; true; index++) {
    path = ETHEREUM_DERIVATION_PATH(index);

    if (!pathSet.has(path)) {
      break;
    }
  }
}
