import {Ellipsis as ellipsis} from 'lucide-react';
import {observable, reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {type SafeIndexHex, SafeKnownType} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {MonoidApplet} from '../../../../@lib/monoid/index.js';
import {
  ADDRESS_TYPES,
  type AddressChain,
  type AddressType,
} from '../../../../@lib/wallet-address.js';
import type {Router} from '../../../../@routes.js';
import {
  type CardItem,
  type CardState,
  type WalletKeyPublicKeyData,
  type WalletKeyWalletParameters,
  assertWalletPublicKeys,
  getWalletData,
  getWalletReference,
  matchesWalletReference,
} from '../../../../@services/index.js';
import {createFlowId} from '../../../../@utils/index.js';
import {ADDRESS_CHAIN_OPTIONS} from '../../../@key/address-type-selector.js';
import {KeyListPlaceholder} from '../../../@key/key-list.js';
import {keyTypeColorsCSS} from '../../../@key/key-tags.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {PINKind} from '../../../@monoid/pin-input-placeholder.js';
import {AppIcon} from '../../../@ui/app-icon.js';
import {Button, Buttons} from '../../../@ui/button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../../@ui/details-popup.js';
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
  useViewActive,
} from '../../../@view/index.js';
import {CardAddressProgress} from '../card-address-progress.js';
import {
  getCardKeyAddressTypes,
  getLocalCardKeyAddress,
  getLocalCardWalletDerivation,
  readCardKeyAddress,
  readCardWalletDerivations,
} from '../card-address.js';
import {assertCardForUpdate, writeCardAliases} from '../card-alias-update.js';
import {writeCardDerivations} from '../card-derivations.js';
import {
  CARD_KEY_TYPES,
  type CardKeyType,
  createCardKey,
} from '../card-key-create.js';
import {
  getCardKeyData,
  importCardKey,
  isWalletKeyUpToDate,
} from '../card-key-import.js';
import type {CardPINKind} from '../card-pin-update.js';
import {deleteCardResources} from '../card-resource-delete.js';
import {getCardResourceGroups} from '../card-resource-groups.js';
import {type ScannedCardKeyData, isCardKeyItem} from '../common.js';

import {AddressTypePicker} from './@address-type-picker.js';
import type {KeyItemState, KeySyncDirection} from './@key-item.js';
import {KeyItem} from './@key-item.js';
import {CardResourceItem, CardResourceList} from './@resource-item.js';
import {CardPINUpdate} from './card-pin-update.js';

const Description = styled.p`
  margin: 0;
  font-size: 14px;
  line-height: 21px;
  color: var(--color-text-secondary);
`;

const CreateKeyButton = styled(Button)`
  ${keyTypeColorsCSS}

  &.seed {
    color: white;
    border-color: var(--color-seed-light);
    background-color: color-mix(
      in srgb,
      var(--color-seed-light) 20%,
      transparent
    );
  }
`;

export const CardView = observer(
  ({view}: RouteComponentProps<Router['safe']['card']>): ReactNode => {
    const {cardStore, router} = useEntrances();
    const card = view.card && cardStore.get(view.card);

    return (
      <View>
        {card ? (
          <CardContent
            key={`${card.id}:${card.publicKey}`}
            card={card}
            view={view}
          />
        ) : (
          <>
            <ViewHeader>
              <ViewHeaderTitle>Card</ViewHeaderTitle>
            </ViewHeader>
            <ViewContent
              footer={
                <ViewActionButton
                  visible
                  onClick={() => router.safe.scanCard.$replace()}
                >
                  Scan card
                </ViewActionButton>
              }
            >
              <ViewPlaceholder>Scan card to view items</ViewPlaceholder>
            </ViewContent>
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

function getCardKeySelection(item: CardItem): CardKeySelection | undefined {
  if (typeof item.type !== 'string') return;

  const addressType = item.addressType ?? getCardKeyAddressTypes(item.type)[0];
  if (!addressType) return;

  return {
    key: {
      type: SafeKnownType.satisfies(item.type),
      index: item.index,
      alias: item.alias,
    },
    addressType,
    refs: item.refs,
    derivations: item.derivations ?? [],
  };
}

const CardContent = observer(
  ({
    card,
    view,
  }: {
    card: CardState;
    view: RouteComponentProps<Router['safe']['card']>['view'];
  }): ReactNode => {
    const {walletStorageService, monoidCredentialsStore, errorService, router} =
      useEntrances();
    const isViewActive = useViewActive(view);
    const [pinSession] = useState(() =>
      monoidCredentialsStore.createPINSession(),
    );
    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      allowSetup: true,
      auth: 'access',
      retryOnError: true,
      pinSession,
    });
    const [createScanContent, createScan] = useMonoidScanPrompt({
      allowSetup: true,
      auth: 'access',
      retryOnError: false,
      pinSession,
    });
    const items = card.items.flatMap(item => {
      const selection = getCardKeySelection(item);
      return selection ? [selection] : [];
    });
    const [resourceFilter, setResourceFilter] = useState<'keys' | 'all'>(
      'keys',
    );
    const [editingIndex, setEditingIndex] = useState<SafeIndexHex>();
    const [deriving, setDeriving] = useState(false);
    const [updatingCard, setUpdatingCard] = useState(false);
    const [importing, setImporting] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [creating, setCreating] = useState(false);
    const [createKeyChain, setCreateKeyChain] = useState<AddressChain>();
    const [updatingPIN, setUpdatingPIN] = useState<CardPINKind>();
    const [menu, setMenu] = useState<'actions' | 'delete' | 'create'>();
    const [syncChoices] = useState(() =>
      observable.map<
        SafeIndexHex,
        {
          direction: KeySyncDirection;
          expected: WalletKeyWalletParameters[] | undefined;
        }
      >(),
    );
    const [previewIndexes] = useState(() => observable.set<SafeIndexHex>());
    const deletion = useRef<AbortController | undefined>(undefined);
    const creation = useRef<AbortController | undefined>(undefined);
    const operationActive = useRef(false);
    const busy =
      deriving ||
      updatingCard ||
      importing ||
      deleting ||
      creating ||
      !!updatingPIN;
    const mounted = useRef(true);

    useEffect(() => {
      mounted.current = true;

      return () => {
        mounted.current = false;
        deletion.current?.abort();
        creation.current?.abort();
        pinSession.clear();
      };
    }, [pinSession]);

    useEffect(
      () =>
        reaction(
          () => !isViewActive(),
          leaving => {
            if (leaving) {
              pinSession.clear();
              setMenu(undefined);
            }
          },
        ),
      [pinSession, isViewActive],
    );

    useEffect(
      () =>
        reaction(
          () => card.items,
          () => {
            syncChoices.clear();
            previewIndexes.clear();
          },
        ),
      [card, syncChoices, previewIndexes],
    );

    const {indexToKeyMap} = walletStorageService;

    const getSafeAddress = (
      key: CardKeySelection['key'],
      addressType: AddressType,
    ): ScannedCardKeyData['ref'] | undefined => {
      const local = indexToKeyMap.get(key.index);
      if (local?.type !== key.type) return;
      const wallets = local.wallets.filter(
        wallet => wallet.addressType === addressType,
      );
      const wallet =
        wallets.find(
          wallet =>
            local.defaultWallet &&
            matchesWalletReference(wallet, local.defaultWallet),
        ) ?? wallets[0];
      return wallet && {...wallet, address: getWalletData(wallet).address};
    };

    const keyItems = items.map(item => {
      const ref =
        item.refs[item.addressType] ??
        getSafeAddress(item.key, item.addressType);
      const existingKey = indexToKeyMap.get(item.key.index);
      const cardDerivations = card.items.find(
        resource => resource.derivationRecord?.index === item.key.index,
      )?.derivationRecord?.wallets;
      const recorded = cardDerivations !== undefined;
      const knownWallets = [
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
        ...(existingKey?.type === item.key.type ? existingKey.wallets : []),
      ];
      const recordedWallets = (cardDerivations ?? []).flatMap(parameters => {
        const wallet = getLocalCardWalletDerivation(knownWallets, parameters);
        return wallet ? [wallet] : [];
      });
      const empty =
        recorded &&
        !cardDerivations.length &&
        !previewIndexes.has(item.key.index);
      const source = {...item.key, alias: item.key.alias ?? ''};
      const recordData = getCardKeyData(source, recordedWallets);
      const needsRecordDownload =
        recorded &&
        (!existingKey ||
          !isWalletKeyUpToDate(recordData, existingKey) ||
          cardDerivations.some(
            parameters =>
              !existingKey.wallets.some(wallet =>
                matchesWalletReference(wallet, parameters),
              ),
          ));
      // A row represents its recorded list first. Only a later, separate
      // import can add an unrecorded address currently being previewed.
      const previewData =
        !empty && ref ? getCardKeyData({...source, ref}) : undefined;
      const incoming = needsRecordDownload
        ? recordData
        : (previewData ?? (recorded ? recordData : undefined));
      const canDownload =
        needsRecordDownload ||
        (!!incoming &&
          (!existingKey || !isWalletKeyUpToDate(incoming, existingKey)));
      const state: KeyItemState = !existingKey
        ? 'new'
        : canDownload
          ? 'outdated'
          : 'up-to-date';
      const canWriteAlias =
        !!existingKey && (existingKey.alias ?? '') !== (item.key.alias ?? '');
      const canWriteDerivations =
        !!existingKey &&
        (cardDerivations === undefined ||
          cardDerivations.length !== existingKey.wallets.length ||
          existingKey.wallets.some(
            wallet =>
              !cardDerivations.some(saved =>
                matchesWalletReference(saved, wallet),
              ),
          ));
      const canUpload = canWriteAlias || canWriteDerivations;
      const choice = syncChoices.get(item.key.index);
      const direction: KeySyncDirection | undefined =
        choice && (choice.direction === 'download' ? canDownload : canUpload)
          ? choice.direction
          : canDownload
            ? 'download'
            : canUpload
              ? 'upload'
              : undefined;
      return {
        item,
        ref,
        state,
        incoming,
        cardDerivations,
        needsRecordDownload,
        empty,
        direction,
        canDownload,
        canWriteAlias,
        canWriteDerivations,
        canWrite: direction === 'upload',
        canToggleDirection: canDownload && canUpload,
        expected:
          choice?.direction === 'upload'
            ? choice.expected
            : cardDerivations?.map(getWalletReference),
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
    const missingPreviews = keyItems.filter(({ref, empty}) => !ref && !empty);
    const missing = selectedKeys.filter(
      ({ref, empty, needsRecordDownload, direction}) =>
        !ref && !empty && !needsRecordDownload && direction !== 'upload',
    );
    const writableKeys = selectedKeys.filter(({canWrite}) => canWrite);
    const downloadableKeys = selectedKeys.filter(
      ({direction, canDownload}) => direction === 'download' && canDownload,
    );
    const canImport =
      selectedKeys.length === selectedResources.length &&
      downloadableKeys.length > 0 &&
      missing.length === 0;
    const updating =
      downloadableKeys.length > 0 &&
      downloadableKeys.every(({state}) => state !== 'new');
    const editing = items.find(item => item.key.index === editingIndex);

    const [imported, setImported] = useState(false);
    const importComplete = imported && !canImport;
    const backToSafe = router.$backTo(router.safe.$exact);

    const selectItem = (index: SafeIndexHex, selected: boolean): void => {
      runInAction(() => {
        if (selected) selectedIndexSet.add(index);
        else selectedIndexSet.delete(index);
      });
      setImported(false);
    };

    const createKey = async (type: CardKeyType): Promise<void> => {
      if (busy || operationActive.current) return;

      operationActive.current = true;
      setCreating(true);
      setImported(false);
      setMenu(undefined);
      const operation = new AbortController();
      creation.current = operation;
      let writing: Promise<void> | undefined;
      let createdIndex: SafeIndexHex | undefined;
      const stopWatching = reaction(
        () => !isViewActive(),
        leaving => {
          if (leaving) operation.abort();
        },
        {fireImmediately: true},
      );

      try {
        await createScan(
          'Scan card to create key',
          async (applet, setStateContent, _hello, signal) => {
            const cancel = (): void => operation.abort();
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();

            try {
              setStateContent('Creating key, hold tight...');
              // Retain the command even if the callback is entered again.
              writing ??= createCardKey(
                applet,
                type,
                operation.signal,
                item => {
                  card.upsert(item);
                  createdIndex = item.index;
                  if (!operation.signal.aborted)
                    setStateContent('Reading key, hold tight...');
                },
                getCardKeyAddressTypes(type).find(
                  addressType =>
                    !createKeyChain ||
                    ADDRESS_TYPES[addressType].chain === createKeyChain,
                ),
              );
              await writing;
            } finally {
              signal.removeEventListener('abort', cancel);
            }
          },
          hello => assertCardForUpdate(hello, card),
        );

        if (createdIndex && mounted.current && !operation.signal.aborted) {
          selectItem(createdIndex, true);
        }
      } finally {
        operation.abort();
        // Preserve acknowledged creation when scan dismissal wins the race.
        await writing?.catch(() => {});
        stopWatching();
        creation.current = undefined;
        operationActive.current = false;
        if (mounted.current) setCreating(false);
      }
    };

    const deriveMissingPreviews = async (): Promise<void> => {
      if (busy || operationActive.current || missingPreviews.length === 0) {
        return;
      }

      operationActive.current = true;
      setDeriving(true);
      const derivedRefs = new Map<SafeIndexHex, ScannedCardKeyData['ref']>();

      try {
        await scanPrompt(
          'Scan card to derive',
          async (applet, setStateContent, _hello, signal) => {
            const showProgress = (current: number): void => {
              if (signal.aborted || !mounted.current || !isViewActive()) return;
              setStateContent(
                <MonoidScanStatePromptProgress
                  current={current}
                  total={missingPreviews.length}
                >
                  Deriving addresses
                </MonoidScanStatePromptProgress>,
              );
            };
            showProgress(0);
            for (const [index, {item}] of missingPreviews.entries()) {
              if (signal.aborted || !mounted.current || !isViewActive()) return;
              derivedRefs.set(
                item.key.index,
                await readCardKeyAddress(applet, item.key, item.addressType),
              );
              showProgress(index + 1);
            }
          },
          hello => assertCardForUpdate(hello, card),
        );

        if (mounted.current && isViewActive()) {
          runInAction(() => {
            for (const item of card.items) {
              const ref = derivedRefs.get(item.index);
              if (ref) item.ref = ref;
            }
          });
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
          options?: {
            mode: 'replace';
            expected: readonly WalletKeyWalletParameters[] | undefined;
          };
        }
      >,
      onWritten?: (
        index: SafeIndexHex,
        wallets: WalletKeyPublicKeyData[],
      ) => void,
      prompt = 'Scan card to update',
      beforeWriting?: (
        applet: MonoidApplet,
        setStateContent: (content: ReactNode) => void,
        signal: AbortSignal,
      ) => Promise<void>,
    ): Promise<void> => {
      const total = pending.size + pendingDerivations.size;
      const operation = new AbortController();
      let writing: Promise<void> | undefined;
      const stopWatching = reaction(
        () => !isViewActive(),
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
              if (operation.signal.aborted || !mounted.current) return;
              setStateContent(
                <MonoidScanStatePromptProgress
                  current={total - pending.size - pendingDerivations.size}
                  total={total}
                >
                  Updating card
                </MonoidScanStatePromptProgress>,
              );
            };

            try {
              writing = (async () => {
                if (beforeWriting)
                  await beforeWriting(
                    applet,
                    setStateContent,
                    operation.signal,
                  );
                operation.signal.throwIfAborted();
                if (total > 0) showProgress();
                for (const [
                  index,
                  {key, wallets, options},
                ] of pendingDerivations) {
                  const item = card.items.find(item => item.index === index)!;
                  const {derivations, ...resource} = await writeCardDerivations(
                    applet,
                    key,
                    wallets,
                    operation.signal,
                    options,
                    progress => {
                      if (operation.signal.aborted || !mounted.current) return;
                      if (progress.stage === 'writing') showProgress();
                      else
                        setStateContent(
                          <CardAddressProgress progress={progress} />,
                        );
                    },
                    [
                      ...(item.derivations ?? []),
                      ...Object.values(item.refs).map(
                        ({addressType, seed, curve, path, publicKey}) => ({
                          addressType,
                          seed,
                          curve,
                          path,
                          publicKey,
                        }),
                      ),
                      ...(indexToKeyMap.get(index)?.wallets ?? []),
                    ],
                  );
                  pendingDerivations.delete(index);
                  runInAction(() => {
                    card.upsert(resource);
                    item.setRecordedWallets(derivations);
                  });
                  onWritten?.(index, derivations);
                  showProgress();
                }
                await writeCardAliases(
                  applet,
                  pending,
                  operation.signal,
                  (index, alias) => {
                    runInAction(() => {
                      card.items.find(item => item.index === index)!.alias =
                        alias;
                    });

                    showProgress();
                  },
                );
              })();
              await writing;
            } finally {
              signal.removeEventListener('abort', cancel);
            }
          },
          hello => assertCardForUpdate(hello, card),
        );
      } finally {
        operation.abort();
        await writing?.catch(() => {});
        stopWatching();
      }
    };

    const updateCard = async (): Promise<void> => {
      if (busy || operationActive.current || writableKeys.length === 0) return;

      for (const {item} of writableKeys) {
        assertWalletPublicKeys([
          ...indexToKeyMap.get(item.key.index)!.wallets,
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
        ]);
      }

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
                indexToKeyMap.get(item.key.index)!.alias ?? '',
              ]),
          ),
          new Map(
            writableKeys
              .filter(({canWriteDerivations}) => canWriteDerivations)
              .map(({item, expected}) => [
                item.key.index,
                {
                  key: item.key,
                  wallets: indexToKeyMap
                    .get(item.key.index)!
                    .wallets.map(getWalletReference),
                  options: {mode: 'replace', expected},
                },
              ]),
          ),
        );
        runInAction(() => {
          for (const {item} of writableKeys) {
            syncChoices.delete(item.key.index);
            previewIndexes.delete(item.key.index);
          }
        });
      } finally {
        operationActive.current = false;
        if (mounted.current) setUpdatingCard(false);
      }
    };

    const importSelected = async (): Promise<void> => {
      if (busy || operationActive.current || !canImport) return;

      const incoming = new Map(
        downloadableKeys.map(({item, incoming}) => [item.key.index, incoming!]),
      );
      const unreadRecords = downloadableKeys.filter(
        ({item, cardDerivations, needsRecordDownload}) =>
          needsRecordDownload &&
          cardDerivations!.some(
            parameters =>
              !incoming
                .get(item.key.index)!
                .wallets.some(wallet =>
                  matchesWalletReference(wallet, parameters),
                ),
          ),
      );
      const pendingDerivations = new Map(
        [...incoming].flatMap(([index, key]) => {
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
                wallets: key.wallets.map(getWalletReference),
              },
            ] as const,
          ];
        }),
      );

      operationActive.current = true;
      setImporting(true);

      try {
        if (pendingDerivations.size || unreadRecords.length) {
          await writeCardUpdates(
            new Map(),
            pendingDerivations,
            (index, wallets) => {
              // Commit each acknowledged write before another scan command can fail.
              const selected = incoming.get(index)!;
              importCardKey(walletStorageService, {
                ...selected,
                wallets: wallets.filter(wallet =>
                  selected.wallets.some(source =>
                    matchesWalletReference(source, wallet),
                  ),
                ),
              });
              incoming.delete(index);
              runInAction(() => syncChoices.delete(index));
              if (!incoming.size && mounted.current && isViewActive()) {
                setImported(true);
              }
            },
            'Scan card to import',
            unreadRecords.length
              ? async (applet, setStateContent, signal) => {
                  const total = unreadRecords.reduce(
                    (count, entry) => count + entry.cardDerivations!.length,
                    0,
                  );
                  let completed = 0;
                  const showProgress = (current: number): void => {
                    if (signal.aborted || !mounted.current || !isViewActive())
                      return;
                    setStateContent(
                      <MonoidScanStatePromptProgress
                        current={current}
                        total={total}
                      >
                        Reading addresses
                      </MonoidScanStatePromptProgress>,
                    );
                  };
                  showProgress(0);
                  for (const {item, cardDerivations} of unreadRecords) {
                    signal.throwIfAborted();
                    const selected = incoming.get(item.key.index)!;
                    const wallets = await readCardWalletDerivations(
                      applet,
                      item.key,
                      cardDerivations!,
                      signal,
                      current => showProgress(completed + current),
                      selected.wallets,
                    );
                    signal.throwIfAborted();
                    incoming.set(
                      item.key.index,
                      getCardKeyData(
                        {...item.key, alias: item.key.alias ?? ''},
                        wallets,
                      ),
                    );
                    runInAction(() => {
                      card.items.find(
                        resource => resource.index === item.key.index,
                      )!.derivations = wallets;
                    });
                    completed += cardDerivations!.length;
                  }
                }
              : undefined,
          );
        }

        if (!mounted.current || !isViewActive()) return;

        runInAction(() => {
          for (const key of incoming.values()) {
            importCardKey(walletStorageService, key);
            syncChoices.delete(key.index);
          }
        });
        setImported(
          downloadableKeys.every(({item, ref, empty}) => {
            const existing = walletStorageService.indexToKeyMap.get(
              item.key.index,
            )!;
            return (
              (!ref ||
                empty ||
                isWalletKeyUpToDate(
                  getCardKeyData({
                    ...item.key,
                    alias: item.key.alias ?? '',
                    ref,
                  }),
                  existing,
                )) &&
              isWalletKeyUpToDate(
                getCardKeyData(
                  {...item.key, alias: item.key.alias ?? ''},
                  item.derivations,
                ),
                existing,
              )
            );
          }),
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
        () => !isViewActive(),
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
                  current={total - pending.size}
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
          <ViewHeaderButton
            aria-label="Card actions"
            aria-haspopup="dialog"
            aria-expanded={!!menu}
            disabled={busy}
            onClick={() => setMenu('actions')}
          >
            <AppIcon icon={ellipsis} />
          </ViewHeaderButton>
        </ViewHeader>
        <ViewContent
          footer={
            <>
              <ViewActionButton
                visible={deriving || missingPreviews.length > 0}
                loading={deriving}
                disabled={
                  updatingCard ||
                  importing ||
                  deleting ||
                  creating ||
                  !!updatingPIN
                }
                onClick={errorService.catch(deriveMissingPreviews)}
              >
                Derive
              </ViewActionButton>
              <ViewActionButton
                visible={
                  importing || (importComplete ? !!backToSafe : canImport)
                }
                id="import-button"
                color={importComplete ? 'neutral' : 'primary'}
                loading={importing}
                disabled={busy || (!importComplete && !canImport)}
                onClick={errorService.catch(async () => {
                  if (importComplete) {
                    backToSafe?.();
                    return;
                  }

                  await importSelected();
                })}
              >
                {importComplete
                  ? 'Back to Safe'
                  : updating
                    ? 'Update'
                    : 'Import'}
              </ViewActionButton>
              <ViewActionButton
                visible={updatingCard || writableKeys.length > 0}
                loading={updatingCard}
                disabled={
                  deriving || importing || deleting || creating || !!updatingPIN
                }
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
                      copyId: createFlowId(),
                      sourceCard: card.snapshot(),
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

                const {
                  item,
                  ref,
                  state,
                  canWrite,
                  empty,
                  direction,
                  canToggleDirection,
                  cardDerivations,
                } = keyItem;
                return (
                  <KeyItem
                    key={item.key.index}
                    data={item.key}
                    addressType={item.addressType}
                    address={ref?.address}
                    path={ref?.path}
                    state={state}
                    canWrite={canWrite}
                    empty={empty}
                    syncDirection={direction}
                    onChangeSyncDirection={
                      canToggleDirection
                        ? () => {
                            if (busy) return;
                            runInAction(() => {
                              syncChoices.set(item.key.index, {
                                direction:
                                  direction === 'upload'
                                    ? 'download'
                                    : 'upload',
                                expected:
                                  cardDerivations?.map(getWalletReference),
                              });
                            });
                            setImported(false);
                          }
                        : undefined
                    }
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
              runInAction(() => {
                previewIndexes.add(editing.key.index);
                syncChoices.delete(editing.key.index);
                const item = card.items.find(
                  item => item.index === editing.key.index,
                )!;
                const ordinaryRef =
                  item.refs.evm ?? item.refs['bitcoin-segwit'];
                let localRef =
                  getSafeAddress(editing.key, addressType) ??
                  item.refs[addressType] ??
                  (item.type === 'secp256k1' && ordinaryRef
                    ? getLocalCardKeyAddress(ordinaryRef, addressType)
                    : undefined);

                if (!localRef && item.type === 'seed') {
                  const options = ADDRESS_TYPES[addressType];
                  const wallet = getLocalCardWalletDerivation(
                    [
                      ...(item.derivations ?? []),
                      ...Object.values(item.refs).map(
                        ({addressType, seed, curve, path, publicKey}) => ({
                          addressType,
                          seed,
                          curve,
                          path,
                          publicKey,
                        }),
                      ),
                      ...(indexToKeyMap.get(item.index)?.wallets ?? []),
                    ],
                    {
                      addressType,
                      seed: options.seed,
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

                item.addressType = addressType;
                if (localRef) item.refs[addressType] = localRef;
              });
              setImported(false);
              setEditingIndex(undefined);
            }}
          />
        )}
        {menu && !busy && isViewActive() && (
          <DetailsPopup
            aria-label={
              menu === 'delete'
                ? 'Delete items'
                : menu === 'create'
                  ? 'Create key'
                  : 'Card actions'
            }
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
            ) : menu === 'create' ? (
              <>
                <DetailsPopupTitle>Create key</DetailsPopupTitle>
                <DetailsPopupDivider />
                <SegmentedControl<AddressChain>
                  aria-label="Key network"
                  allowDeselect
                  value={createKeyChain}
                  options={ADDRESS_CHAIN_OPTIONS}
                  onChange={setCreateKeyChain}
                />
                <Buttons data-popup-animation-group>
                  {CARD_KEY_TYPES.filter(
                    type =>
                      !createKeyChain ||
                      getCardKeyAddressTypes(type).some(
                        addressType =>
                          ADDRESS_TYPES[addressType].chain === createKeyChain,
                      ),
                  ).map(type => (
                    <CreateKeyButton
                      key={type}
                      className={type}
                      color="neutral"
                      aria-label={type}
                      onClick={errorService.catch(() => createKey(type))}
                    >
                      {type}
                    </CreateKeyButton>
                  ))}
                </Buttons>
              </>
            ) : (
              <>
                {canDelete && (
                  <DetailsPopupTitle>
                    Selected items · {selectedResources.length}
                  </DetailsPopupTitle>
                )}
                <Buttons data-popup-animation-group>
                  <Button
                    color="primary"
                    onClick={() => {
                      setCreateKeyChain(undefined);
                      setMenu('create');
                    }}
                  >
                    Create key
                  </Button>
                  {!canDelete && (
                    <Button
                      color="neutral"
                      onClick={() => {
                        setMenu(undefined);
                        router.safe
                          .syncCards({
                            card: {id: card.id, publicKey: card.publicKey},
                          })
                          .$push();
                      }}
                    >
                      Sync cards
                    </Button>
                  )}
                  {!canDelete && (
                    <Button
                      color="neutral"
                      onClick={() => {
                        setMenu(undefined);
                        router.safe
                          .setupCard({
                            card: {id: card.id, publicKey: card.publicKey},
                            createBundle: true,
                          })
                          .$push();
                      }}
                    >
                      Setup card bundle
                    </Button>
                  )}
                  {canDelete ? (
                    <Button color="danger" onClick={() => setMenu('delete')}>
                      Delete
                    </Button>
                  ) : (
                    (['Access', 'Secret'] as const).map(kind => (
                      <Button
                        key={kind}
                        color="neutral"
                        onClick={() => {
                          if (operationActive.current) return;
                          operationActive.current = true;
                          setMenu(undefined);
                          setUpdatingPIN(kind);
                        }}
                      >
                        <span>
                          Update{' '}
                          {kind === 'Secret' ? <PINKind kind={kind} /> : kind}{' '}
                          PIN
                        </span>
                      </Button>
                    ))
                  )}
                </Buttons>
              </>
            )}
          </DetailsPopup>
        )}
        {updatingPIN && (
          <CardPINUpdate
            card={card}
            kind={updatingPIN}
            pinSession={pinSession}
            view={view}
            onFinished={() => {
              operationActive.current = false;
              if (mounted.current) setUpdatingPIN(undefined);
            }}
          />
        )}
        {scanPromptContent}
        {createScanContent}
      </>
    );
  },
);
