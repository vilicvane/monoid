import {IonFabButton, useIonAlert} from '@ionic/react';
import {CreditCard as creditCard, Trash2 as trash} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type MouseEvent, type ReactNode, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import type {SafeIndexHex} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import type {WalletKeyData} from '../../../../@services/index.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {KeyList} from '../../../@key/key-list.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {AppIcon} from '../../../@ui/app-icon.js';
import {
  SwipeAction,
  SwipeActionIcon,
  SwipeableItem,
} from '../../../@ui/swipeable-item.js';
import {
  View,
  ViewContent,
  ViewFab,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
  useViewActive,
} from '../../../@view/index.js';
import type {ScannedCardData} from '../common.js';
import {scanCardItems} from '../scan-card.js';

import {KeyItem} from './@key-item.js';

export const SafeView = observer(
  ({view, transition}: RouteComponentProps<Router['safe']>): ReactNode => {
    const {router, cardStore, walletStorageService, errorService} =
      useEntrances();
    const isViewActive = useViewActive(view);
    const [presentAlert] = useIonAlert();
    const [openKey, setOpenKey] = useState<SafeIndexHex>();
    const listRef = useRef<HTMLDivElement>(null);

    const deleteKey = errorService.catch(
      async (event: MouseEvent<HTMLButtonElement>, key: WalletKeyData) => {
        const row = event.currentTarget.closest<HTMLElement>('[role="group"]');

        await presentAlert({
          header: 'Delete key?',
          subHeader: key.alias || key.index,
          message:
            'Remove this key and all its addresses from this device? Your card is not affected.',
          buttons: [
            {text: 'Cancel', role: 'cancel'},
            {
              text: 'Delete',
              role: 'destructive',
              handler: () => {
                walletStorageService.deleteKey(key.index);
                setOpenKey(undefined);
              },
            },
          ],
          onDidDismiss: () => {
            const nextTarget = row?.isConnected
              ? row
              : (listRef.current?.querySelector<HTMLElement>(
                  '[role="group"]',
                ) ?? listRef.current);

            nextTarget?.focus({preventScroll: true});
          },
        });
      },
    );

    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      allowSetup: true,
      allowInstallRedirect: true,
      auth: 'access',
      retryOnError: true,
    });

    const onScanCardButtonClick = (): void => {
      let scannedCard: ScannedCardData;

      errorService.catch(
        scanPrompt(
          'Scan a monoid card',
          async (applet, setStateContent, hello, signal) => {
            setStateContent('Listing safe items, hold tight...');

            const items = await scanCardItems(
              applet,
              (current, total, stage) => {
                setStateContent(
                  <MonoidScanStatePromptProgress
                    current={current}
                    total={total}
                  >
                    {stage === 'records'
                      ? 'Reading address records'
                      : 'Reading keys'}
                  </MonoidScanStatePromptProgress>,
                );
              },
              signal,
              walletStorageService.keys,
            );

            scannedCard = {
              id: uint8ArrayToHex(hello.id),
              publicKey: uint8ArrayToHex(hello.publicKey),
              bundle: hello.bundle && uint8ArrayToHex(hello.bundle),
              alias: hello.alias,
              allowPeerExtension: hello.allowPeerExtension,
              authority: hello.authority,
              items,
            };
          },
        ).then(() => {
          if (isViewActive()) {
            cardStore.set(scannedCard);
            const {id, publicKey} = scannedCard;
            router.safe.card({card: {id, publicKey}}).$push();
          }
        }),
      );
    };

    return (
      <>
        <View>
          <ViewHeader>
            <ViewHeaderTitle>Safe</ViewHeaderTitle>
          </ViewHeader>
          <ViewContent>
            {!walletStorageService.keys.length ? (
              <ViewPlaceholder>No keys</ViewPlaceholder>
            ) : (
              <KeyList ref={listRef} tabIndex={-1}>
                {walletStorageService.keys.map(key => (
                  <SwipeableItem
                    key={key.index}
                    open={openKey === key.index}
                    onOpenChange={open =>
                      setOpenKey(current =>
                        open
                          ? key.index
                          : current === key.index
                            ? undefined
                            : current,
                      )
                    }
                    actions={
                      <SwipeAction
                        type="button"
                        $color="var(--ion-color-danger)"
                        onClick={event => deleteKey(event, key)}
                      >
                        <SwipeActionIcon>
                          <AppIcon icon={trash} aria-hidden="true" />
                        </SwipeActionIcon>
                        Delete
                      </SwipeAction>
                    }
                  >
                    <KeyItem
                      data={key}
                      onClick={() => {
                        if (openKey) {
                          setOpenKey(undefined);
                        } else if (key.type === 'seed') {
                          router.safe.derivableKey({index: key.index}).$push();
                        } else {
                          router.safe.rawKey({index: key.index}).$push();
                        }
                      }}
                    />
                  </SwipeableItem>
                ))}
              </KeyList>
            )}
          </ViewContent>
          <ViewFab view={view} transition={transition}>
            <IonFabButton
              aria-label="Scan card"
              onClick={onScanCardButtonClick}
            >
              <AppIcon icon={creditCard} />
            </IonFabButton>
          </ViewFab>
        </View>
        {scanPromptContent}
      </>
    );
  },
);
