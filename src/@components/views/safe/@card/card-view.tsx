import {observable, reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {type SafeIndexHex, SafeKnownType} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {AddressType} from '../../../../@lib/wallet-address.js';
import type {Router} from '../../../../@routes.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {KeyListPlaceholder} from '../../../@key/key-list.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {SegmentedControl} from '../../../@ui/segmented-control.js';
import {
  View,
  ViewActionButton,
  ViewContent,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../../../@view/index.js';
import {
  getCardKeyAddressTypes,
  getLocalCardKeyAddress,
  readCardKeyAddress,
} from '../card-address.js';
import {
  assertCardForAliasUpdate,
  writeCardAliases,
} from '../card-alias-update.js';
import {
  getCardKeyData,
  importCardKey,
  isWalletKeyUpToDate,
} from '../card-key-import.js';
import {
  type ScannedCardData,
  type ScannedCardKeyData,
  isCardKeyItem,
} from '../common.js';

import {AddressTypePicker} from './@address-type-picker.js';
import type {KeyItemState} from './@key-item.js';
import {KeyItem} from './@key-item.js';
import {CardResourceItem, CardResourceList} from './@resource-item.js';

export const CardView = observer(
  ({view}: RouteComponentProps<Router['safe']['card']>): ReactNode => {
    const {card} = view;

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Card</ViewHeaderTitle>
          {card && (
            <ViewHeaderIdentifier identifier={{type: 'card', id: card.id}} />
          )}
        </ViewHeader>
        {card ? (
          <CardContent key={card.id} card={card} view={view} />
        ) : (
          <ViewContent />
        )}
      </View>
    );
  },
);

type CardKeySelection = {
  key: Pick<ScannedCardKeyData, 'type' | 'index' | 'alias'>;
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
    const {walletStorageService, errorService, router} = useEntrances();
    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      safe: true,
      auth: 'access',
      retryOnError: true,
    });
    const [items, setItems] = useState<CardKeySelection[]>(() =>
      card.items.flatMap(item => {
        if (typeof item.type !== 'string') return [];

        const addressType =
          item.ref?.addressType ?? getCardKeyAddressTypes(item.type)[0];
        if (!addressType) return [];

        return [
          {
            key: {
              type: SafeKnownType.satisfies(item.type),
              index: item.index,
              alias: item.alias,
            },
            addressType,
            refs: item.ref ? {[item.ref.addressType]: item.ref} : {},
          },
        ];
      }),
    );
    const [resourceFilter, setResourceFilter] = useState<'keys' | 'all'>(
      'keys',
    );
    const [editingIndex, setEditingIndex] = useState<SafeIndexHex>();
    const [deriving, setDeriving] = useState(false);
    const [updatingCard, setUpdatingCard] = useState(false);
    const busy = deriving || updatingCard;
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

      const canWriteAlias =
        existingKey?.alias !== undefined &&
        existingKey.alias !== (item.key.alias ?? '');

      return {item, ref, state, canWriteAlias};
    });
    const keyItemMap = new Map(
      keyItems.map(keyItem => [keyItem.item.key.index, keyItem]),
    );
    const keyCount = card.items.filter(isCardKeyItem).length;
    const visibleItems =
      resourceFilter === 'all' ? card.items : card.items.filter(isCardKeyItem);

    const [selectedIndexSet] = useState(() => observable.set<SafeIndexHex>());

    const selectedResources = card.items.filter(item =>
      selectedIndexSet.has(item.index),
    );
    const selectedKeys = keyItems.filter(({item}) =>
      selectedIndexSet.has(item.key.index),
    );
    const hiddenSelectedCount =
      resourceFilter === 'keys'
        ? selectedResources.filter(item => !isCardKeyItem(item)).length
        : 0;
    const missing = selectedKeys.filter(({ref}) => !ref);
    const writableKeys = selectedKeys.filter(
      ({canWriteAlias}) => canWriteAlias,
    );
    const canImport =
      selectedResources.length > 0 &&
      selectedKeys.length === selectedResources.length &&
      selectedKeys.every(({ref, state}) => ref && state !== 'up-to-date');
    const updating =
      selectedKeys.length > 0 &&
      selectedKeys.every(({state}) => state !== 'new');
    const editing = items.find(item => item.key.index === editingIndex);

    const [imported, setImported] = useState(false);
    const backToSafe = router.$backTo(router.safe.$exact);

    const selectItem = (index: SafeIndexHex, selected: boolean): void => {
      runInAction(() => {
        if (selected) selectedIndexSet.add(index);
        else selectedIndexSet.delete(index);
      });
      setImported(false);
    };

    const deriveSelected = async (): Promise<void> => {
      if (busy || missing.length === 0) {
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

    const updateCard = async (): Promise<void> => {
      if (busy || writableKeys.length === 0) return;

      const pending = new Map(
        writableKeys.map(({item}) => [
          item.key.index,
          indexToKeyMap.get(item.key.index)!.alias!,
        ]),
      );
      const total = pending.size;
      const operation = new AbortController();
      const stopWatching = reaction(
        () => !!view.$leaving || !view.$match.$exact.$active,
        leaving => {
          if (leaving) operation.abort();
        },
        {fireImmediately: true},
      );
      setUpdatingCard(true);
      setImported(false);

      try {
        await scanPrompt(
          'Scan card to update',
          async (applet, setStateContent, _hello, signal) => {
            const cancel = (): void => operation.abort();
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();

            const showProgress = (): void => {
              setStateContent(
                <MonoidScanStatePromptProgress
                  current={Math.min(total, total - pending.size + 1)}
                  total={total}
                >
                  Updating aliases
                </MonoidScanStatePromptProgress>,
              );
            };

            try {
              showProgress();
              await writeCardAliases(
                applet,
                pending,
                operation.signal,
                (index, alias) => {
                  runInAction(() => {
                    card.items.find(item => item.index === index)!.alias =
                      alias;
                  });

                  if (mounted.current && view.card === card) {
                    setItems(current =>
                      current.map(item =>
                        item.key.index === index
                          ? {...item, key: {...item.key, alias}}
                          : item,
                      ),
                    );
                  }

                  showProgress();
                },
              );
            } finally {
              signal.removeEventListener('abort', cancel);
            }
          },
          hello => assertCardForAliasUpdate(hello, card),
        );
      } finally {
        stopWatching();
        if (mounted.current) setUpdatingCard(false);
      }
    };

    return (
      <>
        <ViewContent
          footer={
            <>
              <ViewActionButton
                visible={deriving || missing.length > 0}
                loading={deriving}
                disabled={updatingCard}
                onClick={errorService.catch(deriveSelected)}
              >
                Derive
              </ViewActionButton>
              <ViewActionButton
                visible={imported ? !!backToSafe : canImport}
                id="import-button"
                color={imported ? 'neutral' : 'primary'}
                disabled={busy || (!imported && !canImport)}
                onClick={errorService.catch(async () => {
                  if (imported) {
                    backToSafe?.();
                    return;
                  }

                  if (!canImport) {
                    return;
                  }

                  runInAction(() => {
                    for (const {item, ref} of selectedKeys) {
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
                {imported ? 'Back to Safe' : updating ? 'Update' : 'Import'}
              </ViewActionButton>
              <ViewActionButton
                visible={updatingCard || writableKeys.length > 0}
                loading={updatingCard}
                disabled={deriving}
                onClick={errorService.catch(updateCard)}
              >
                Update card
              </ViewActionButton>
              <ViewActionButton
                visible={
                  !imported &&
                  selectedResources.length > 0 &&
                  missing.length === 0
                }
                color="neutral"
                disabled={busy}
                onClick={() => {
                  router.safe
                    .copyItems({
                      sourceCard: card,
                      sourceIndexes: selectedResources.map(item => item.index),
                    })
                    .$push();
                }}
              >
                Copy
              </ViewActionButton>
            </>
          }
        >
          {keyCount < card.items.length && (
            <SegmentedControl
              aria-label="Card resources"
              value={resourceFilter}
              options={[
                {value: 'keys', label: `Keys · ${keyCount}`},
                {value: 'all', label: `All · ${card.items.length}`},
              ]}
              onChange={setResourceFilter}
            />
          )}
          {hiddenSelectedCount > 0 && (
            <KeyListPlaceholder role="status">
              {hiddenSelectedCount} selected{' '}
              {hiddenSelectedCount === 1 ? 'item is' : 'items are'} hidden by
              this filter.
            </KeyListPlaceholder>
          )}
          {visibleItems.length > 0 ? (
            <CardResourceList>
              {visibleItems.map(resource => {
                const keyItem = keyItemMap.get(resource.index);
                if (!keyItem) {
                  return (
                    <CardResourceItem
                      key={resource.index}
                      data={resource}
                      selected={selectedIndexSet.has(resource.index)}
                      disabled={busy}
                      onSelect={selected =>
                        selectItem(resource.index, selected)
                      }
                    />
                  );
                }

                const {item, ref, state, canWriteAlias} = keyItem;
                return (
                  <KeyItem
                    key={item.key.index}
                    data={item.key}
                    addressType={item.addressType}
                    address={ref?.address}
                    state={state}
                    canWriteAlias={canWriteAlias}
                    selected={selectedIndexSet.has(item.key.index)}
                    disabled={busy}
                    onSelect={selected => selectItem(item.key.index, selected)}
                    onChangeAddressType={() => setEditingIndex(item.key.index)}
                  />
                );
              })}
            </CardResourceList>
          ) : (
            <ViewPlaceholder>
              {card.items.length ? 'No keys' : 'No items'}
            </ViewPlaceholder>
          )}
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
