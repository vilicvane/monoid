import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {Button} from '../../../@ui/button.js';
import {InteractiveAddress} from '../../../@ui/interactive-address.js';
import {Step, Steps} from '../../../@ui/step.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
  useViewActive,
} from '../../../@view/index.js';
import {getLocalNativeKeyAddress} from '../card-address.js';

export const DeriveNativeAddressView = observer(
  ({
    view,
  }: RouteComponentProps<Router['safe']['rawKey']['derive']>): ReactNode => {
    const {router, walletStorageService, errorService} = useEntrances();
    const isViewActive = useViewActive(view);
    const operation = useRef(false);
    const mounted = useRef(true);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);
    const key = walletStorageService.indexToKeyMap.get(view.index);
    const address =
      key && getLocalNativeKeyAddress(key.type, key.rawPublicKey, 'solana');
    if (!key || !address) return null;

    const importAddress = async (): Promise<void> => {
      if (operation.current || !isViewActive()) return;
      const current = walletStorageService.indexToKeyMap.get(view.index);
      if (current !== key || current.rawPublicKey !== address.publicKey)
        throw new Error(
          'The key changed. Return to Safe and derive its address again.',
        );
      operation.current = true;
      setBusy(true);
      try {
        walletStorageService.addWallet(view.index, {
          addressType: 'solana',
          seed: undefined,
          curve: undefined,
          path: undefined,
          publicKey: address.publicKey,
        });
        await walletStorageService.flush();
        if (isViewActive()) router.$back();
      } finally {
        operation.current = false;
        if (mounted.current) setBusy(false);
      }
    };

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Derive</ViewHeaderTitle>
          <ViewHeaderIdentifier
            identifier={{type: 'safe-item', index: view.index}}
          />
        </ViewHeader>
        <ViewContent
          footer={
            <Button
              disabled={busy || !isViewActive()}
              loading={busy}
              onClick={errorService.catch(importAddress)}
            >
              Import
            </Button>
          }
        >
          <Steps>
            <Step title="Import the Solana address" numero={1} activeNumero={1}>
              <InteractiveAddress copyable>
                {address.address}
              </InteractiveAddress>
            </Step>
          </Steps>
        </ViewContent>
      </View>
    );
  },
);
