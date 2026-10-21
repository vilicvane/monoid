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
import {
  View,
  ViewHeader,
  ViewHeaderTitle,
  useViewActive,
} from '../../@view/index.js';

import type {ScannedCardData} from './common.js';
import {scanCardItems} from './scan-card.js';

export const ScanCardView = ({
  view,
}: RouteComponentProps<Router['safe']['scanCard']>): ReactNode => {
  const {router, cardStore, walletStorageService, errorService} =
    useEntrances();
  const isViewActive = useViewActive(view);
  const isViewPresent = useViewActive(view, {allowEntering: true});
  const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
    allowSetup: true,
    allowInstallRedirect: true,
    auth: 'access',
    retryOnError: true,
  });

  useEffect(() => {
    let disposed = false;
    const isActive = (): boolean => !disposed && isViewActive();

    errorService.catch(
      (async () => {
        let scannedCard: ScannedCardData | undefined;

        try {
          await scanPrompt(
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
                items,
              };
            },
          );

          if (isActive() && scannedCard) {
            cardStore.set(scannedCard);
            const {id, publicKey} = scannedCard;
            router.safe.card({card: {id, publicKey}}).$push();
          }
        } catch (error) {
          if (
            disposed ||
            !isViewPresent() ||
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
  }, [
    cardStore,
    walletStorageService,
    errorService,
    router.safe,
    scanPrompt,
    isViewActive,
    isViewPresent,
  ]);

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
