import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';

import {
  ADDRESS_TYPES,
  ADDRESS_TYPE_LABELS,
} from '../../../../@lib/wallet-address.js';
import type {WalletKeyData} from '../../../../@services/index.js';
import {getDefaultWallet, getKeyWallets} from '../../../../@services/index.js';
import {
  KeyListAddress,
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
import {ListItemButton} from '../../../@ui/list.js';
import {RippleEffect} from '../../../@ui/ripple-effect.js';

export const KeyItem = observer(
  ({data, onClick}: {data: WalletKeyData; onClick: () => void}): ReactNode => {
    const {type, alias} = data;
    const wallets = getKeyWallets(data);
    const wallet = getDefaultWallet(data, wallets);

    return (
      <ListItemButton
        type="button"
        className="ion-activatable"
        data-swipeable-content
        onClick={onClick}
      >
        <KeyListItemContent>
          <KeyTags>
            <KeyTypeTag className={type}>{type}</KeyTypeTag>
            {alias && <KeyAliasTag>{alias}</KeyAliasTag>}
            {wallet && (
              <>
                <KeyDerivationTag
                  chain={ADDRESS_TYPES[wallet.addressType].chain}
                >
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
          ) : data.rawPublicKey ? (
            <KeyListAddress>{data.rawPublicKey}</KeyListAddress>
          ) : (
            <KeyListPlaceholder>No derived addresses</KeyListPlaceholder>
          )}
        </KeyListItemContent>
        <RippleEffect />
      </ListItemButton>
    );
  },
);
