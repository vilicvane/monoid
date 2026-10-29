import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../../@entrances.js';
import {
  type DerivedKeyPublicKeyData,
  type SeedKeyDerivation,
  mergeDerivedPublicKeys,
  parseSeedKeyDerivation,
  readSeedDerivedKeys,
} from '../../../../../@lib/key-derivation.js';
import {
  assertSameCard,
  writeCardKeyDerivationRecord,
} from '../../../../../@lib/monoid/index.js';
import type {Router} from '../../../../../@routes.js';
import {uint8ArrayToHex} from '../../../../../@utils/index.js';
import {DerivedKeyList} from '../../../../@key/derived-key-list.js';
import {getKeyTypeName} from '../../../../@key/key-type.js';
import {
  scanCardPrompt,
  useMonoidScanPrompt,
} from '../../../../@monoid/monoid-scan-prompt.js';
import {Button} from '../../../../@ui/button.js';
import {ResettableInput} from '../../../../@ui/input.js';
import {InfoMessage} from '../../../../@ui/message-content.js';
import {SegmentedControl} from '../../../../@ui/segmented-control.js';
import {Step, Steps} from '../../../../@ui/step.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
  useViewActive,
} from '../../../../@view/index.js';
import type {ScannedCardData} from '../../common.js';

type DeriveSeedKeyViewProps = RouteComponentProps<
  Router['safe']['derivableKey']['derive']
> & {purposeSelector: (disabled: boolean) => ReactNode};

export const DeriveSeedKeyView: (props: DeriveSeedKeyViewProps) => ReactNode =
  observer(function DeriveSeedKeyView({
    view,
    purposeSelector,
  }: DeriveSeedKeyViewProps): ReactNode {
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
    const [scanContent, scan] = useMonoidScanPrompt({
      auth: 'access',
      retryOnError: false,
      pinSession,
    });
    const [curve, setCurve] = useState<SeedKeyDerivation['curve']>('ed25519');
    const [inputs, setInputs] = useState<
      Partial<Record<SeedKeyDerivation['curve'], string>>
    >({});
    const [busy, setBusy] = useState<'derive' | 'save'>();
    const [derived, setDerived] = useState<{
      key: DerivedKeyPublicKeyData;
      card: Pick<ScannedCardData, 'id' | 'publicKey'>;
    }>();
    const operation = useRef<AbortController | undefined>(undefined);
    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      const dispose = reaction(
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
        dispose();
      };
    }, [isViewActive, pinSession]);

    const source = walletStorageService.indexToKeyMap.get(view.index);
    if (source?.type !== 'seed') return null;
    const input = inputs[curve] ?? '';
    let parameters: SeedKeyDerivation | undefined;
    try {
      parameters = parseSeedKeyDerivation({
        type: 'monoid-001',
        curve,
        context: input,
      });
    } catch {
      // Keep invalid Unicode input editable without starting a card operation.
    }
    const step = derived ? 2 : 1;
    const run = async (
      kind: 'derive' | 'save',
      action: (controller: AbortController) => Promise<void>,
    ): Promise<void> => {
      if (operation.current || !isViewActive()) return;
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

    const derive = async (): Promise<void> => {
      if (!parameters) return;
      await run('derive', async controller => {
        let result: typeof derived;
        await scan(
          'Scan card to derive key',
          async (applet, setContent, hello, signal) => {
            const cancel = (): void => controller.abort();
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();
            try {
              controller.signal.throwIfAborted();
              setContent('Deriving key');
              const [key] = await readSeedDerivedKeys(
                applet,
                source.index,
                [parameters],
                controller.signal,
              );
              result = {
                key,
                card: {
                  id: uint8ArrayToHex(hello.id),
                  publicKey: uint8ArrayToHex(hello.publicKey),
                },
              };
            } finally {
              signal.removeEventListener('abort', cancel);
            }
          },
        );
        if (mounted.current && !controller.signal.aborted && isViewActive())
          setDerived(result);
      });
    };

    const save = async (): Promise<void> => {
      if (!derived) return;
      const selected = derived;
      await run('save', async controller => {
        await scan(
          scanCardPrompt(
            cardStore.get(selected.card) ?? selected.card,
            'to save key',
          ),
          async (applet, setContent, _hello, signal) => {
            const cancel = (): void => controller.abort();
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();
            try {
              controller.signal.throwIfAborted();
              setContent('Checking key');
              const [actual] = await readSeedDerivedKeys(
                applet,
                source.index,
                [selected.key.derivation],
                controller.signal,
              );
              if (actual.publicKey !== selected.key.publicKey)
                throw new Error('The seed no longer matches this key.');
              setContent('Saving derivation');
              const resource = await writeCardKeyDerivationRecord(
                applet,
                {type: 'seed', index: source.index},
                [actual.derivation],
                controller.signal,
              );
              // Commit an acknowledged card write locally, even if cancellation follows it.
              const cachedCard = cardStore.get(selected.card);
              if (cachedCard) {
                const cachedSeed = cachedCard.items.find(
                  item => item.index === source.index && item.type === 'seed',
                );
                runInAction(() => {
                  cachedCard.upsert(resource);
                  if (cachedSeed)
                    cachedSeed.derivedKeys = mergeDerivedPublicKeys(
                      cachedSeed.derivedKeys ?? [],
                      [actual],
                    );
                  cardStore.set(cachedCard);
                });
              }
              await walletStorageService.addDerivedKeys(source.index, actual);
            } finally {
              signal.removeEventListener('abort', cancel);
            }
          },
          hello => assertSameCard(hello, selected.card),
        );
        if (mounted.current && !controller.signal.aborted && isViewActive())
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
              <Button
                disabled={busy !== undefined || (step === 1 && !parameters)}
                loading={busy !== undefined}
                onClick={errorService.catch(step === 1 ? derive : save)}
              >
                {step === 1 ? 'Scan a card' : 'Import'}
              </Button>
            }
          >
            <Steps>
              <Step
                title="Enter key context"
                numero={1}
                activeNumero={step}
                summary={
                  derived?.key.derivation.context ? (
                    <span
                      style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}
                    >
                      {derived.key.derivation.context}
                    </span>
                  ) : undefined
                }
              >
                {purposeSelector(busy !== undefined)}
                <SegmentedControl
                  aria-label="Key curve"
                  value={curve}
                  options={[
                    {value: 'ed25519', label: getKeyTypeName('ed25519')},
                    {value: 'secp256r1', label: getKeyTypeName('secp256r1')},
                  ]}
                  disabled={busy !== undefined}
                  onChange={setCurve}
                />
                <ResettableInput
                  aria-label="Derivation context"
                  aria-invalid={input.length > 0 && parameters === undefined}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  value={input}
                  placeholder="Context (optional)"
                  disabled={busy !== undefined}
                  onChange={event =>
                    setInputs({...inputs, [curve]: event.target.value})
                  }
                  resetDisabled={busy !== undefined || input === ''}
                  onReset={() => setInputs({...inputs, [curve]: ''})}
                />
                <InfoMessage>
                  The same seed, curve and exact context reproduce this key.
                </InfoMessage>
              </Step>
              <Step
                title="Import the derived key"
                numero={2}
                activeNumero={step}
              >
                {derived && <DerivedKeyList keys={[derived.key]} compact />}
              </Step>
            </Steps>
          </ViewContent>
        </View>
        {scanContent}
      </>
    );
  });
