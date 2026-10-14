import {IonIcon, useIonAlert} from '@ionic/react';
import copy from 'lucide-static/icons/copy.svg';
import star from 'lucide-static/icons/star.svg';
import trash from 'lucide-static/icons/trash-2.svg';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../../@entrances.js';
import {ADDRESS_TYPES} from '../../../../../@lib/wallet-address.js';
import type {Router} from '../../../../../@routes.js';
import {getDefaultWallet} from '../../../../../@services/index.js';
import {useCopyAddress} from '../../../../@hooks/use-copy-address.js';
import {
  KeyList,
  KeyListAddress,
  KeyListItem,
  KeyListItemContent,
  KeyListPlaceholder,
} from '../../../../@key/key-list.js';
import {
  KeyDerivationBadge,
  KeyDerivationTag,
  KeyTags,
} from '../../../../@key/key-tags.js';
import {Button, Buttons} from '../../../../@ui/button.js';
import {SwipeAction, SwipeableItem} from '../../../../@ui/swipeable-item.js';
import {View, ViewContent} from '../../../../@view/index.js';
import {KeyHeader} from '../@key-header.js';

const pathCollator = new Intl.Collator('en', {numeric: true});

const WalletPath = styled(KeyDerivationTag)`
  flex-shrink: 1;
  min-width: 0;
`;

export const DerivableKeyView = observer(
  ({view}: RouteComponentProps<Router['safe']['derivableKey']>): ReactNode => {
    const {router, walletStorageService, errorService} = useEntrances();
    const copyAddress = useCopyAddress();
    const [presentAlert] = useIonAlert();
    const [openWallet, setOpenWallet] = useState<string>();
    const listRef = useRef<HTMLDivElement>(null);
    const buttonsRef = useRef<HTMLDivElement>(null);

    const {index} = view;

    const key = walletStorageService.indexToKeyMap.get(index);

    useEffect(() => {
      if (!key) {
        router.safe.$reset();
      }
    }, [key, router.safe]);

    if (!key) {
      return null;
    }

    const wallets = key.wallets
      .slice()
      .sort((a, b) => pathCollator.compare(a.path ?? '', b.path ?? ''));
    const defaultWallet = getDefaultWallet(key);

    return (
      <View>
        <KeyHeader data={key} />
        <ViewContent>
          <KeyList ref={listRef}>
            {wallets.map(wallet => {
              const id = `${wallet.addressType}:${wallet.address}`;
              const isDefault = wallet === defaultWallet;

              return (
                <SwipeableItem
                  key={id}
                  open={openWallet === id}
                  onOpenChange={open => setOpenWallet(open ? id : undefined)}
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
                            key.defaultWallet = {
                              addressType: wallet.addressType,
                              address: wallet.address,
                            };
                          });

                          setOpenWallet(undefined);
                        }}
                      >
                        <IonIcon icon={star} aria-hidden="true" />
                        Default
                      </SwipeAction>
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
                                'Remove this saved address from this device? You can derive it again from your card.',
                              buttons: [
                                {text: 'Cancel', role: 'cancel'},
                                {
                                  text: 'Delete',
                                  role: 'destructive',
                                  handler: () => {
                                    walletStorageService.deleteWallet(
                                      index,
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
                                    buttonsRef.current?.querySelector(
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
                    </>
                  }
                >
                  <KeyListItem>
                    <KeyListItemContent>
                      <KeyTags>
                        <WalletPath
                          chain={ADDRESS_TYPES[wallet.addressType].chain}
                        >
                          {wallet.path}
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
                      </KeyTags>
                      <KeyListAddress>{wallet.address}</KeyListAddress>
                    </KeyListItemContent>
                  </KeyListItem>
                </SwipeableItem>
              );
            })}
            {wallets.length === 0 && (
              <KeyListItem>
                <KeyListPlaceholder>No derived addresses</KeyListPlaceholder>
              </KeyListItem>
            )}
          </KeyList>
          <Buttons ref={buttonsRef}>
            <Button onClick={() => view.$match.derive.$push()}>Derive</Button>
          </Buttons>
        </ViewContent>
      </View>
    );
  },
);
