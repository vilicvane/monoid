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
import {isCardDerivationItem} from '../card-derivations.js';
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

const ResourceRelation = styled(KeyListPlaceholder)`
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;

  > span {
    flex-shrink: 0;
    white-space: nowrap;
  }
`;

const RelatedAlias = styled.span`
  && {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`;

export const CardResourceItem = observer(
  ({
    data: item,
    resources,
    selected = false,
    disabled = false,
    onSelect,
  }: {
    data: Pick<
      ScannedCardItemData,
      'index' | 'type' | 'alias' | 'publicKey' | 'derivationRecord'
    >;
    resources?: readonly Pick<
      ScannedCardItemData,
      'index' | 'type' | 'alias' | 'derivationRecord'
    >[];
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
    const type = isCardDerivationItem(item)
      ? 'addresses'
      : typeof item.type === 'string'
        ? item.type
        : typeCode === 0x0fff
          ? 'generic'
          : `0x${typeCode.toString(16).padStart(4, '0')}`;
    const sourceIndex = (
      item.derivationRecord ??
      resources?.find(resource => resource.index === item.index)
        ?.derivationRecord
    )?.index;
    const source = sourceIndex
      ? (resources?.find(resource => resource.index === sourceIndex) ??
        walletStorageService.indexToKeyMap.get(sourceIndex))
      : undefined;
    const sourceType =
      source?.type ??
      (sourceIndex?.startsWith('02')
        ? 'seed'
        : sourceIndex?.startsWith('03')
          ? 'master'
          : sourceIndex?.startsWith('0401')
            ? 'secp256k1'
            : 'ed25519');

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
          {sourceIndex ? (
            <ResourceRelation title={`Source: ${sourceIndex}`}>
              <span>For {sourceType}</span>
              {source?.alias && (
                <>
                  <span>·</span>
                  <RelatedAlias>{source.alias}</RelatedAlias>
                </>
              )}
              <span>· {sourceIndex.slice(2, 10)}</span>
            </ResourceRelation>
          ) : wallet ? (
            <KeyListAddress>{wallet.address}</KeyListAddress>
          ) : item.publicKey ? (
            <KeyListAddress>{item.publicKey}</KeyListAddress>
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
