import {type ReactNode, useEffect} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../@entrances.js';
import type {Router} from '../../../@routes.js';
import {isCredentialRequestCancelled} from '../../../@services/index.js';
import {uint8ArrayToHex} from '../../../@utils/index.js';
import {
  MonoidScanRedirectError,
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../@monoid/monoid-scan-prompt.js';
import {View, ViewHeader, ViewHeaderTitle} from '../../@view/index.js';

import type {ScannedCardData} from './common.js';
import {scanCardItems} from './scan-card.js';

export const ScanCardView = ({
  view,
}: RouteComponentProps<Router['safe']['scanCard']>): ReactNode => {
  const {router, errorService} = useEntrances();
  const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
    safe: true,
    allowInstallRedirect: true,
    auth: 'access',
    retryOnError: true,
  });

  useEffect(() => {
    let disposed = false;
    const isActive = (): boolean =>
      !disposed && !view.$leaving && view.$match.$exact.$active;

    errorService.catch(
      (async () => {
        let scannedCard: ScannedCardData | undefined;

        try {
          await scanPrompt(
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
          );

          if (isActive() && scannedCard) {
            router.safe.card({card: scannedCard}).$push();
          }
        } catch (error) {
          if (
            disposed ||
            view.$leaving ||
            error instanceof MonoidScanRedirectError
          ) {
            return;
          }

          router.safe.$replace();

          if (!isCredentialRequestCancelled(error)) {
            throw error;
          }
        }
      })(),
    );

    return () => {
      disposed = true;
    };
  }, [errorService, router.safe, scanPrompt, view]);

  return (
    <>
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Scan Card</ViewHeaderTitle>
        </ViewHeader>
      </View>
      {scanPromptContent}
    </>
  );
};
