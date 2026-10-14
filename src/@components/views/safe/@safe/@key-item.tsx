import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../../../@entrances.js';
import {ADDRESS_TYPES} from '../../../../@lib/wallet-address.js';
import type {WalletKeyData} from '../../../../@services/index.js';
import {
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
} from '../../../@key/key-list.js';
import {
  KeyAliasTag,
  KeyDerivationTag,
  KeyExtraDerivationsTag,
  KeyTags,
  KeyTypeTag,
} from '../../../@key/key-tags.js';
import {RippleEffect} from '../../../@ui/ripple-effect.js';

export const KeyItem = observer(
  ({data: {type, index, alias, wallets}}: {data: WalletKeyData}): ReactNode => {
    const {router} = useEntrances();

    const [wallet] = wallets;

    return (
      <KeyListItem
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
        <KeyListItemContent>
          <KeyTags>
            <KeyTypeTag className={type}>{type}</KeyTypeTag>
            {alias && <KeyAliasTag>{alias}</KeyAliasTag>}
            {wallet.path && (
              <>
                <KeyDerivationTag
                  chain={ADDRESS_TYPES[wallet.addressType].chain}
                >
                  {wallet.path}
                </KeyDerivationTag>
                {wallets.length > 1 && (
                  <KeyExtraDerivationsTag>
                    {wallets.length - 1}
                  </KeyExtraDerivationsTag>
                )}
              </>
            )}
          </KeyTags>
          <KeyListAddress>{wallet.address}</KeyListAddress>
        </KeyListItemContent>
        <RippleEffect />
      </KeyListItem>
    );
  },
);
