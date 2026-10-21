import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useMemo, useRef, useState} from 'react';
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
import {
  getWalletData,
  getWalletReference,
} from '../../../../../@services/index.js';
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
  useViewActive,
} from '../../../../@view/index.js';
import {CardAddressProgress} from '../../card-address-progress.js';
import {
  getLocalCardWalletDerivation,
  readCardKeyAddress,
} from '../../card-address.js';
import {assertCardForUpdate} from '../../card-alias-update.js';
import {writeCardDerivationRecord} from '../../card-derivations.js';
import type {ScannedCardData} from '../../common.js';

export const DeriveKeyView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['safe']['derivableKey']['derive']
  >): ReactNode => {
    const {
      router,
      cardStore,
      walletStorageService,
      monoidCredentialsStore,
      errorService,
    } = useEntrances();
    const isViewActive = useViewActive(view);
    const [pinSession] = useState(() =>
      monoidCredentialsStore.createPINSession(),
    );

    const [scanPromptContent, scanPrompt] = useMonoidScanPrompt({
      allowSetup: true,
      auth: 'access',
      retryOnError: true,
      pinSession,
    });

    const [busy, setBusy] = useState<'derive' | 'import'>();
    const operation = useRef<AbortController | undefined>(undefined);
    const mounted = useRef(true);

    useEffect(() => {
      mounted.current = true;
      const stopWatching = reaction(
        () => !isViewActive(),
        leaving => {
          if (leaving) {
            operation.current?.abort();
            pinSession.clear();
          }
        },
        {fireImmediately: true},
      );

      return () => {
        mounted.current = false;
        operation.current?.abort();
        pinSession.clear();
        stopWatching();
      };
    }, [pinSession, isViewActive]);

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
    const [derived, setDerived] = useState<{
      wallet: WalletKeyPublicKeyData;
      card?: Pick<ScannedCardData, 'id' | 'publicKey'>;
    }>();
    const wallet = derived?.wallet;

    const pathError = getDerivationPathError(addressType, path);

    const effectivePath =
      pathError === undefined ? BIP39PathString.satisfies(path) : undefined;

    const step = wallet ? 2 : 1;

    if (key?.type !== 'seed') {
      return null;
    }

    const knownWallet =
      effectivePath === undefined
        ? undefined
        : getLocalCardWalletDerivation(key.wallets, {
            addressType,
            seed: options.seed,
            curve: options.curve,
            path: effectivePath,
          });

    const runOperation = async (
      kind: 'derive' | 'import',
      action: (controller: AbortController) => Promise<void>,
    ): Promise<void> => {
      if (operation.current || !isViewActive()) {
        return;
      }

      const controller = new AbortController();
      operation.current = controller;
      setBusy(kind);

      try {
        await action(controller);
      } finally {
        operation.current = undefined;
        if (mounted.current) setBusy(undefined);
      }
    };

    const onScanCardButtonClick = async (): Promise<void> => {
      if (effectivePath === undefined) {
        return;
      }

      await runOperation('derive', async controller => {
        if (knownWallet) {
          setDerived({wallet: knownWallet});
          return;
        }

        let result: typeof derived;

        await scanPrompt(
          'Scan card to derive',
          async (applet, setStateContent, hello, signal) => {
            if (controller.signal.aborted || signal.aborted) return;
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

            if (!controller.signal.aborted && !signal.aborted) {
              result = {
                wallet: {
                  addressType,
                  seed: options.seed,
                  curve: options.curve,
                  path: effectivePath,
                  publicKey: uint8ArrayToHex(publicKey),
                },
                card: {
                  id: uint8ArrayToHex(hello.id),
                  publicKey: uint8ArrayToHex(hello.publicKey),
                },
              };
            }
          },
        );

        if (mounted.current && !controller.signal.aborted && isViewActive()) {
          setDerived(result);
        }
      });
    };

    const onImportButtonClick = async (): Promise<void> => {
      if (!derived) {
        return;
      }

      const {wallet} = derived;
      let card = derived.card;
      const wallets = [getWalletReference(wallet)];

      await runOperation('import', async controller => {
        await scanPrompt(
          'Scan card to import',
          async (applet, setStateContent, hello, signal) => {
            const cancel = (): void => controller.abort();
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();

            try {
              if (!card) {
                const ref = await readCardKeyAddress(
                  applet,
                  key,
                  wallet.addressType,
                  wallet.path,
                );

                if (ref.publicKey !== wallet.publicKey) {
                  throw new Error('Key does not match, wrong card?');
                }

                card = {
                  id: uint8ArrayToHex(hello.id),
                  publicKey: uint8ArrayToHex(hello.publicKey),
                };
              }

              setStateContent('Saving derivation, hold tight...');
              const resource = await writeCardDerivationRecord(
                applet,
                key,
                wallets,
                controller.signal,
                undefined,
                progress => {
                  if (controller.signal.aborted || !mounted.current) return;
                  setStateContent(<CardAddressProgress progress={progress} />);
                },
              );
              // Acknowledged card writes are committed locally before cancellation
              // or route checks; only navigation waits for the scan to finish.
              const cachedCard = cardStore.get(card);
              if (cachedCard) {
                const cachedKey = cachedCard.items.find(
                  item => item.index === key.index,
                );
                const known = [
                  wallet,
                  ...(cachedKey?.derivations ?? []),
                  ...Object.values(cachedKey?.refs ?? {}).map(
                    ({addressType, seed, curve, path, publicKey}) => ({
                      addressType,
                      seed,
                      curve,
                      path,
                      publicKey,
                    }),
                  ),
                  ...key.wallets,
                ];
                const derivations = resource.derivationRecord.wallets.map(
                  parameters => getLocalCardWalletDerivation(known, parameters),
                );
                if (
                  cachedKey &&
                  derivations.every(value => value !== undefined)
                ) {
                  runInAction(() => {
                    cachedCard.upsert(resource);
                    cachedKey.setRecordedWallets(derivations);
                  });
                } else {
                  // The record can include card-only addresses whose public keys
                  // have never been read. Keep partial previews out of CardStore.
                  cardStore.forget(card);
                }
              }
              walletStorageService.addWallet(key.index, wallet);
            } finally {
              signal.removeEventListener('abort', cancel);
            }
          },
          hello => {
            if (card) assertCardForUpdate(hello, card);
          },
        );

        if (!mounted.current || controller.signal.aborted || !isViewActive())
          return;

        runInAction(() => {
          view.expandedChain = ADDRESS_TYPES[wallet.addressType].chain;
        });

        router.$back();
      });
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
                    disabled={busy !== undefined || effectivePath === undefined}
                    loading={busy === 'derive'}
                    onClick={errorService.catch(onScanCardButtonClick)}
                  >
                    {knownWallet ? 'Continue' : 'Scan card'}
                  </Button>
                )}
                {step === 2 && (
                  <Button
                    disabled={busy !== undefined}
                    loading={busy === 'import'}
                    onClick={errorService.catch(onImportButtonClick)}
                  >
                    Import
                  </Button>
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
                <div inert={busy !== undefined}>
                  <AddressTypeSelector
                    value={addressType}
                    onChange={setAddressType}
                  />
                </div>
                <ResettableInput
                  disabled={busy !== undefined}
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
                  resetDisabled={busy !== undefined || path === pathDefault}
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
