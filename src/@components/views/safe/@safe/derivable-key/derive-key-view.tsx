import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {BIP39PathString} from '../../../../../@atomics.js';
import {ETHEREUM_CURVE, ETHEREUM_SEED} from '../../../../../@constants.js';
import {useEntrances} from '../../../../../@entrances.js';
import {parseDerivationPath} from '../../../../../@lib/bip39.js';
import {CBORAppletError} from '../../../../../@lib/cbor-applet.js';
import type {Router} from '../../../../../@routes.js';
import type {WalletKeyWalletData} from '../../../../../@services/index.js';
import {
  computeEthereumAddress,
  hexToUint8Array,
  uint8ArrayToHex,
} from '../../../../../@utils/index.js';
import {useMonoidScanPrompt} from '../../../../@monoid/monoid-scan-prompt.js';
import {Button, Buttons} from '../../../../@ui/button.js';
import {Input} from '../../../../@ui/input.js';
import {InteractiveAddress} from '../../../../@ui/interactive-address.js';
import {Step, Steps} from '../../../../@ui/step.js';
import {useToast} from '../../../../@ui/toast.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
} from '../../../../@view/index.js';

export const DeriveKeyView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['safe']['derivableKey']['derive']
  >): ReactNode => {
    const {router, walletStorageService, errorService} = useEntrances();

    const toast = useToast();

    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      auth: 'access',
      retryOnError: true,
    });

    const pathDefault = useMemo(
      () => walletStorageService.suggestNextDerivationPath(view.index),
      [view.index, walletStorageService],
    );

    const key = walletStorageService.indexToKeyMap.get(view.index);

    const [path, setPath] = useState<string>(pathDefault);
    const [wallet, setWallet] = useState<WalletKeyWalletData>();

    const pathWithFallback = path || pathDefault;

    const effectivePath = BIP39PathString.is(pathWithFallback)
      ? pathWithFallback
      : undefined;

    const step = wallet ? 2 : 1;

    if (!key) {
      return null;
    }

    const onScanCardButtonClick = (): void => {
      if (effectivePath === undefined) {
        return;
      }

      let derivedWallet: WalletKeyWalletData;

      errorService.catch(
        scanPrompt('Scan card to derive', async (applet, setStateContent) => {
          setStateContent('Deriving wallet, hold tight...');

          const {publicKey} = await applet
            .viewKey({
              index: hexToUint8Array(view.index),
              ...(key.type === 'seed' && {
                seed: ETHEREUM_SEED,
              }),
              curve: ETHEREUM_CURVE,
              path: parseDerivationPath(effectivePath),
            })
            .catch(error => {
              if (
                error instanceof CBORAppletError &&
                error.source.code === 'NOT_FOUND'
              ) {
                throw new Error('Key not found, wrong card?', {cause: error});
              }

              throw error;
            });

          derivedWallet = {
            seed: key.type === 'seed' ? ETHEREUM_SEED : undefined,
            curve: ETHEREUM_CURVE,
            path: effectivePath,
            address: computeEthereumAddress(uint8ArrayToHex(publicKey)),
          };
        }).then(() => {
          if (!view.$leaving && view.$match.$exact.$active) {
            setWallet(derivedWallet);
          }
        }),
      );
    };

    const onImportButtonClick = (): void => {
      if (!key || !wallet) {
        return;
      }

      if (
        key.wallets.some(
          existingWallet => existingWallet.address === wallet.address,
        )
      ) {
        return;
      }

      runInAction(() => {
        key.wallets.push(wallet);
      });

      void toast({
        message: 'Derived wallet imported',
      });

      router.$back();
    };

    return (
      <>
        <View>
          <ViewHeader>
            <ViewHeaderTitle>Derive</ViewHeaderTitle>
            <ViewHeaderIdentifier
              identifier={{type: 'safe-item', index: view.index}}
            />
          </ViewHeader>
          <ViewContent>
            <Steps>
              <Step
                title="Enter derivation path"
                numero={1}
                activeNumero={step}
                summary={effectivePath}
              >
                <Input
                  value={path}
                  placeholder={pathDefault}
                  onChange={event => setPath(event.target.value)}
                />
              </Step>
              <Step
                title="Import the derived wallet"
                numero={2}
                activeNumero={step}
              >
                {wallet && (
                  <InteractiveAddress copyable>
                    {wallet.address}
                  </InteractiveAddress>
                )}
              </Step>
            </Steps>
            <Buttons>
              {step === 1 && (
                <Button
                  disabled={effectivePath === undefined}
                  onClick={onScanCardButtonClick}
                >
                  Scan card
                </Button>
              )}
              {step === 2 && (
                <Button onClick={onImportButtonClick}>Import</Button>
              )}
            </Buttons>
          </ViewContent>
        </View>
        {scanPromptContent}
      </>
    );
  },
);
