import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import checkCheck from 'lucide-static/icons/check-check.svg';
import check from 'lucide-static/icons/check.svg';
import rotateCw from 'lucide-static/icons/rotate-cw.svg';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {styled} from 'styled-components';

import type {SafeIndexHex} from '../../../../@atomics.js';
import {
  KeyAliasTag,
  KeyDerivationTag,
  KeyTag,
  KeyTags,
  KeyTypeTag,
} from '../../../@key/key-tags.js';
import {Address} from '../../../@ui/address.js';
import {RippleEffect} from '../../../@ui/ripple-effect.js';
import type {ScannedCardKeyData} from '../common.js';

const Item = styled.div`
  position: relative;
  display: flex;

  align-items: center;
  justify-content: space-between;
  gap: 8px;

  padding: 12px var(--view-padding);

  overflow: hidden;
`;

const ItemContent = styled.div`
  flex: 1;

  display: flex;
  flex-direction: column;
  gap: 8px;
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
    color: var(--ion-color-dark);
  }

  &.checked {
    background-color: var(--ion-color-primary);
    border-color: var(--ion-color-primary-shade);
    color: var(--ion-color-primary-contrast);
  }
`;

const KeyRefAddress = styled(Address)`
  color: var(--ion-color-dark);
`;

export type KeyItemState = 'new' | 'outdated' | 'up-to-date';

export const KeyItem = observer(
  ({
    data: {
      type,
      index,
      alias,
      ref: {path, address},
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
        icon = <IonIcon icon={rotateCw} />;
        break;
      case 'up-to-date':
        icon = <IonIcon icon={checkCheck} />;
        break;
    }

    return (
      <Item
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
        <ItemContent>
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
            {path && <KeyDerivationTag>{path}</KeyDerivationTag>}
            {alias && <KeyAliasTag>{alias}</KeyAliasTag>}
          </KeyTags>
          <KeyRefAddress>{address}</KeyRefAddress>
        </ItemContent>
        {checkable && <RippleEffect />}
      </Item>
    );
  },
);
