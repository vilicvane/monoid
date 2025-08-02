import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import type {EthereumAddress} from '../../../../../@atomics.js';
import {BIP39PathString} from '../../../../../@atomics.js';
import {ETHEREUM_CURVE, ETHEREUM_SEED} from '../../../../../@constants.js';
import {useEntrances} from '../../../../../@entrances.js';
import {parseDerivationPath} from '../../../../../@lib/bip39.js';
import type {Router} from '../../../../../@routes.js';
import {
  computeEthereumAddress,
  hexToUint8Array,
  uint8ArrayToHex,
} from '../../../../../@utils/index.js';
import {Button, Buttons} from '../../../../@ui/button.js';
import {Step, Steps} from '../../../../@ui/step.js';
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
    const {monoidApplet, walletStorageService} = useEntrances();

    const pathDefault = useMemo(
      () => walletStorageService.suggestNextDerivationPath(view.index),
      [view.index, walletStorageService],
    );

    const key = walletStorageService.indexToKeyMap.get(view.index);

    let [step, setStep] = useState(0);

    const [path, setPath] = useState<string>(pathDefault);
    const [address, setAddress] = useState<EthereumAddress>();

    const pathWithFallback = path || pathDefault;

    const effectivePath = BIP39PathString.is(pathWithFallback)
      ? pathWithFallback
      : undefined;

    const step0_ready = effectivePath !== undefined;
    const step1_ready = address !== undefined;

    step = Math.min(
      step,
      step0_ready ? Infinity : 0,
      step1_ready ? Infinity : 1,
    );

    const toScanCard = step === 1 && !step1_ready;

    useEffect(() => {
      if (!toScanCard || !key || effectivePath === undefined) {
        return;
      }

      return monoidApplet.standby(
        async applet => {
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

          setAddress(computeEthereumAddress(uint8ArrayToHex(publicKey)));
        },
        error => {
          console.error(error);
        },
      );
    }, [effectivePath, key, monoidApplet, toScanCard, view.index]);

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Derive Key</ViewHeaderTitle>
          <ViewHeaderIdentifier
            identifier={{type: 'safe-item', index: view.index}}
          />
        </ViewHeader>
        <ViewContent>
          <Steps>
            <Step
              title="Enter derivation path"
              active={step === 0}
              ready={step0_ready}
            >
              <input
                value={path}
                placeholder={pathDefault}
                onChange={event => setPath(event.target.value)}
              />
            </Step>
            <Step
              title="Scan monoid card to derive key"
              active={step === 1}
              ready={step1_ready}
            >
              {address ? (
                <>
                  <p>Your derived Ethereum address is:</p>
                  <code>{address}</code>
                </>
              ) : (
                <p>Scan your monoid card to derive the key.</p>
              )}
            </Step>
          </Steps>
          <Buttons>
            {step === 0 && (
              <Button disabled={!step0_ready} onClick={() => setStep(1)}>
                Next
              </Button>
            )}
            {step === 1 && (
              <Button
                disabled={!step1_ready}
                onClick={() => {
                  // Handle import action
                }}
              >
                Import
              </Button>
            )}
          </Buttons>
        </ViewContent>
      </View>
    );
  },
);
