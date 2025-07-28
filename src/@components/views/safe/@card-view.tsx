import {IonIcon, IonRippleEffect} from '@ionic/react';
import classNames from 'classNames';
import {
  cardOutline,
  checkmark,
  fileTrayFullOutline,
  refresh,
} from 'ionicons/icons';
import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import type {SafeIndexHex} from '../../../@atomics.js';
import {useEntrances} from '../../../@entrances.js';
import type {Router} from '../../../@routes.js';
import type {
  WalletKeyData,
  WalletStorageService,
} from '../../../@services/index.js';
import {WalletKeyKnownType} from '../../../@services/index.js';
import {Address} from '../../@ui/address.js';
import {Button} from '../../@ui/button.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../../@view/index.js';

import type {ScannedCardData, ScannedCardKeyData} from './common.js';

const Id = styled.div`
  color: var(--ion-color-medium);
  background-color: var(--ion-color-light);
  border-radius: 4px;

  height: 24px;
  padding: 0 6px 0 4px;
  border: solid 0.5px var(--ion-color-light-shade);

  display: flex;
  align-items: center;
  gap: 4px;
`;

const IdIcon = styled(IonIcon)`
  font-size: 20px;
`;

const IdNumber = styled.span``;

const List = styled.div`
  flex: 1;

  margin: 0 calc(-1 * var(--view-padding));
`;

const Buttons = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const CardView = observer(
  ({view}: RouteComponentProps<Router['safe']['card']>): ReactNode => {
    const {walletStorageService, errorService} = useEntrances();

    const {indexToKeyMap} = walletStorageService;

    const keyItems = view.card.keys.map(
      (key): [ScannedCardKeyData, KeyItemState] => {
        const existingKey = indexToKeyMap.get(key.index);

        if (existingKey) {
          return [
            key,
            isWalletKeyUpToDate(key, existingKey) ? 'up-to-date' : 'outdated',
          ];
        } else {
          return [key, 'new'];
        }
      },
    );

    const [selectedIndexSet] = useState(() => observable.set());

    const selectedAny = keyItems.some(
      ([key, state]) =>
        state !== 'up-to-date' && selectedIndexSet.has(key.index),
    );

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Card</ViewHeaderTitle>
          <Id>
            <IdIcon icon={cardOutline} />
            <IdNumber>{view.card.id}</IdNumber>
          </Id>
        </ViewHeader>
        <ViewContent>
          <List>
            {keyItems.map(([key, state]) => (
              <KeyItem
                key={key.index}
                data={key}
                state={state}
                selectedIndexSet={selectedIndexSet}
              />
            ))}
          </List>
          <Buttons>
            <Button
              disabled={!selectedAny}
              onClick={errorService.catch(() =>
                importSelectedKeys(
                  walletStorageService,
                  view.card,
                  selectedIndexSet,
                ),
              )}
            >
              Import
            </Button>
          </Buttons>
        </ViewContent>
      </View>
    );
  },
);

function importSelectedKeys(
  walletStorageService: WalletStorageService,
  {keys}: ScannedCardData,
  selectedIndexSet: Set<SafeIndexHex>,
): void {
  const selectedKeys = keys.filter(key => selectedIndexSet.has(key.index));

  const existingKeys = new Map(
    walletStorageService.keys.map(key => [key.index, key]),
  );

  runInAction(() => {
    for (const key of selectedKeys) {
      const existingKey = existingKeys.get(key.index);

      if (existingKey) {
        if (existingKey.alias === undefined && key.alias) {
          existingKey.alias = key.alias;
        }

        if (
          existingKey.wallets.some(wallet => wallet.address === key.ref.address)
        ) {
          console.debug('wallet already exists:', key.ref.address);
          continue;
        }

        existingKey.wallets.push({
          seed: key.ref.seed,
          curve: key.ref.curve,
          path: key.ref.path,
          address: key.ref.address,
        });
      } else {
        walletStorageService.keys.push({
          type: WalletKeyKnownType.satisfies(key.type),
          index: key.index,
          alias: key.alias,
          wallets: [
            {
              seed: key.ref.seed,
              curve: key.ref.curve,
              path: key.ref.path,
              address: key.ref.address,
            },
          ],
        });

        console.debug('added new wallet key:', key.ref.address);
      }
    }
  });
}

function isWalletKeyUpToDate(
  key: ScannedCardKeyData,
  existingKey: WalletKeyData,
): boolean {
  console.assert(key.index === existingKey.index);

  if (existingKey.wallets.every(wallet => wallet.address !== key.ref.address)) {
    return false;
  }

  if (existingKey.alias === undefined && key.alias) {
    return false;
  }

  return true;
}

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

const KeyTags = styled.div`
  display: flex;
  gap: 10px;
`;

const KeyTag = styled.div`
  margin: 0 -2px;

  height: 22px;
  padding: 0 6px;
  font-size: 13px;
  border-radius: 12px;

  background-color: var(--ion-color-light);
  border: solid 0.5px var(--ion-color-light-shade);
  color: var(--ion-color-medium-shade);

  display: flex;
  align-items: center;
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

const KeyType = styled(KeyTag)`
  &.seed {
    background-color: var(--color-seed-light);
    border-color: var(--color-seed-light-shade);
    color: var(--color-seed-light-contrast);
  }

  &.master {
    background-color: var(--color-master-light);
    border-color: var(--color-master-light-shade);
    color: var(--color-master-light-contrast);
  }
`;

const KeyAlias = styled(KeyTag)`
  background-color: var(--ion-color-primary);
  border-color: var(--ion-color-primary-shade);
  color: var(--ion-color-primary-contrast);
`;

const KeyDerivation = styled(KeyTag)`
  background-color: var(--ion-color-dark-contrast);
  border-color: var(--ion-color-light-shade);
  color: var(--ion-color-dark);
`;

const KeyRefAddress = styled(Address)`
  color: var(--ion-color-dark);
`;

type KeyItemState = 'new' | 'outdated' | 'up-to-date';

const KeyItem = observer(
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
        icon = checked ? <IonIcon icon={checkmark} /> : undefined;
        break;
      case 'outdated':
        icon = <IonIcon icon={refresh} />;
        break;
      case 'up-to-date':
        icon = <IonIcon icon={fileTrayFullOutline} />;
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
            <KeyType className={type}>{type}</KeyType>
            {path && <KeyDerivation>{path}</KeyDerivation>}
            {alias && <KeyAlias>{alias}</KeyAlias>}
          </KeyTags>
          <KeyRefAddress>{address}</KeyRefAddress>
        </ItemContent>
        {checkable && <IonRippleEffect />}
      </Item>
    );
  },
);
