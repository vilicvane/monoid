import {Clipboard} from '@capacitor/clipboard';
import {useIonAlert} from '@ionic/react';
import {Copy as copy, Star as star, Trash2 as trash} from 'lucide-react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {RouteContext} from 'routra-react';
import {styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {useEntrances} from '../../@entrances.js';
import {UI_LOCALE} from '../../@lib/locale.js';
import type {AddressChain} from '../../@lib/wallet-address.js';
import {ADDRESS_TYPES, ADDRESS_TYPE_LABELS} from '../../@lib/wallet-address.js';
import type {
  WalletKeyData,
  WalletKeyWalletData,
} from '../../@services/index.js';
import {
  getDefaultWallet,
  getKeyWallets,
  getWalletReference,
} from '../../@services/index.js';
import {AppIcon} from '../@ui/app-icon.js';
import {SwipeAction, SwipeableItem} from '../@ui/swipeable-item.js';

import {
  ExpandableKeyGroup,
  KeyGroupItem,
  keyGroupReveal,
} from './expandable-key-group.js';
import {
  KeyList,
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
  KeyListPlaceholder,
} from './key-list.js';
import {KeyDerivationBadge, KeyDerivationTag, KeyTags} from './key-tags.js';
import {ReceiveAddressPopup} from './receive-address-popup.js';

const pathCollator = new Intl.Collator(UI_LOCALE, {numeric: true});

const CHAIN_LABELS: Record<AddressChain, string> = {
  evm: 'EVM',
  solana: 'Solana',
  bitcoin: 'BTC',
};

const WalletRow = styled(SwipeableItem)<{$revealing?: boolean}>`
  ${keyGroupReveal}
`;

const WalletItem = styled(KeyGroupItem)`
  cursor: pointer;
`;

const WalletAddress = styled(KeyListAddress)`
  &:focus-visible {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: 2px;
  }
`;

const WalletPath = styled(KeyDerivationTag)`
  flex-shrink: 1;
  min-width: 0;

  &[type='button'] {
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid var(--ion-color-primary);
      outline-offset: 2px;
    }
  }
`;

export const KeyWalletList = observer(
  ({
    data,
    defaultExpandedChain,
    emptyFocusRef,
  }: {
    data: WalletKeyData;
    defaultExpandedChain?: AddressChain;
    emptyFocusRef?: RefObject<HTMLDivElement | null>;
  }): ReactNode => {
    const {walletStorageService, errorService} = useEntrances();
    const {view} = useContext(RouteContext);
    const active = !view.$leaving && view.$match.$exact.$active;
    const [presentAlert] = useIonAlert();
    const [openWallet, setOpenWallet] = useState<string>();
    const [receiveWallet, setReceiveWallet] = useState<WalletKeyWalletData>();
    const listRef = useRef<HTMLDivElement>(null);
    const derivable = data.type === 'seed' || data.type === 'master';
    const availableWallets = getKeyWallets(data);
    const wallets = derivable
      ? availableWallets
          .slice()
          .sort((a, b) => pathCollator.compare(a.path ?? '', b.path ?? ''))
      : availableWallets;
    const defaultWallet = getDefaultWallet(data, availableWallets);
    const groups = new Map<AddressChain, WalletKeyWalletData[]>();

    useEffect(() => {
      setReceiveWallet(undefined);
    }, [active, data.index]);

    for (const wallet of wallets) {
      const chain = ADDRESS_TYPES[wallet.addressType].chain;
      const group = groups.get(chain);

      if (group) {
        group.push(wallet);
      } else {
        groups.set(chain, [wallet]);
      }
    }

    return (
      <KeyList ref={listRef}>
        {Array.from(groups, ([chain, group]) => {
          const representative =
            group.find(wallet => wallet === defaultWallet) ?? group[0];

          return (
            <ExpandableKeyGroup
              key={`${data.index}:${chain}`}
              focusSelector=".key-group-primary"
              autoExpand={groups.size === 1 || chain === defaultExpandedChain}
            >
              {({expanded, collapsing, revealing, expand, collapse}) => {
                const collapsed = group.length > 1 && !expanded;

                return (collapsed ? [representative] : group).map(wallet => {
                  const id = JSON.stringify(getWalletReference(wallet));
                  const isDefault = wallet === defaultWallet;
                  const collapsedRow =
                    group.length > 1 &&
                    (collapsed || collapsing) &&
                    wallet === representative;

                  return (
                    <WalletRow
                      key={id}
                      className={
                        wallet === representative
                          ? 'key-group-primary'
                          : undefined
                      }
                      $revealing={revealing && wallet !== representative}
                      disabled={collapsed || collapsing}
                      open={openWallet === id}
                      onOpenChange={open =>
                        setOpenWallet(open ? id : undefined)
                      }
                      actions={
                        <>
                          <SwipeAction
                            type="button"
                            onClick={errorService.catch(async () => {
                              await Clipboard.write({string: wallet.address});
                              setOpenWallet(current =>
                                current === id ? undefined : current,
                              );
                            })}
                          >
                            <AppIcon icon={copy} aria-hidden="true" />
                            Copy
                          </SwipeAction>
                          {!isDefault && (
                            <SwipeAction
                              type="button"
                              $color="var(--color-derivations-badge)"
                              onClick={event => {
                                event.currentTarget
                                  .closest<HTMLElement>('[role="group"]')
                                  ?.focus({preventScroll: true});

                                runInAction(() => {
                                  data.defaultWallet =
                                    getWalletReference(wallet);
                                });

                                setOpenWallet(undefined);
                              }}
                            >
                              <AppIcon icon={star} aria-hidden="true" />
                              Default
                            </SwipeAction>
                          )}
                          <SwipeAction
                            type="button"
                            $color="var(--ion-color-danger)"
                            onClick={errorService.catch(
                              async (event: MouseEvent<HTMLButtonElement>) => {
                                const row =
                                  event.currentTarget.closest<HTMLElement>(
                                    '[role="group"]',
                                  );

                                await presentAlert({
                                  header: 'Delete address?',
                                  subHeader: wallet.address,
                                  message:
                                    'Remove this saved address from this device? You can import it again from your card.',
                                  buttons: [
                                    {text: 'Cancel', role: 'cancel'},
                                    {
                                      text: 'Delete',
                                      role: 'destructive',
                                      handler: () => {
                                        walletStorageService.deleteWallet(
                                          data.index,
                                          wallet,
                                        );
                                        setOpenWallet(current =>
                                          current === id ? undefined : current,
                                        );
                                      },
                                    },
                                  ],
                                  onDidDismiss: () => {
                                    const nextTarget = row?.isConnected
                                      ? row
                                      : (listRef.current?.querySelector<HTMLElement>(
                                          '[role="group"]',
                                        ) ??
                                        emptyFocusRef?.current?.querySelector(
                                          'button',
                                        ));

                                    nextTarget?.focus({
                                      preventScroll: true,
                                    });
                                  },
                                });
                              },
                            )}
                          >
                            <AppIcon icon={trash} aria-hidden="true" />
                            Delete
                          </SwipeAction>
                        </>
                      }
                    >
                      <WalletItem
                        data-swipeable-content={collapsedRow ? true : undefined}
                        aria-expanded={collapsedRow ? false : undefined}
                        aria-label={
                          collapsedRow
                            ? `Show ${group.length} ${CHAIN_LABELS[chain]} addresses`
                            : undefined
                        }
                        onExpand={
                          collapsedRow
                            ? () => {
                                setOpenWallet(undefined);
                                expand();
                              }
                            : undefined
                        }
                        onClick={event => {
                          event.currentTarget
                            .querySelector<HTMLElement>('[role="button"]')
                            ?.focus({preventScroll: true});
                          setOpenWallet(undefined);
                          setReceiveWallet(wallet);
                        }}
                      >
                        <KeyListItemContent>
                          <KeyTags>
                            <WalletPath
                              chain={ADDRESS_TYPES[wallet.addressType].chain}
                              buttonProps={
                                !collapsedRow && group.length > 1
                                  ? {
                                      type: 'button',
                                      'data-swipeable-content': true,
                                      'aria-expanded': true,
                                      'aria-label': `Collapse ${CHAIN_LABELS[chain]} addresses`,
                                      onClick: event => {
                                        event.stopPropagation();
                                        setOpenWallet(undefined);
                                        collapse();
                                      },
                                    }
                                  : undefined
                              }
                            >
                              {wallet.path ??
                                ADDRESS_TYPE_LABELS[wallet.addressType]}
                            </WalletPath>
                            {isDefault && (
                              <KeyDerivationBadge
                                role="img"
                                aria-label="Default address"
                                title="Default address"
                              >
                                <AppIcon icon={star} aria-hidden="true" />
                              </KeyDerivationBadge>
                            )}
                            {collapsedRow && (
                              <UnmountAnimationClone>
                                <KeyDerivationBadge
                                  $primary
                                  $revealing
                                  aria-label={`${group.length} addresses`}
                                >
                                  {group.length}
                                </KeyDerivationBadge>
                              </UnmountAnimationClone>
                            )}
                          </KeyTags>
                          <WalletAddress
                            role={collapsedRow ? undefined : 'button'}
                            tabIndex={collapsedRow ? undefined : 0}
                            data-swipeable-content
                            aria-haspopup={collapsedRow ? undefined : 'dialog'}
                            aria-label={
                              collapsedRow
                                ? undefined
                                : `Receive at ${wallet.address}`
                            }
                            onKeyDown={event => {
                              if (
                                !collapsedRow &&
                                (event.key === 'Enter' || event.key === ' ')
                              ) {
                                event.preventDefault();

                                if (!event.repeat) event.currentTarget.click();
                              }
                            }}
                          >
                            {wallet.address}
                          </WalletAddress>
                        </KeyListItemContent>
                      </WalletItem>
                    </WalletRow>
                  );
                });
              }}
            </ExpandableKeyGroup>
          );
        })}
        {wallets.length === 0 && (
          <KeyListItem>
            <KeyListPlaceholder>No addresses</KeyListPlaceholder>
          </KeyListItem>
        )}
        {active && receiveWallet && (
          <ReceiveAddressPopup
            wallet={receiveWallet}
            onDismiss={() => setReceiveWallet(undefined)}
          />
        )}
      </KeyList>
    );
  },
);
