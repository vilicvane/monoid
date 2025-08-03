import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useMemo, useState} from 'react';
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
    const {router, monoidApplet, walletStorageService} = useEntrances();

    const toast = useToast();

    const pathDefault = useMemo(
      () => walletStorageService.suggestNextDerivationPath(view.index),
      [view.index, walletStorageService],
    );

    const key = walletStorageService.indexToKeyMap.get(view.index);

    let [step, setStep] = useState(1);

    const [path, setPath] = useState<string>(pathDefault);
    const [wallet, setWallet] = useState<WalletKeyWalletData>();

    const pathWithFallback = path || pathDefault;

    const effectivePath = BIP39PathString.is(pathWithFallback)
      ? pathWithFallback
      : undefined;

    const step1_ready = effectivePath !== undefined;
    const step2_ready = wallet !== undefined;

    step = Math.min(
      step,
      step1_ready ? Infinity : 1,
      step2_ready ? Infinity : 2,
    );

    const toScanCard = step === 2 && !step2_ready;

    const [scanning, setScanning] = useState(false);

    useEffect(() => {
      if (!toScanCard || !key || effectivePath === undefined) {
        return;
      }

      return monoidApplet.standby(
        async applet => {
          setScanning(true);

          const {publicKey} = await applet.viewKey({
            auth: {
              pin: '123456',
            },
            index: hexToUint8Array(view.index),
            ...(key.type === 'seed' && {
              seed: ETHEREUM_SEED,
            }),
            curve: ETHEREUM_CURVE,
            path: parseDerivationPath(effectivePath),
          });

          setScanning(false);

          const address = computeEthereumAddress(uint8ArrayToHex(publicKey));

          setWallet({
            seed: key.type === 'seed' ? ETHEREUM_SEED : undefined,
            curve: ETHEREUM_CURVE,
            path: effectivePath,
            address,
          });

          setStep(3);
        },
        error => {
          setScanning(false);

          let message: string;

          if (error instanceof CBORAppletError) {
            if (error.source.code === 'NOT_FOUND') {
              message = 'Key not found, wrong card?';
            } else {
              message = `Error: ${error.source.code}`;
            }
          } else {
            message = String(error);
          }

          void toast({
            message,
            color: 'danger',
          });

          console.error(error);
        },
      );
    }, [effectivePath, key, monoidApplet, toScanCard, toast, view.index]);

    if (!key) {
      return null;
    }

    let keyTypeDisplayText: string;

    switch (key.type) {
      case 'seed':
        keyTypeDisplayText = 'seed';
        break;
      case 'master':
        keyTypeDisplayText = 'master key';
        break;
      default:
        throw new Error(`Unknown key type: ${key.type}`);
    }

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
              title="Scan card to derive"
              numero={2}
              activeNumero={step}
              processing={scanning}
              summary={
                wallet && (
                  <InteractiveAddress copyable>
                    {wallet.address}
                  </InteractiveAddress>
                )
              }
            >
              Scan the monoid card that contains this {keyTypeDisplayText} to
              derive.
            </Step>
            <Step
              title="Import the derived wallet"
              numero={3}
              activeNumero={step}
            />
          </Steps>
          <Buttons>
            {step === 1 && (
              <Button disabled={!step1_ready} onClick={() => setStep(2)}>
                Next
              </Button>
            )}
            {step === 3 && (
              <Button onClick={onImportButtonClick}>Import</Button>
            )}
          </Buttons>
        </ViewContent>
      </View>
    );
  },
);
