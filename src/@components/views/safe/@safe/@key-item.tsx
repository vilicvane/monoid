import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../@entrances.js';
import type {WalletKeyData} from '../../../../@services/index.js';
import {
  KeyAliasTag,
  KeyDerivationTag,
  KeyExtraDerivationsTag,
  KeyTags,
  KeyTypeTag,
} from '../../../@key/key-tags.js';
import {Address} from '../../../@ui/address.js';
import {RippleEffect} from '../../../@ui/ripple-effect.js';

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
  min-width: 0;

  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const KeyRefAddress = styled(Address)`
  color: var(--ion-color-dark);
`;

export const KeyItem = observer(
  ({data: {type, index, alias, wallets}}: {data: WalletKeyData}): ReactNode => {
    const {router} = useEntrances();

    const [wallet] = wallets;

    return (
      <Item
        className="ion-activatable"
        onClick={() => {
          switch (type) {
            case 'seed':
            case 'master':
              router.safe.derivableKey({index}).$push();
              break;
            default:
              router.safe.rawKey({index}).$push();
              break;
          }
        }}
      >
        <ItemContent>
          <KeyTags>
            <KeyTypeTag className={type}>{type}</KeyTypeTag>
            {alias && <KeyAliasTag>{alias}</KeyAliasTag>}
            {wallet.path && (
              <>
                <KeyDerivationTag>{wallet.path}</KeyDerivationTag>
                {wallets.length > 1 && (
                  <KeyExtraDerivationsTag>
                    {wallets.length - 1}
                  </KeyExtraDerivationsTag>
                )}
              </>
            )}
          </KeyTags>
          <KeyRefAddress>{wallet.address}</KeyRefAddress>
        </ItemContent>
        <RippleEffect />
      </Item>
    );
  },
);
