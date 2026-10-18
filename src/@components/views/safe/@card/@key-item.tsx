import {
  ArrowLeftRight as arrowLeftRight,
  ArrowUpToLine as arrowUpToLine,
  RefreshCw as refreshCw,
  SaveCheck as saveCheck,
} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {css, styled} from 'styled-components';

import type {BIP39PathString} from '../../../../@atomics.js';
import type {AddressType} from '../../../../@lib/wallet-address.js';
import {
  ADDRESS_TYPES,
  ADDRESS_TYPE_LABELS,
} from '../../../../@lib/wallet-address.js';
import {KeyCheckbox} from '../../../@key/key-checkbox.js';
import {
  KeyListAddress,
  KeyListAddressPlaceholder,
  KeyListItem,
  KeyListItemContent,
} from '../../../@key/key-list.js';
import {
  KeyAliasTag,
  KeyDerivationBadge,
  KeyDerivationTag,
  KeyTag,
  KeyTags,
  KeyTypeTag,
} from '../../../@key/key-tags.js';
import {AppIcon} from '../../../@ui/app-icon.js';
import {RippleEffect} from '../../../@ui/ripple-effect.js';
import {getCardKeyAddressTypes} from '../card-address.js';
import type {ScannedCardKeyData} from '../common.js';

const addressTypeTriggerStyles = css`
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: 2px;
  }
`;

const DerivationTag = styled(KeyDerivationTag)`
  position: relative;
  z-index: 1;
  flex-shrink: 1;
  min-width: 0;
  &[type='button'] {
    ${addressTypeTriggerStyles}
  }
`;

const AddressTypeSwitch = styled(KeyDerivationBadge)`
  position: relative;
  z-index: 0;
  background-color: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  ${addressTypeTriggerStyles}
`;

const KeyUpdateTag = styled(KeyTag)`
  width: 22px;
  padding: 0;
  background-color: #fff1dc;
  border-color: #f3d4a3;
  color: #b87316;
  &[type='button'] {
    ${addressTypeTriggerStyles}
  }
`;

const KeySavedTag = styled(KeyTag)`
  width: 22px;
  padding: 0;
  color: var(--ion-color-medium-tint);
`;

const KeyWriteTag = styled(KeyTag)`
  width: 22px;
  padding: 0;
  background-color: rgba(var(--ion-color-primary-rgb), 0.1);
  border-color: rgba(var(--ion-color-primary-rgb), 0.28);
  color: var(--ion-color-primary);
  &[type='button'] {
    ${addressTypeTriggerStyles}
  }
`;

export type KeyItemState = 'new' | 'outdated' | 'up-to-date';
export type KeySyncDirection = 'download' | 'upload';

export const KeyItem = observer(
  ({
    data: {type, index, alias},
    addressType,
    address,
    path: derivedPath,
    state,
    canWrite,
    empty,
    syncDirection,
    selected,
    disabled,
    onSelect,
    onChangeAddressType,
    onChangeSyncDirection,
  }: {
    data: Pick<ScannedCardKeyData, 'type' | 'index' | 'alias'>;
    addressType: AddressType;
    address: string | undefined;
    path?: BIP39PathString;
    state: KeyItemState;
    canWrite: boolean;
    empty: boolean;
    syncDirection: KeySyncDirection | undefined;
    selected: boolean;
    disabled: boolean;
    onSelect: (selected: boolean) => void;
    onChangeAddressType: () => void;
    onChangeSyncDirection?: () => void;
  }): ReactNode => {
    const path =
      type === 'seed' || type === 'master'
        ? (derivedPath ?? ADDRESS_TYPES[addressType].path(0))
        : undefined;
    const canChangeAddressType =
      empty || getCardKeyAddressTypes(type).length > 1;

    const addressTypeButtonProps: ButtonHTMLAttributes<HTMLButtonElement> = {
      type: 'button',
      'aria-haspopup': 'dialog',
      disabled,
      onPointerDown: event => event.stopPropagation(),
      onClick: event => {
        event.stopPropagation();
        onChangeAddressType();
      },
    };
    const syncButtonProps: ButtonHTMLAttributes<HTMLButtonElement> | undefined =
      onChangeSyncDirection
        ? {
            type: 'button',
            disabled,
            onPointerDown: event => event.stopPropagation(),
            onClick: event => {
              event.stopPropagation();
              onChangeSyncDirection();
            },
          }
        : undefined;

    return (
      <KeyListItem
        className="ion-activatable"
        onClick={disabled ? undefined : () => onSelect(!selected)}
      >
        <KeyCheckbox
          checked={selected}
          disabled={disabled}
          onClick={event => event.stopPropagation()}
          onChange={event => onSelect(event.currentTarget.checked)}
          aria-label={`Select ${alias || index}`}
        />
        <KeyListItemContent>
          <KeyTags>
            <KeyTypeTag className={type}>{type}</KeyTypeTag>
            {alias && <KeyAliasTag>{alias}</KeyAliasTag>}
            <DerivationTag
              chain={ADDRESS_TYPES[addressType].chain}
              buttonProps={
                canChangeAddressType
                  ? {
                      ...addressTypeButtonProps,
                      'aria-label': empty
                        ? 'Add address'
                        : `Change address type: ${path ?? ADDRESS_TYPE_LABELS[addressType]}`,
                    }
                  : undefined
              }
            >
              {empty
                ? 'No addresses'
                : (path ?? ADDRESS_TYPE_LABELS[addressType])}
            </DerivationTag>
            {canChangeAddressType && (
              <AddressTypeSwitch
                as="button"
                {...addressTypeButtonProps}
                aria-label="Change address type"
              >
                <AppIcon icon={arrowLeftRight} aria-hidden="true" />
              </AddressTypeSwitch>
            )}
            {syncDirection === 'download' && (
              <KeyUpdateTag
                as={syncButtonProps ? 'button' : undefined}
                {...syncButtonProps}
                role={syncButtonProps ? undefined : 'img'}
                aria-label={
                  syncButtonProps
                    ? 'Update phone from card. Switch to updating card'
                    : 'Update phone from card'
                }
                title={
                  syncButtonProps
                    ? 'Update phone from card. Click to update card instead'
                    : 'Update phone from card'
                }
              >
                <AppIcon icon={refreshCw} aria-hidden="true" />
              </KeyUpdateTag>
            )}
            {canWrite && (
              <KeyWriteTag
                as={syncButtonProps ? 'button' : undefined}
                {...syncButtonProps}
                role={syncButtonProps ? undefined : 'img'}
                aria-label={
                  syncButtonProps
                    ? 'Update card from phone. Switch to updating phone'
                    : 'Update card from phone'
                }
                title="Replace card addresses with phone addresses"
              >
                <AppIcon icon={arrowUpToLine} aria-hidden="true" />
              </KeyWriteTag>
            )}
            {state === 'up-to-date' && !syncDirection && (
              <KeySavedTag role="img" aria-label="Saved">
                <AppIcon icon={saveCheck} aria-hidden="true" />
              </KeySavedTag>
            )}
          </KeyTags>
          {empty ? null : address ? (
            <KeyListAddress>{address}</KeyListAddress>
          ) : (
            <KeyListAddressPlaceholder
              $chain={ADDRESS_TYPES[addressType].chain}
              role="img"
              aria-label="Address not derived"
            />
          )}
        </KeyListItemContent>
        {!disabled && <RippleEffect />}
      </KeyListItem>
    );
  },
);
