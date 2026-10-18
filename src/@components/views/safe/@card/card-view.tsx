import {Ellipsis as ellipsis} from 'lucide-react';
import {observable, reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {type SafeIndexHex, SafeKnownType} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import {
  ADDRESS_TYPES,
  type AddressType,
} from '../../../../@lib/wallet-address.js';
import type {Router} from '../../../../@routes.js';
import {
  type WalletKeyPublicKeyData,
  type WalletKeyWalletParameters,
  getWalletData,
  getWalletReference,
  matchesWalletReference,
} from '../../../../@services/index.js';
import {KeyListPlaceholder} from '../../../@key/key-list.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {AppIcon} from '../../../@ui/app-icon.js';
import {Button, Buttons} from '../../../@ui/button.js';
import {CenteredPopup} from '../../../@ui/centered-popup.js';
import {DetailsPopupTitle} from '../../../@ui/details-popup.js';
import {SegmentedControl} from '../../../@ui/segmented-control.js';
import {
  View,
  ViewActionButton,
  ViewContent,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../../../@view/index.js';
import {
  getCardKeyAddressTypes,
  getLocalCardKeyAddress,
  getLocalCardWalletDerivation,
  readCardKeyAddress,
} from '../card-address.js';
import {assertCardForUpdate, writeCardAliases} from '../card-alias-update.js';
import {writeCardDerivations} from '../card-derivations.js';
import {
  getCardKeyData,
  importCardKey,
  isWalletKeyUpToDate,
} from '../card-key-import.js';
import {deleteCardResources} from '../card-resource-delete.js';
import {getCardResourceGroups} from '../card-resource-groups.js';
import {
  type ScannedCardData,
  type ScannedCardKeyData,
  isCardKeyItem,
} from '../common.js';

import {AddressTypePicker} from './@address-type-picker.js';
import type {KeyItemState} from './@key-item.js';
import {KeyItem} from './@key-item.js';
import {CardResourceItem, CardResourceList} from './@resource-item.js';

const Description = styled.p`
  margin: 0;
  font-size: 14px;
  line-height: 21px;
  color: var(--color-text-secondary);
`;

export const CardView = observer(
  ({view}: RouteComponentProps<Router['safe']['card']>): ReactNode => {
    const {card} = view;

    return (
      <View>
        {card ? (
          <CardContent key={card.id} card={card} view={view} />
        ) : (
          <>
            <ViewHeader>
              <ViewHeaderTitle>Card</ViewHeaderTitle>
            </ViewHeader>
            <ViewContent />
          </>
        )}
      </View>
    );
  },
);

type CardKeySelection = {
  key: Pick<ScannedCardKeyData, 'type' | 'index' | 'alias'>;
  addressType: AddressType;
  refs: Partial<Record<AddressType, ScannedCardKeyData['ref']>>;
  derivations: WalletKeyPublicKeyData[];
};

function getDerivationRefs(
  derivations: readonly WalletKeyPublicKeyData[],
): CardKeySelection['refs'] {
  const refs: CardKeySelection['refs'] = {};

  for (const wallet of derivations) {
    refs[wallet.addressType] ??= {
      ...wallet,
      address: getWalletData(wallet).address,
    };
  }

  return refs;
}

const CardContent = observer(
  ({
    card,
    view,
  }: {
    card: ScannedCardData;
    view: RouteComponentProps<Router['safe']['card']>['view'];
  }): ReactNode => {
    const {walletStorageService, monoidCredentialsStore, errorService, router} =
      useEntrances();
    const [pinSession] = useState(() =>
      monoidCredentialsStore.createPINSession(),
    );
    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      safe: true,
      auth: 'access',
      retryOnError: true,
      pinSession,
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
            refs: {
              ...getDerivationRefs(item.derivations ?? []),
              ...(item.ref && {[item.ref.addressType]: item.ref}),
            },
            derivations: item.derivations ?? [],
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
    const [importing, setImporting] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [menu, setMenu] = useState<'actions' | 'delete'>();
    const deletion = useRef<AbortController | undefined>(undefined);
    const operationActive = useRef(false);
    const busy = deriving || updatingCard || importing || deleting;
    const mounted = useRef(true);

    useEffect(() => {
      mounted.current = true;

      return () => {
        mounted.current = false;
        deletion.current?.abort();
        pinSession.clear();
      };
    }, [pinSession]);

    useEffect(
      () =>
        reaction(
          () => !!view.$leaving || !view.$match.$exact.$active,
          leaving => {
            if (leaving) {
              pinSession.clear();
              setMenu(undefined);
            }
          },
        ),
      [pinSession, view],
    );

    const {indexToKeyMap} = walletStorageService;

    const keyItems = items.map(item => {
      const ref = item.refs[item.addressType];
      const existingKey = indexToKeyMap.get(item.key.index);
      const state: KeyItemState = existingKey
        ? ref &&
          isWalletKeyUpToDate(
            getCardKeyData(
              {...item.key, ref},
              Object.values(item.refs),
              item.derivations,
            ),
            existingKey,
          )
          ? 'up-to-date'
          : 'outdated'
        : 'new';

      const canWriteAlias =
        existingKey?.alias !== undefined &&
        existingKey.alias !== (item.key.alias ?? '');
      const cardDerivations = card.items.find(
        resource => resource.derivationRecord?.index === item.key.index,
      )?.derivationRecord?.wallets;
      const canWriteDerivations =
        (item.key.type === 'seed' || item.key.type === 'master') &&
        !!existingKey?.wallets.some(
          wallet =>
            !cardDerivations?.some(saved =>
              matchesWalletReference(saved, wallet),
            ),
        );
      const needsMerge =
        !!existingKey &&
        item.derivations.some(
          source =>
            !existingKey.wallets.some(
              saved =>
                matchesWalletReference(saved, source) &&
                saved.publicKey === source.publicKey,
            ),
        );

      return {
        item,
        ref,
        state,
        canWriteAlias,
        canWriteDerivations,
        needsMerge,
        canWrite: !needsMerge && (canWriteAlias || canWriteDerivations),
      };
    });
    const keyItemMap = new Map(
      keyItems.map(keyItem => [keyItem.item.key.index, keyItem]),
    );
    const resourceGroups = getCardResourceGroups(card.items);
    const resources = resourceGroups.map(group => group.item);
    const keyCount = resources.filter(isCardKeyItem).length;
    const visibleItems =
      resourceFilter === 'all' ? resources : resources.filter(isCardKeyItem);

    const [selectedIndexSet] = useState(() => observable.set<SafeIndexHex>());

    const selectedResources = resources.filter(item =>
      selectedIndexSet.has(item.index),
    );
    const selectedGroups = resourceGroups.filter(group =>
      selectedIndexSet.has(group.item.index),
    );
    const attachedCount = selectedGroups.reduce(
      (count, group) => count + group.items.length - 1,
      0,
    );
    const canDelete = selectedGroups.length > 0 && !busy;
    const selectedKeys = keyItems.filter(({item}) =>
      selectedIndexSet.has(item.key.index),
    );
    const hiddenSelectedCount =
      resourceFilter === 'keys'
        ? selectedResources.filter(item => !isCardKeyItem(item)).length
        : 0;
    const missing = selectedKeys.filter(({ref}) => !ref);
    const writableKeys = selectedKeys.some(({needsMerge}) => needsMerge)
      ? []
      : selectedKeys.filter(({canWrite}) => canWrite);
    const canImport =
      selectedResources.length > 0 &&
      selectedKeys.length === selectedResources.length &&
      selectedKeys.every(({ref}) => ref) &&
      selectedKeys.some(({state}) => state !== 'up-to-date');
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
      if (busy || operationActive.current || missing.length === 0) {
        return;
      }

      operationActive.current = true;
      setDeriving(true);
      const derivedRefs = new Map<SafeIndexHex, ScannedCardKeyData['ref']>();

      try {
        await scanPrompt(
          'Scan card to derive',
          async (applet, setStateContent) => {
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
          hello => assertCardForUpdate(hello, card),
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
        operationActive.current = false;
        if (mounted.current) {
          setDeriving(false);
        }
      }
    };

    const writeCardUpdates = async (
      pending: Map<SafeIndexHex, string>,
      pendingDerivations: Map<
        SafeIndexHex,
        {
          key: CardKeySelection['key'];
          wallets: WalletKeyWalletParameters[];
        }
      >,
      onWritten?: (
        index: SafeIndexHex,
        wallets: WalletKeyPublicKeyData[],
      ) => void,
      prompt = 'Scan card to update',
    ): Promise<void> => {
      const total = pending.size + pendingDerivations.size;
      const operation = new AbortController();
      const stopWatching = reaction(
        () => !!view.$leaving || !view.$match.$exact.$active,
        leaving => {
          if (leaving) operation.abort();
        },
        {fireImmediately: true},
      );
      try {
        await scanPrompt(
          prompt,
          async (applet, setStateContent, _hello, signal) => {
            const cancel = (): void => operation.abort();
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();

            const showProgress = (): void => {
              setStateContent(
                <MonoidScanStatePromptProgress
                  current={Math.min(
                    total,
                    total - pending.size - pendingDerivations.size + 1,
                  )}
                  total={total}
                >
                  Updating card
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

              for (const [index, {key, wallets}] of pendingDerivations) {
                const {derivations, ...resource} = await writeCardDerivations(
                  applet,
                  key,
                  wallets,
                  operation.signal,
                );
                pendingDerivations.delete(index);
                onWritten?.(index, derivations);
                runInAction(() => {
                  const resourceIndex = card.items.findIndex(
                    item => item.index === resource.index,
                  );
                  if (resourceIndex === -1) card.items.push(resource);
                  else card.items[resourceIndex] = resource;
                  const keyItem = card.items.find(
                    item => item.index === index,
                  )!;
                  keyItem.derivations = derivations;
                  if (derivations[0]) {
                    keyItem.ref = {
                      ...derivations[0],
                      address: getWalletData(derivations[0]).address,
                    };
                  }
                });
                if (mounted.current && view.card === card) {
                  setItems(current =>
                    current.map(item => {
                      if (item.key.index !== index) return item;

                      const previousRef = item.refs[item.addressType];
                      const displayed =
                        derivations.find(
                          wallet =>
                            previousRef &&
                            matchesWalletReference(wallet, {
                              addressType: previousRef.addressType,
                              seed: previousRef.seed,
                              curve: previousRef.curve,
                              path: previousRef.path,
                            }),
                        ) ??
                        derivations.find(
                          wallet => wallet.addressType === item.addressType,
                        ) ??
                        derivations[0];
                      const refs = getDerivationRefs(derivations);
                      if (displayed) {
                        refs[displayed.addressType] = {
                          ...displayed,
                          address: getWalletData(displayed).address,
                        };
                      }

                      return {
                        ...item,
                        derivations,
                        addressType: displayed?.addressType ?? item.addressType,
                        refs,
                      };
                    }),
                  );
                }
                showProgress();
              }
            } finally {
              signal.removeEventListener('abort', cancel);
            }
          },
          hello => assertCardForUpdate(hello, card),
        );
      } finally {
        stopWatching();
      }
    };

    const updateCard = async (): Promise<void> => {
      if (busy || operationActive.current || writableKeys.length === 0) return;

      operationActive.current = true;
      setUpdatingCard(true);
      setImported(false);

      try {
        await writeCardUpdates(
          new Map(
            writableKeys
              .filter(({canWriteAlias}) => canWriteAlias)
              .map(({item}) => [
                item.key.index,
                indexToKeyMap.get(item.key.index)!.alias!,
              ]),
          ),
          new Map(
            writableKeys
              .filter(({canWriteDerivations}) => canWriteDerivations)
              .map(({item}) => [
                item.key.index,
                {
                  key: item.key,
                  wallets: indexToKeyMap
                    .get(item.key.index)!
                    .wallets.map(getWalletReference),
                },
              ]),
          ),
        );
      } finally {
        operationActive.current = false;
        if (mounted.current) setUpdatingCard(false);
      }
    };

    const importSelected = async (): Promise<void> => {
      if (busy || operationActive.current || !canImport) return;

      const incoming = new Map(
        selectedKeys
          .filter(({state}) => state !== 'up-to-date')
          .map(({item, ref, needsMerge}) => {
            // Merge the recorded card wallets first. An unrecorded address
            // preview can be imported in a subsequent operation.
            const source = needsMerge
              ? {
                  ...item.derivations[0],
                  address: getWalletData(item.derivations[0]).address,
                }
              : ref!;

            return [
              item.key.index,
              getCardKeyData(
                {...item.key, ref: source},
                Object.values(item.refs),
                item.derivations,
              ),
            ];
          }),
      );
      const pendingDerivations = new Map(
        [...incoming].flatMap(([index, key]) => {
          if (key.type !== 'seed' && key.type !== 'master') return [];

          const saved = card.items.find(
            item => item.derivationRecord?.index === index,
          )?.derivationRecord?.wallets;
          if (
            key.wallets.every(wallet =>
              saved?.some(existing => matchesWalletReference(existing, wallet)),
            )
          )
            return [];

          return [
            [
              index,
              {
                key,
                wallets: [
                  ...(indexToKeyMap.get(index)?.wallets ?? []),
                  ...key.wallets,
                ].map(getWalletReference),
              },
            ] as const,
          ];
        }),
      );

      operationActive.current = true;
      setImporting(true);

      try {
        if (pendingDerivations.size) {
          await writeCardUpdates(
            new Map(),
            pendingDerivations,
            (index, wallets) => {
              // Commit each acknowledged write before another scan command can fail.
              importCardKey(walletStorageService, {
                ...incoming.get(index)!,
                wallets,
              });
              incoming.delete(index);
              if (!incoming.size && mounted.current && !view.$leaving) {
                setImported(true);
              }
            },
            'Scan card to import',
          );
        }

        if (!mounted.current || view.$leaving || !view.$match.$exact.$active)
          return;

        runInAction(() => {
          for (const key of incoming.values())
            importCardKey(walletStorageService, key);
        });
        setImported(
          selectedKeys.every(({item, ref}) =>
            isWalletKeyUpToDate(
              getCardKeyData(
                {...item.key, ref: ref!},
                Object.values(item.refs),
                item.derivations,
              ),
              walletStorageService.indexToKeyMap.get(item.key.index)!,
            ),
          ),
        );
      } finally {
        operationActive.current = false;
        if (mounted.current) setImporting(false);
      }
    };

    const deleteSelected = async (): Promise<void> => {
      if (!canDelete || operationActive.current) return;

      operationActive.current = true;
      setDeleting(true);
      setImported(false);
      setMenu(undefined);
      // Remove attached records first, so an interrupted deletion keeps its key.
      const pending = new Set(
        selectedGroups.flatMap(group =>
          [...group.items].reverse().map(item => item.index),
        ),
      );
      const total = pending.size;
      const operation = new AbortController();
      let deletingItems: Promise<void> | undefined;
      deletion.current = operation;
      const stopWatching = reaction(
        () => !!view.$leaving || !view.$match.$exact.$active,
        leaving => {
          if (leaving) operation.abort();
        },
        {fireImmediately: true},
      );

      try {
        await scanPrompt(
          'Scan card to delete',
          async (applet, setStateContent, _hello, signal) => {
            const cancel = (): void => operation.abort();
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();

            const showProgress = (): void => {
              if (operation.signal.aborted) return;

              setStateContent(
                <MonoidScanStatePromptProgress
                  current={Math.min(total, total - pending.size + 1)}
                  total={total}
                >
                  Deleting items
                </MonoidScanStatePromptProgress>,
              );
            };

            try {
              showProgress();
              deletingItems = deleteCardResources(
                applet,
                pending,
                operation.signal,
                index => {
                  const sourceIndex = card.items.find(
                    item => item.index === index,
                  )?.derivationRecord?.index;

                  runInAction(() => {
                    card.items = card.items.filter(
                      item => item.index !== index,
                    );
                    selectedIndexSet.delete(index);
                    const source = card.items.find(
                      item => item.index === sourceIndex,
                    );
                    if (source) source.derivations = [];
                  });

                  if (mounted.current && view.card === card) {
                    setItems(current =>
                      current
                        .filter(item => item.key.index !== index)
                        .map(item =>
                          item.key.index === sourceIndex
                            ? {...item, derivations: []}
                            : item,
                        ),
                    );
                  }
                  showProgress();
                },
              );
              await deletingItems;
            } finally {
              signal.removeEventListener('abort', cancel);
            }
          },
          hello => assertCardForUpdate(hello, card),
        );
      } finally {
        operation.abort();
        // Dismissing the prompt can finish before an in-flight command returns.
        await deletingItems?.catch(() => {});
        stopWatching();
        deletion.current = undefined;
        operationActive.current = false;
        if (mounted.current) setDeleting(false);
      }
    };

    return (
      <>
        <ViewHeader>
          <ViewHeaderTitle>Card</ViewHeaderTitle>
          <ViewHeaderIdentifier identifier={{type: 'card', id: card.id}} />
          {canDelete && (
            <ViewHeaderButton
              aria-label="Card actions"
              aria-haspopup="dialog"
              aria-expanded={!!menu}
              onClick={() => setMenu('actions')}
            >
              <AppIcon icon={ellipsis} />
            </ViewHeaderButton>
          )}
        </ViewHeader>
        <ViewContent
          footer={
            <>
              <ViewActionButton
                visible={deriving || missing.length > 0}
                loading={deriving}
                disabled={updatingCard || importing || deleting}
                onClick={errorService.catch(deriveSelected)}
              >
                Derive
              </ViewActionButton>
              <ViewActionButton
                visible={importing || (imported ? !!backToSafe : canImport)}
                id="import-button"
                color={imported ? 'neutral' : 'primary'}
                loading={importing}
                disabled={busy || (!imported && !canImport)}
                onClick={errorService.catch(async () => {
                  if (imported) {
                    backToSafe?.();
                    return;
                  }

                  await importSelected();
                })}
              >
                {imported ? 'Back to Safe' : updating ? 'Update' : 'Import'}
              </ViewActionButton>
              <ViewActionButton
                visible={updatingCard || writableKeys.length > 0}
                loading={updatingCard}
                disabled={deriving || importing || deleting}
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
          {keyCount < resources.length && (
            <SegmentedControl
              aria-label="Card resources"
              value={resourceFilter}
              options={[
                {value: 'keys', label: `Keys · ${keyCount}`},
                {value: 'all', label: `All · ${resources.length}`},
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
                      resources={card.items}
                      selected={selectedIndexSet.has(resource.index)}
                      disabled={busy}
                      onSelect={selected =>
                        selectItem(resource.index, selected)
                      }
                    />
                  );
                }

                const {item, ref, state, canWrite} = keyItem;
                return (
                  <KeyItem
                    key={item.key.index}
                    data={item.key}
                    addressType={item.addressType}
                    address={ref?.address}
                    path={ref?.path}
                    state={state}
                    canWrite={canWrite}
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
                  let localRef =
                    item.refs[addressType] ??
                    (item.key.type === 'secp256k1' && ordinaryRef
                      ? getLocalCardKeyAddress(ordinaryRef, addressType)
                      : undefined);

                  if (
                    !localRef &&
                    (item.key.type === 'seed' || item.key.type === 'master')
                  ) {
                    const options = ADDRESS_TYPES[addressType];
                    const wallet = getLocalCardWalletDerivation(
                      [
                        ...item.derivations,
                        ...Object.values(item.refs).map(
                          ({addressType, seed, curve, path, publicKey}) => ({
                            addressType,
                            seed,
                            curve,
                            path,
                            publicKey,
                          }),
                        ),
                        ...(indexToKeyMap.get(item.key.index)?.wallets ?? []),
                      ],
                      {
                        addressType,
                        seed:
                          item.key.type === 'seed' ? options.seed : undefined,
                        curve: options.curve,
                        path: options.path(0),
                      },
                    );
                    if (wallet) {
                      localRef = {
                        ...wallet,
                        address: getWalletData(wallet).address,
                      };
                    }
                  }

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
        {menu && canDelete && view.$match.$exact.$active && !view.$leaving && (
          <CenteredPopup
            aria-label={menu === 'delete' ? 'Delete items' : 'Card actions'}
            contentKey={menu}
            initialFocus={menu === 'delete' ? 'dialog' : 'control'}
            onDismiss={() => setMenu(undefined)}
          >
            {menu === 'delete' ? (
              <>
                <DetailsPopupTitle>Delete items?</DetailsPopupTitle>
                <Description>
                  Delete {selectedResources.length}{' '}
                  {selectedResources.length === 1 ? 'item' : 'items'}
                  {attachedCount > 0 &&
                    ` and ${attachedCount} attached ${attachedCount === 1 ? 'record' : 'records'}`}{' '}
                  from this card. This cannot be undone. Records on this phone
                  will remain.
                </Description>
                <Buttons data-popup-animation-group>
                  <Button
                    color="danger"
                    onClick={errorService.catch(deleteSelected)}
                  >
                    Delete
                  </Button>
                  <Button color="neutral" onClick={() => setMenu(undefined)}>
                    Cancel
                  </Button>
                </Buttons>
              </>
            ) : (
              <>
                <DetailsPopupTitle>
                  Selected items · {selectedResources.length}
                </DetailsPopupTitle>
                <Button color="danger" onClick={() => setMenu('delete')}>
                  Delete
                </Button>
              </>
            )}
          </CenteredPopup>
        )}
        {scanPromptContent}
      </>
    );
  },
);
