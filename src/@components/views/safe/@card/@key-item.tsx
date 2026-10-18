import {
  ArrowLeftRight as arrowLeftRight,
  RefreshCw as refreshCw,
  SaveCheck as saveCheck,
} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {css, styled} from 'styled-components';

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
`;

const KeySavedTag = styled(KeyTag)`
  width: 22px;
  padding: 0;
  color: var(--ion-color-medium-tint);
`;

export type KeyItemState = 'new' | 'outdated' | 'up-to-date';

export const KeyItem = observer(
  ({
    data: {type, index, alias},
    addressType,
    address,
    state,
    selected,
    disabled,
    onSelect,
    onChangeAddressType,
  }: {
    data: Pick<ScannedCardKeyData, 'type' | 'index' | 'alias'>;
    addressType: AddressType;
    address: string | undefined;
    state: KeyItemState;
    selected: boolean;
    disabled: boolean;
    onSelect: (selected: boolean) => void;
    onChangeAddressType: () => void;
  }): ReactNode => {
    const path =
      type === 'seed' || type === 'master'
        ? ADDRESS_TYPES[addressType].path(0)
        : undefined;
    const canChangeAddressType = getCardKeyAddressTypes(type).length > 1;

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
                      'aria-label': `Change address type: ${path ?? ADDRESS_TYPE_LABELS[addressType]}`,
                    }
                  : undefined
              }
            >
              {path ?? ADDRESS_TYPE_LABELS[addressType]}
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
            {state === 'outdated' && (
              <KeyUpdateTag role="img" aria-label="Update available">
                <AppIcon icon={refreshCw} aria-hidden="true" />
              </KeyUpdateTag>
            )}
            {state === 'up-to-date' && (
              <KeySavedTag role="img" aria-label="Saved">
                <AppIcon icon={saveCheck} aria-hidden="true" />
              </KeySavedTag>
            )}
          </KeyTags>
          {address ? (
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
