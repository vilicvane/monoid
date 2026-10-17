import {IonFabButton, IonIcon} from '@ionic/react';
import creditCard from 'lucide-static/icons/credit-card.svg';
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
import {
  View,
  ViewContent,
  ViewFab,
  ViewHeader,
  ViewHeaderTitle,
} from '../../../@view/index.js';
import type {ScannedCardData} from '../common.js';
import {scanCardKeys} from '../scan-card.js';

import {KeyItem} from './@key-item.js';

export const SafeView = observer(
  ({view, transition}: RouteComponentProps<Router['safe']>): ReactNode => {
    const {router, walletStorageService, errorService} = useEntrances();

    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      safe: true,
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

            const keys = await scanCardKeys(applet, (index, total) => {
              setStateContent(
                <MonoidScanStatePromptProgress
                  current={index + 1}
                  total={total}
                >
                  Fetching keys
                </MonoidScanStatePromptProgress>,
              );
            });

            scannedCard = {id: uint8ArrayToHex(hello.safe.id), keys};
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
              <IonIcon icon={creditCard} />
            </IonFabButton>
          </ViewFab>
        </View>
        {scanPromptContent}
      </>
    );
  },
);
