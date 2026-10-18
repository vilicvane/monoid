import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../@entrances.js';
import {
  ADDRESS_TYPES,
  ADDRESS_TYPE_LABELS,
} from '../../../../@lib/wallet-address.js';
import {
  WalletKeyKnownType,
  getDefaultWallet,
} from '../../../../@services/index.js';
import {KeyCheckbox} from '../../../@key/key-checkbox.js';
import {
  KeyList,
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
  KeyListPlaceholder,
} from '../../../@key/key-list.js';
import {
  KeyAliasTag,
  KeyDerivationTag,
  KeyTags,
  KeyTypeTag,
} from '../../../@key/key-tags.js';
import type {ScannedCardItemData} from '../common.js';

export const CardResourceList = styled(KeyList)`
  flex: ${({$contained}) => ($contained ? 0 : 1)};

  ${KeyListAddress} {
    color: var(--color-address-primary, var(--ion-color-dark));
  }

  ${KeyListPlaceholder} {
    color: var(--color-text-label, var(--ion-color-medium));
  }
`;

const DerivationTag = styled(KeyDerivationTag)<{$hasPath: boolean}>`
  flex-shrink: ${({$hasPath}) => ($hasPath ? 1 : 0)};
  min-width: 0;
`;

export const CardResourceItem = observer(
  ({
    data: item,
    selected = false,
    disabled = false,
    onSelect,
  }: {
    data: Pick<ScannedCardItemData, 'index' | 'type' | 'alias'>;
    selected?: boolean;
    disabled?: boolean;
    onSelect?: (selected: boolean) => void;
  }): ReactNode => {
    const {walletStorageService} = useEntrances();
    const localKey = walletStorageService.indexToKeyMap.get(item.index);
    const wallet =
      localKey && localKey.type === item.type
        ? getDefaultWallet(localKey)
        : undefined;
    const typeCode =
      typeof item.type === 'number'
        ? item.type
        : parseInt(item.index.slice(0, 4), 16);
    const type =
      typeof item.type === 'string'
        ? item.type
        : typeCode === 0x0fff
          ? 'generic'
          : `0x${typeCode.toString(16).padStart(4, '0')}`;

    return (
      <KeyListItem as={onSelect ? 'label' : 'div'}>
        {onSelect && (
          <KeyCheckbox
            checked={selected}
            disabled={disabled}
            onChange={event => onSelect(event.currentTarget.checked)}
            aria-label={`Select ${item.alias || item.index}`}
          />
        )}
        <KeyListItemContent>
          <KeyTags>
            <KeyTypeTag className={type}>{type}</KeyTypeTag>
            {item.alias && <KeyAliasTag>{item.alias}</KeyAliasTag>}
            {wallet && (
              <DerivationTag
                chain={ADDRESS_TYPES[wallet.addressType].chain}
                $hasPath={!!wallet.path}
              >
                {wallet.path ?? ADDRESS_TYPE_LABELS[wallet.addressType]}
              </DerivationTag>
            )}
          </KeyTags>
          {wallet ? (
            <KeyListAddress>{wallet.address}</KeyListAddress>
          ) : (
            <KeyListPlaceholder>
              {WalletKeyKnownType.is(item.type) && item.alias
                ? 'No local address'
                : item.index.toLowerCase()}
            </KeyListPlaceholder>
          )}
        </KeyListItemContent>
      </KeyListItem>
    );
  },
);
