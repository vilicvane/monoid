import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../../../@entrances.js';
import {
  ADDRESS_TYPES,
  ADDRESS_TYPE_LABELS,
} from '../../../../@lib/wallet-address.js';
import type {WalletKeyData} from '../../../../@services/index.js';
import {getDefaultWallet, getKeyWallets} from '../../../../@services/index.js';
import {
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
  KeyListPlaceholder,
} from '../../../@key/key-list.js';
import {
  KeyAliasTag,
  KeyDerivationBadge,
  KeyDerivationTag,
  KeyTags,
  KeyTypeTag,
} from '../../../@key/key-tags.js';
import {RippleEffect} from '../../../@ui/ripple-effect.js';

export const KeyItem = observer(({data}: {data: WalletKeyData}): ReactNode => {
  const {router} = useEntrances();

  const {type, index, alias} = data;
  const wallets = getKeyWallets(data);
  const wallet = getDefaultWallet(data, wallets);

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
          {wallet && (
            <>
              <KeyDerivationTag chain={ADDRESS_TYPES[wallet.addressType].chain}>
                {wallet.path ?? ADDRESS_TYPE_LABELS[wallet.addressType]}
              </KeyDerivationTag>
              {wallets.length > 1 && (
                <KeyDerivationBadge $primary>
                  {wallets.length}
                </KeyDerivationBadge>
              )}
            </>
          )}
        </KeyTags>
        {wallet ? (
          <KeyListAddress>{wallet.address}</KeyListAddress>
        ) : (
          <KeyListPlaceholder>No derived addresses</KeyListPlaceholder>
        )}
      </KeyListItemContent>
      <RippleEffect />
    </KeyListItem>
  );
});
