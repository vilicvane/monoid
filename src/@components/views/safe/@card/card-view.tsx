import {IonIcon} from '@ionic/react';
import {cardOutline} from 'ionicons/icons';
import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import type {SafeIndexHex} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import type {
  WalletKeyData,
  WalletStorageService,
} from '../../../../@services/index.js';
import {WalletKeyKnownType} from '../../../../@services/index.js';
import {Button} from '../../../@ui/button.js';
import {
  View,
  ViewContent as ViewContent_,
  ViewHeader,
  ViewHeaderTitle,
} from '../../../@view/index.js';
import type {ScannedCardData, ScannedCardKeyData} from '../common.js';

import type {KeyItemState} from './@key-item.js';
import {KeyItem} from './@key-item.js';

const ViewContent = styled(ViewContent_)`
  padding-left: 0;
  padding-right: 0;
`;

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
