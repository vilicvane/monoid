import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import arrowLeftRight from 'lucide-static/icons/arrow-left-right.svg';
import check from 'lucide-static/icons/check.svg';
import refreshCw from 'lucide-static/icons/refresh-cw.svg';
import saveCheck from 'lucide-static/icons/save-check.svg';
import {observer} from 'mobx-react-lite';
import type {ButtonHTMLAttributes, ReactNode} from 'react';
import {css, styled} from 'styled-components';

import type {SafeIndexHex} from '../../../../@atomics.js';
import type {AddressType} from '../../../../@lib/wallet-address.js';
import {ADDRESS_TYPES} from '../../../../@lib/wallet-address.js';
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
import {RippleEffect} from '../../../@ui/ripple-effect.js';
import type {ScannedCardKeyData} from '../common.js';

const ADDRESS_LABELS: Record<AddressType, string> = {
  evm: 'EVM',
  solana: 'Solana',
  'bitcoin-segwit': 'Native SegWit',
  'bitcoin-taproot': 'Taproot',
};

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
  ${addressTypeTriggerStyles}
`;

const AddressTypeSwitch = styled(KeyDerivationBadge)`
  position: relative;
  z-index: 0;
  background-color: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  ${addressTypeTriggerStyles}
`;

const KeyCheckbox = styled(KeyTag)`
  width: 22px;
  padding: 0;

  display: flex;
  align-items: center;
  justify-content: center;

  background-color: var(--ion-color-dark-contrast);
  border-color: var(--ion-color-medium-tint);

  transition: all 0.2s linear;

  &.up-to-date {
    background-color: var(--ion-color-light);
    border-color: var(--ion-color-light-shade);
    color: var(--ion-color-medium-tint);
  }

  &.checked {
    background-color: var(--ion-color-primary);
    border-color: var(--ion-color-primary-shade);
    color: var(--ion-color-primary-contrast);
  }
`;

const KeyUpdateTag = styled(KeyTag)`
  width: 22px;
  padding: 0;
  background-color: #fff1dc;
  border-color: #f3d4a3;
  color: #b87316;
`;

export type KeyItemState = 'new' | 'outdated' | 'up-to-date';

export const KeyItem = observer(
  ({
    data: {type, index, alias},
    addressType,
    address,
    state,
    selectedIndexSet,
    disabled,
    onChangeAddressType,
  }: {
    data: ScannedCardKeyData;
    addressType: AddressType;
    address: string | undefined;
    state: KeyItemState;
    selectedIndexSet: Set<SafeIndexHex>;
    disabled: boolean;
    onChangeAddressType: () => void;
  }): ReactNode => {
    const path =
      type === 'seed' || type === 'master'
        ? ADDRESS_TYPES[addressType].path(0)
        : undefined;
    const checkable = state !== 'up-to-date';

    const checked = checkable && selectedIndexSet.has(index);

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

    let icon: ReactNode | undefined;

    switch (state) {
      case 'new':
      case 'outdated':
        icon = checked ? <IonIcon icon={check} /> : undefined;
        break;
      case 'up-to-date':
        icon = <IonIcon icon={saveCheck} />;
        break;
    }

    return (
      <KeyListItem
        className="ion-activatable"
        onClick={
          checkable && !disabled
            ? () => {
                if (checked) {
                  selectedIndexSet.delete(index);
                } else {
                  selectedIndexSet.add(index);
                }
              }
            : undefined
        }
      >
        <KeyListItemContent>
          <KeyTags>
            <KeyCheckbox
              className={classNames({
                checked,
                [state]: true,
              })}
            >
              {icon}
            </KeyCheckbox>
            <KeyTypeTag className={type}>{type}</KeyTypeTag>
            {alias && <KeyAliasTag>{alias}</KeyAliasTag>}
            <DerivationTag
              chain={ADDRESS_TYPES[addressType].chain}
              buttonProps={{
                ...addressTypeButtonProps,
                'aria-label': `Change address type: ${path ?? ADDRESS_LABELS[addressType]}`,
              }}
            >
              {path ?? ADDRESS_LABELS[addressType]}
            </DerivationTag>
            <AddressTypeSwitch
              as="button"
              {...addressTypeButtonProps}
              aria-label="Change address type"
            >
              <IonIcon icon={arrowLeftRight} aria-hidden="true" />
            </AddressTypeSwitch>
            {state === 'outdated' && (
              <KeyUpdateTag role="img" aria-label="Update available">
                <IonIcon icon={refreshCw} aria-hidden="true" />
              </KeyUpdateTag>
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
        {checkable && <RippleEffect />}
      </KeyListItem>
    );
  },
);
