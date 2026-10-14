import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {useEntrances} from '../../../../@entrances.js';
import {ADDRESS_TYPES} from '../../../../@lib/wallet-address.js';
import type {WalletKeyData} from '../../../../@services/index.js';
import {getDefaultWallet} from '../../../../@services/index.js';
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

  const {type, index, alias, wallets} = data;
  const wallet = getDefaultWallet(data);

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
          {wallet?.path && (
            <>
              <KeyDerivationTag chain={ADDRESS_TYPES[wallet.addressType].chain}>
                {wallet.path}
              </KeyDerivationTag>
              {wallets.length > 1 && (
                <KeyDerivationBadge>{wallets.length - 1}</KeyDerivationBadge>
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
