import {IonIcon, useIonAlert} from '@ionic/react';
import copy from 'lucide-static/icons/copy.svg';
import star from 'lucide-static/icons/star.svg';
import trash from 'lucide-static/icons/trash-2.svg';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
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
import {useCopyAddress} from '../@hooks/use-copy-address.js';
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

const pathCollator = new Intl.Collator('en', {numeric: true});

const CHAIN_LABELS: Record<AddressChain, string> = {
  evm: 'EVM',
  solana: 'Solana',
  bitcoin: 'BTC',
};

const WalletRow = styled(SwipeableItem)<{$revealing?: boolean}>`
  ${keyGroupReveal}
`;

const WalletPath = styled(KeyDerivationTag)`
  flex-shrink: 1;
  min-width: 0;
`;

export const KeyWalletList = observer(
  ({
    data,
    emptyFocusRef,
  }: {
    data: WalletKeyData;
    emptyFocusRef?: RefObject<HTMLDivElement | null>;
  }): ReactNode => {
    const {walletStorageService, errorService} = useEntrances();
    const copyAddress = useCopyAddress();
    const [presentAlert] = useIonAlert();
    const [openWallet, setOpenWallet] = useState<string>();
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
              autoExpand={groups.size === 1}
            >
              {({expanded, revealing, expand}) => {
                const collapsed = group.length > 1 && !expanded;

                return (collapsed ? [representative] : group).map(wallet => {
                  const id = JSON.stringify(getWalletReference(wallet));
                  const isDefault = wallet === defaultWallet;

                  return (
                    <WalletRow
                      key={id}
                      className={
                        wallet === representative
                          ? 'key-group-primary'
                          : undefined
                      }
                      $revealing={revealing && wallet !== representative}
                      open={openWallet === id}
                      onOpenChange={open =>
                        setOpenWallet(open ? id : undefined)
                      }
                      actions={
                        <>
                          <SwipeAction
                            type="button"
                            onClick={errorService.catch(async () => {
                              await copyAddress(wallet.address);
                              setOpenWallet(current =>
                                current === id ? undefined : current,
                              );
                            })}
                          >
                            <IonIcon icon={copy} aria-hidden="true" />
                            Copy
                          </SwipeAction>
                          <SwipeAction
                            type="button"
                            $color="var(--color-derivations-badge)"
                            aria-pressed={isDefault}
                            disabled={isDefault}
                            onClick={() => {
                              runInAction(() => {
                                data.defaultWallet = getWalletReference(wallet);
                              });

                              setOpenWallet(undefined);
                            }}
                          >
                            <IonIcon icon={star} aria-hidden="true" />
                            Default
                          </SwipeAction>
                          {derivable && (
                            <SwipeAction
                              type="button"
                              $color="var(--ion-color-danger)"
                              onClick={errorService.catch(
                                async (
                                  event: MouseEvent<HTMLButtonElement>,
                                ) => {
                                  const row =
                                    event.currentTarget.closest<HTMLElement>(
                                      '[role="group"]',
                                    );

                                  await presentAlert({
                                    header: 'Delete address?',
                                    subHeader: wallet.address,
                                    message:
                                      'Remove this saved address from this device? You can derive it again from your card.',
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
                                            current === id
                                              ? undefined
                                              : current,
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

                                      nextTarget?.focus({preventScroll: true});
                                    },
                                  });
                                },
                              )}
                            >
                              <IonIcon icon={trash} aria-hidden="true" />
                              Delete
                            </SwipeAction>
                          )}
                        </>
                      }
                    >
                      <KeyGroupItem
                        as={collapsed ? 'button' : 'div'}
                        type={collapsed ? 'button' : undefined}
                        data-swipeable-content={collapsed ? true : undefined}
                        aria-expanded={collapsed ? false : undefined}
                        aria-label={
                          collapsed
                            ? `Show ${group.length} ${CHAIN_LABELS[chain]} addresses`
                            : undefined
                        }
                        onClick={
                          collapsed
                            ? () => {
                                setOpenWallet(undefined);
                                expand();
                              }
                            : undefined
                        }
                      >
                        <KeyListItemContent>
                          <KeyTags>
                            <WalletPath
                              chain={ADDRESS_TYPES[wallet.addressType].chain}
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
                                <IonIcon icon={star} aria-hidden="true" />
                              </KeyDerivationBadge>
                            )}
                            {collapsed && (
                              <KeyDerivationBadge
                                $primary
                                aria-label={`${group.length} addresses`}
                              >
                                {group.length}
                              </KeyDerivationBadge>
                            )}
                          </KeyTags>
                          <KeyListAddress>{wallet.address}</KeyListAddress>
                        </KeyListItemContent>
                      </KeyGroupItem>
                    </WalletRow>
                  );
                });
              }}
            </ExpandableKeyGroup>
          );
        })}
        {wallets.length === 0 && (
          <KeyListItem>
            <KeyListPlaceholder>No derived addresses</KeyListPlaceholder>
          </KeyListItem>
        )}
      </KeyList>
    );
  },
);
