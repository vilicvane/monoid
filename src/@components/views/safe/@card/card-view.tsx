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
import {Button, Buttons} from '../../../@ui/button.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
} from '../../../@view/index.js';
import type {ScannedCardData, ScannedCardKeyData} from '../common.js';

import type {KeyItemState} from './@key-item.js';
import {KeyItem} from './@key-item.js';

const List = styled.div`
  flex: 1;
  margin: 0 calc(-1 * var(--view-padding));
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
          <ViewHeaderIdentifier icon={cardOutline}>
            {view.card.id}
          </ViewHeaderIdentifier>
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
