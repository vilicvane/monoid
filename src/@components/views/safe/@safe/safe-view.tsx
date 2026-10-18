import {IonFabButton} from '@ionic/react';
import {CreditCard as creditCard} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {KeyList} from '../../../@key/key-list.js';
import {
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {AppIcon} from '../../../@ui/app-icon.js';
import {
  View,
  ViewContent,
  ViewFab,
  ViewHeader,
  ViewHeaderTitle,
} from '../../../@view/index.js';
import type {ScannedCardData} from '../common.js';
import {scanCardItems} from '../scan-card.js';

import {KeyItem} from './@key-item.js';

export const SafeView = observer(
  ({view, transition}: RouteComponentProps<Router['safe']>): ReactNode => {
    const {router, walletStorageService, errorService} = useEntrances();

    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      safe: true,
      allowInstallRedirect: true,
      auth: 'access',
      retryOnError: true,
    });

    const onScanCardButtonClick = (): void => {
      let scannedCard: ScannedCardData;

      errorService.catch(
        scanPrompt(
          'Scan a monoid card',
          async (applet, setStateContent, hello) => {
            setStateContent('Listing safe items...');

            const items = await scanCardItems(applet, (index, total) => {
              setStateContent(
                <MonoidScanStatePromptProgress
                  current={index + 1}
                  total={total}
                >
                  Fetching keys
                </MonoidScanStatePromptProgress>,
              );
            });

            scannedCard = {
              id: uint8ArrayToHex(hello.safe.id),
              publicKey: uint8ArrayToHex(hello.safe.publicKey),
              items,
            };
          },
        ).then(() => {
          if (!view.$leaving && router.safe.$exact.$active) {
            router.safe.card({card: scannedCard}).$push();
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
            <KeyList>
              {walletStorageService.keys.map(key => (
                <KeyItem key={key.index} data={key} />
              ))}
            </KeyList>
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
