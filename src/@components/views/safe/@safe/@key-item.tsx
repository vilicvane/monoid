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
import {KeyPublicKeyTags} from '../../../@key/key-public-key-item.js';
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
    const derivedKeys = data.derivedKeys ?? [];
    // Wallets come first; a seed with only derived keys shows its first key.
    const derivedKey = wallet ? undefined : derivedKeys[0];
    const total = wallets.length + derivedKeys.length;

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
            {wallet ? (
              <KeyDerivationTag chain={ADDRESS_TYPES[wallet.addressType].chain}>
                {wallet.path ?? ADDRESS_TYPE_LABELS[wallet.addressType]}
              </KeyDerivationTag>
            ) : (
              derivedKey && (
                <KeyPublicKeyTags
                  curve={derivedKey.derivation.curve}
                  context={derivedKey.derivation.context}
                />
              )
            )}
            {(wallet || derivedKey) && total > 1 && (
              <KeyDerivationBadge $primary>{total}</KeyDerivationBadge>
            )}
          </KeyTags>
          {wallet ? (
            <KeyListAddress>{wallet.address}</KeyListAddress>
          ) : derivedKey ? (
            <KeyListAddress>{derivedKey.publicKey}</KeyListAddress>
          ) : data.rawPublicKey ? (
            <KeyListAddress>{data.rawPublicKey}</KeyListAddress>
          ) : (
            <KeyListPlaceholder>
              {type === 'seed'
                ? 'No derived wallets or keys'
                : 'No derived addresses'}
            </KeyListPlaceholder>
          )}
        </KeyListItemContent>
        <RippleEffect />
      </ListItemButton>
    );
  },
);
