import {IonIcon} from '@ionic/react';
import checkCheck from 'lucide-static/icons/check-check.svg';
import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import type {SafeIndexHex} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import type {
  WalletKeyData,
  WalletStorageService,
} from '../../../../@services/index.js';
import {WalletKeyKnownType} from '../../../../@services/index.js';
import {useTemporaryState} from '../../../@hooks/interactions.js';
import {KeyList} from '../../../@key/key-list.js';
import {Button, Buttons} from '../../../@ui/button.js';
import {BUTTON_FEEDBACK_DURATION} from '../../../@ui/constants.js';
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

export const CardView = observer(
  ({view}: RouteComponentProps<Router['safe']['card']>): ReactNode => {
    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Card</ViewHeaderTitle>
          {view.card && (
            <ViewHeaderIdentifier
              identifier={{type: 'card', id: view.card.id}}
            />
          )}
        </ViewHeader>
        {view.card ? <CardContent card={view.card} /> : <ViewContent />}
      </View>
    );
  },
);

const CardContent = observer(({card}: {card: ScannedCardData}): ReactNode => {
  const {walletStorageService, errorService} = useEntrances();

  const {indexToKeyMap} = walletStorageService;

  const keyItems = card.keys.map((key): [ScannedCardKeyData, KeyItemState] => {
    const existingKey = indexToKeyMap.get(key.index);

    if (existingKey) {
      return [
        key,
        isWalletKeyUpToDate(key, existingKey) ? 'up-to-date' : 'outdated',
      ];
    } else {
      return [key, 'new'];
    }
  });

  const [selectedIndexSet] = useState(() => observable.set());

  const selectedAny = keyItems.some(
    ([key, state]) => state !== 'up-to-date' && selectedIndexSet.has(key.index),
  );

  const [imported, setImported] = useTemporaryState(
    false,
    BUTTON_FEEDBACK_DURATION,
  );

  return (
    <ViewContent>
      <KeyList>
        {keyItems.map(([key, state]) => (
          <KeyItem
            key={key.index}
            data={key}
            state={state}
            selectedIndexSet={selectedIndexSet}
          />
        ))}
      </KeyList>
      <Buttons>
        <Button
          id="import-button"
          disabled={!selectedAny}
          onClick={errorService.catch(async () => {
            importSelectedKeys(walletStorageService, card, selectedIndexSet);

            setImported(true);
          })}
        >
          {imported ? (
            <>
              <IonIcon icon={checkCheck} />
              Import successful
            </>
          ) : (
            'Import'
          )}
        </Button>
      </Buttons>
    </ViewContent>
  );
});

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
        existingKey.type = WalletKeyKnownType.satisfies(key.type);
        existingKey.alias = key.alias;

        const existingWallet = existingKey.wallets.find(
          wallet =>
            wallet.addressType === key.ref.addressType &&
            wallet.address === key.ref.address,
        );

        if (existingWallet) {
          existingWallet.seed = key.ref.seed;
          existingWallet.curve = key.ref.curve;
          existingWallet.path = key.ref.path;

          continue;
        }

        existingKey.wallets.push({
          addressType: key.ref.addressType,
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
              addressType: key.ref.addressType,
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

  const existingWallet = existingKey.wallets.find(
    wallet =>
      wallet.addressType === key.ref.addressType &&
      wallet.address === key.ref.address,
  );

  return (
    existingKey.type === key.type &&
    existingKey.alias === key.alias &&
    existingWallet !== undefined &&
    existingWallet.seed === key.ref.seed &&
    existingWallet.curve === key.ref.curve &&
    existingWallet.path === key.ref.path
  );
}
