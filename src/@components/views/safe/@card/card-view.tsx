import {IonIcon} from '@ionic/react';
import saveCheck from 'lucide-static/icons/save-check.svg';
import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import type {SafeIndexHex} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {AddressType} from '../../../../@lib/wallet-address.js';
import type {Router} from '../../../../@routes.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {useTemporaryState} from '../../../@hooks/interactions.js';
import {KeyList} from '../../../@key/key-list.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {Button} from '../../../@ui/button.js';
import {BUTTON_FEEDBACK_DURATION} from '../../../@ui/constants.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
} from '../../../@view/index.js';
import {
  getCardKeyAddressTypes,
  getLocalCardKeyAddress,
  readCardKeyAddress,
} from '../card-address.js';
import {
  getCardKeyData,
  importCardKey,
  isWalletKeyUpToDate,
} from '../card-key-import.js';
import type {ScannedCardData, ScannedCardKeyData} from '../common.js';

import {AddressTypePicker} from './@address-type-picker.js';
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
        {view.card ? (
          <CardContent key={view.card.id} card={view.card} view={view} />
        ) : (
          <ViewContent />
        )}
      </View>
    );
  },
);

type CardKeySelection = {
  key: ScannedCardKeyData;
  addressType: AddressType;
  refs: Partial<Record<AddressType, ScannedCardKeyData['ref']>>;
};

const CardContent = observer(
  ({
    card,
    view,
  }: {
    card: ScannedCardData;
    view: RouteComponentProps<Router['safe']['card']>['view'];
  }): ReactNode => {
    const {walletStorageService, errorService} = useEntrances();
    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      safe: true,
      auth: 'access',
      retryOnError: true,
    });
    const [items, setItems] = useState<CardKeySelection[]>(() =>
      card.keys.map(key => ({
        key,
        addressType: key.ref.addressType,
        refs: {[key.ref.addressType]: key.ref},
      })),
    );
    const [editingIndex, setEditingIndex] = useState<SafeIndexHex>();
    const [deriving, setDeriving] = useState(false);
    const mounted = useRef(true);

    useEffect(() => {
      mounted.current = true;

      return () => {
        mounted.current = false;
      };
    }, []);

    const {indexToKeyMap} = walletStorageService;

    const keyItems = items.map(item => {
      const ref = item.refs[item.addressType];
      const existingKey = indexToKeyMap.get(item.key.index);
      const state: KeyItemState = existingKey
        ? ref &&
          isWalletKeyUpToDate(
            getCardKeyData({...item.key, ref}, Object.values(item.refs)),
            existingKey,
          )
          ? 'up-to-date'
          : 'outdated'
        : 'new';

      return {item, ref, state};
    });

    const [selectedIndexSet] = useState(() => observable.set<SafeIndexHex>());

    const selected = keyItems.filter(
      ({item, state}) =>
        state !== 'up-to-date' && selectedIndexSet.has(item.key.index),
    );
    const missing = selected.filter(({ref}) => !ref);
    const editing = items.find(item => item.key.index === editingIndex);

    const [imported, setImported] = useTemporaryState(
      false,
      BUTTON_FEEDBACK_DURATION,
    );

    const deriveSelected = async (): Promise<void> => {
      if (deriving || missing.length === 0) {
        return;
      }

      setDeriving(true);
      const derivedRefs = new Map<SafeIndexHex, ScannedCardKeyData['ref']>();

      try {
        await scanPrompt(
          'Scan card to derive',
          async (applet, setStateContent, hello) => {
            if (uint8ArrayToHex(hello.safe.id) !== card.id) {
              throw new Error('Wrong card. Scan the card shown in this list.');
            }

            for (const [index, {item}] of missing.entries()) {
              setStateContent(
                <MonoidScanStatePromptProgress
                  current={index + 1}
                  total={missing.length}
                >
                  Deriving addresses
                </MonoidScanStatePromptProgress>,
              );
              derivedRefs.set(
                item.key.index,
                await readCardKeyAddress(applet, item.key, item.addressType),
              );
            }
          },
        );

        if (
          mounted.current &&
          !view.$leaving &&
          view.$match.$exact.$active &&
          view.card === card
        ) {
          setItems(current =>
            current.map(item => {
              const ref = derivedRefs.get(item.key.index);

              return ref
                ? {...item, refs: {...item.refs, [ref.addressType]: ref}}
                : item;
            }),
          );
        }
      } finally {
        if (mounted.current) {
          setDeriving(false);
        }
      }
    };

    return (
      <>
        <ViewContent
          footerReveal="end"
          footer={
            <>
              <Button
                disabled={missing.length === 0}
                loading={deriving}
                onClick={errorService.catch(deriveSelected)}
              >
                Derive
              </Button>
              <Button
                id="import-button"
                disabled={
                  deriving || selected.length === 0 || missing.length > 0
                }
                onClick={errorService.catch(async () => {
                  if (missing.length > 0) {
                    return;
                  }

                  runInAction(() => {
                    for (const {item, ref} of selected) {
                      if (!ref) continue;

                      const key = {...item.key, ref};
                      importCardKey(
                        walletStorageService,
                        getCardKeyData(key, Object.values(item.refs)),
                      );
                    }
                  });

                  setImported(true);
                })}
              >
                {imported ? (
                  <>
                    <IonIcon icon={saveCheck} />
                    Import successful
                  </>
                ) : (
                  'Import'
                )}
              </Button>
            </>
          }
        >
          <KeyList>
            {keyItems.map(({item, ref, state}) => (
              <KeyItem
                key={item.key.index}
                data={item.key}
                addressType={item.addressType}
                address={ref?.address}
                state={state}
                selectedIndexSet={selectedIndexSet}
                disabled={deriving}
                onChangeAddressType={() => setEditingIndex(item.key.index)}
              />
            ))}
          </KeyList>
        </ViewContent>
        {editing && (
          <AddressTypePicker
            value={editing.addressType}
            addressTypes={getCardKeyAddressTypes(editing.key.type)}
            onDismiss={() => setEditingIndex(undefined)}
            onChange={addressType => {
              setItems(current =>
                current.map(item => {
                  if (item.key.index !== editing.key.index) {
                    return item;
                  }

                  const ordinaryRef =
                    item.refs.evm ?? item.refs['bitcoin-segwit'];
                  const localRef =
                    item.key.type === 'secp256k1' && ordinaryRef
                      ? getLocalCardKeyAddress(ordinaryRef, addressType)
                      : undefined;

                  return {
                    ...item,
                    addressType,
                    refs: localRef
                      ? {...item.refs, [addressType]: localRef}
                      : item.refs,
                  };
                }),
              );
              setImported(false);
              setEditingIndex(undefined);
            }}
          />
        )}
        {scanPromptContent}
      </>
    );
  },
);
