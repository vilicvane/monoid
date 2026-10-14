import {IonFabButton, IonIcon} from '@ionic/react';
import creditCard from 'lucide-static/icons/credit-card.svg';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {
  MonoidScanStatePromptContentHighlight,
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

const List = styled.div`
  flex: 1;
  margin: calc(-1 * var(--view-padding)) calc(-1 * var(--view-padding)) 0;
`;

export const SafeView = observer(
  ({view, transition}: RouteComponentProps<Router['safe']>): ReactNode => {
    const {router, walletStorageService, errorService} = useEntrances();

    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
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
                <>
                  Fetching keys, hold tight...
                  <br />
                  <MonoidScanStatePromptContentHighlight>
                    {index + 1}
                  </MonoidScanStatePromptContentHighlight>
                  /{total}
                </>,
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
            <List>
              {walletStorageService.keys.map(key => (
                <KeyItem key={key.index} data={key} />
              ))}
            </List>
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
