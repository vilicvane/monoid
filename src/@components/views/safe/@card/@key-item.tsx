import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import check from 'lucide-static/icons/check.svg';
import refreshCw from 'lucide-static/icons/refresh-cw.svg';
import saveCheck from 'lucide-static/icons/save-check.svg';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {SafeIndexHex} from '../../../../@atomics.js';
import {ADDRESS_TYPES} from '../../../../@lib/wallet-address.js';
import {
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
} from '../../../@key/key-list.js';
import {
  KeyAliasTag,
  KeyDerivationTag,
  KeyTag,
  KeyTags,
  KeyTypeTag,
} from '../../../@key/key-tags.js';
import {RippleEffect} from '../../../@ui/ripple-effect.js';
import type {ScannedCardKeyData} from '../common.js';

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

export type KeyItemState = 'new' | 'outdated' | 'up-to-date';

export const KeyItem = observer(
  ({
    data: {
      type,
      index,
      alias,
      ref: {path, address, addressType},
    },
    state,
    selectedIndexSet,
  }: {
    data: ScannedCardKeyData;
    state: KeyItemState;
    selectedIndexSet: Set<SafeIndexHex>;
  }): ReactNode => {
    const checkable = state !== 'up-to-date';

    const checked = checkable && selectedIndexSet.has(index);

    let icon: ReactNode | undefined;

    switch (state) {
      case 'new':
        icon = checked ? <IonIcon icon={check} /> : undefined;
        break;
      case 'outdated':
        icon = <IonIcon icon={checked ? check : refreshCw} />;
        break;
      case 'up-to-date':
        icon = <IonIcon icon={saveCheck} />;
        break;
    }

    return (
      <KeyListItem
        className="ion-activatable"
        onClick={
          checkable
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
            {path && (
              <KeyDerivationTag chain={ADDRESS_TYPES[addressType].chain}>
                {path}
              </KeyDerivationTag>
            )}
          </KeyTags>
          <KeyListAddress>{address}</KeyListAddress>
        </KeyListItemContent>
        {checkable && <RippleEffect />}
      </KeyListItem>
    );
  },
);
