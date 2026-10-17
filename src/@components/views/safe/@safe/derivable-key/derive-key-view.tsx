import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useMemo, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {BIP39PathString} from '../../../../../@atomics.js';
import {useEntrances} from '../../../../../@entrances.js';
import {CBORAppletError} from '../../../../../@lib/cbor-applet.js';
import {getAppletKey} from '../../../../../@lib/monoid/index.js';
import type {AddressType} from '../../../../../@lib/wallet-address.js';
import {
  ADDRESS_TYPES,
  getDerivationPathError,
} from '../../../../../@lib/wallet-address.js';
import type {Router} from '../../../../../@routes.js';
import type {WalletKeyPublicKeyData} from '../../../../../@services/index.js';
import {getWalletData} from '../../../../../@services/index.js';
import {uint8ArrayToHex} from '../../../../../@utils/index.js';
import {AddressTypeSelector} from '../../../../@key/address-type-selector.js';
import {useMonoidScanPrompt} from '../../../../@monoid/monoid-scan-prompt.js';
import {Button} from '../../../../@ui/button.js';
import {ResettableInput} from '../../../../@ui/input.js';
import {InteractiveAddress} from '../../../../@ui/interactive-address.js';
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
    const {router, walletStorageService, errorService} = useEntrances();

    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      auth: 'access',
      retryOnError: true,
    });

    const key = walletStorageService.indexToKeyMap.get(view.index);

    const [addressType, setAddressType] = useState<AddressType>('evm');
    const options = ADDRESS_TYPES[addressType];

    const pathDefault = useMemo(
      () =>
        walletStorageService.suggestNextDerivationPath(view.index, addressType),
      [view.index, walletStorageService, addressType],
    );

    const [paths, setPaths] = useState<Partial<Record<AddressType, string>>>(
      {},
    );
    const path = paths[addressType] ?? pathDefault;
    const [wallet, setWallet] = useState<WalletKeyPublicKeyData>();

    const pathError = getDerivationPathError(addressType, path);

    const effectivePath =
      pathError === undefined ? BIP39PathString.satisfies(path) : undefined;

    const step = wallet ? 2 : 1;

    if (!key) {
      return null;
    }

    const onScanCardButtonClick = (): void => {
      if (effectivePath === undefined) {
        return;
      }

      let derivedWallet: WalletKeyPublicKeyData;

      errorService.catch(
        scanPrompt('Scan card to derive', async (applet, setStateContent) => {
          setStateContent('Deriving wallet, hold tight...');

          const {publicKey} = await applet
            .viewKey({
              ...getAppletKey(key, addressType, effectivePath),
              ...(options.taproot && {taproot: true}),
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
            addressType,
            seed: key.type === 'seed' ? options.seed : undefined,
            curve: options.curve,
            path: effectivePath,
            publicKey: uint8ArrayToHex(publicKey),
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

      walletStorageService.addWallet(key.index, wallet);

      runInAction(() => {
        view.expandedChain = ADDRESS_TYPES[wallet.addressType].chain;
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
          <ViewContent
            footerReveal="end"
            footer={
              <>
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
              </>
            }
          >
            <Steps>
              <Step
                title="Enter derivation path"
                numero={1}
                activeNumero={step}
                summary={effectivePath}
              >
                <AddressTypeSelector
                  value={addressType}
                  onChange={setAddressType}
                />
                <ResettableInput
                  aria-label="Derivation path"
                  aria-invalid={pathError !== undefined}
                  value={path}
                  placeholder={pathDefault}
                  onChange={event =>
                    setPaths({...paths, [addressType]: event.target.value})
                  }
                  onFocus={event => {
                    const input = event.currentTarget;

                    // Wait for caret placement and any reset value update.
                    requestAnimationFrame(() => {
                      if (document.activeElement !== input) {
                        return;
                      }

                      const number = /\d+(?=\D*$)/.exec(input.value);

                      if (number) {
                        input.setSelectionRange(
                          number.index,
                          number.index + number[0].length,
                        );
                      }
                    });
                  }}
                  resetDisabled={path === pathDefault}
                  onReset={() =>
                    setPaths({...paths, [addressType]: pathDefault})
                  }
                />
              </Step>
              <Step
                title="Import the derived wallet"
                numero={2}
                activeNumero={step}
              >
                {wallet && (
                  <InteractiveAddress copyable>
                    {getWalletData(wallet).address}
                  </InteractiveAddress>
                )}
              </Step>
            </Steps>
          </ViewContent>
        </View>
        {scanPromptContent}
      </>
    );
  },
);
