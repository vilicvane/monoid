import {IonRippleEffect} from '@ionic/react';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {WalletKeyData} from '../../../../@services/index.js';
import {
  KeyAlias,
  KeyDerivation,
  KeyExtraDerivations,
  KeyTags,
  KeyType,
} from '../../../@key/key-tag.js';
import {Address} from '../../../@ui/address.js';

const Item = styled.div`
  position: relative;
  display: flex;

  align-items: center;
  justify-content: space-between;
  gap: 8px;

  padding: 12px var(--view-padding);

  overflow: hidden;
`;

const ItemContent = styled.div`
  flex: 1;

  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const KeyRefAddress = styled(Address)`
  color: var(--ion-color-dark);
`;

export const KeyItem = observer(
  ({data: {type, alias, wallets}}: {data: WalletKeyData}): ReactNode => {
    const [wallet] = wallets;

    return (
      <Item className="ion-activatable">
        <ItemContent>
          <KeyTags>
            <KeyType className={type}>{type}</KeyType>
            {wallet.path && (
              <>
                <KeyDerivation>{wallet.path}</KeyDerivation>
                {wallets.length > 1 && (
                  <KeyExtraDerivations>
                    {wallets.length - 1}
                  </KeyExtraDerivations>
                )}
              </>
            )}
            {alias && <KeyAlias>{alias}</KeyAlias>}
          </KeyTags>
          <KeyRefAddress>{wallet.address}</KeyRefAddress>
        </ItemContent>
        <IonRippleEffect />
      </Item>
    );
  },
);
