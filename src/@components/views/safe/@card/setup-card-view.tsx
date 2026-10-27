import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {type MonoidIdHex, MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {CardInformation} from '../../../../@lib/global-platform/card-information.js';
import {
  MonoidAppletHello,
  MonoidCardError,
  assertCardPINsNotBlocked,
  assertSameCard,
  cardName,
  initializeMonoidCard,
  readBackupCardIdentity,
} from '../../../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../../../@lib/operation-cancelled.js';
import type {Router} from '../../../../@routes.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {
  CardGrid,
  CardPlaceholder,
  CardPreview,
  CardPreviewButton,
} from '../../../@monoid/card-preview.js';
import {scanCardPrompt} from '../../../@monoid/monoid-scan-prompt.js';
import {getPINInputPlaceholder} from '../../../@monoid/pin-input-placeholder.js';
import {requestCardPINs} from '../../../@monoid/request-card-pins.js';
import {useIsoDepScanPrompt} from '../../../@monoid/use-isodep-scan-prompt.js';
import {Button, Buttons} from '../../../@ui/button.js';
import {ConfirmPopup} from '../../../@ui/confirm-popup.js';
import {DetailsPopup} from '../../../@ui/details-popup.js';
import {
  InfoSectionHeader,
  InfoSectionItemLabel,
} from '../../../@ui/info-section.js';
import {WarningMessage} from '../../../@ui/message-content.js';
import {OperationComplete} from '../../../@ui/operation-complete.js';
import {SegmentedControl} from '../../../@ui/segmented-control.js';
import {Step, Steps} from '../../../@ui/step.js';
import {useToast} from '../../../@ui/toast.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  useViewActive,
} from '../../../@view/index.js';
import type {ScannedCardData} from '../common.js';

import {AuthorityBundleSetup} from './authority-bundle-setup.js';
import {CardBundleSession} from './card-bundle-session.js';
import {
  type CardResetIdentity,
  CardResetSession,
} from './card-reset-session.js';
import {CardSecretPINSession} from './card-secret-pin-session.js';
import {CardSetupPIN} from './card-setup-pin.js';
import {readCardForSetup} from './read-card-for-setup.js';

type BundleCandidate =
  | {
      type: 'prepared';
      card: Pick<
        ScannedCardData,
        'id' | 'publicKey' | 'bundle' | 'alias' | 'allowPeerExtension'
      >;
    }
  | {type: 'scanned'; hello: MonoidAppletHello};

function hasInitializedPINs(hello: MonoidAppletHello): boolean {
  return !!hello.pins.secret && !!hello.pins.access;
}

export const SetupCardView = observer(
  ({view}: RouteComponentProps<Router['safe']['setupCard']>): ReactNode => {
    const {
      router,
      errorService,
      copyItemsStore,
      cardBundleStore,
      monoidApplet,
      cardStore,
      monoidCredentialsStore,
    } = useEntrances();
    const [fromCopy] = useState(() => view.copyId !== undefined);
    const [fromCard] = useState(() => !fromCopy && view.card !== undefined);
    const [fixedBundle] = useState(() => (!fromCopy ? view.bundle : undefined));
    const [sourceCard] = useState(() =>
      !fromCopy && view.card ? cardStore.get(view.card) : undefined,
    );
    const [copyFlow] = useState(() =>
      view.copyId ? copyItemsStore.get(view.copyId) : undefined,
    );
    const isViewActive = useViewActive(view);
    const scanPrompt = useIsoDepScanPrompt();
    const toast = useToast();
    const [flow] = useState(() => {
      const state = cardBundleStore.getOrCreate(
        view.bundleId,
        () => new CardBundleSession(),
      );
      if (fixedBundle)
        runInAction(() => {
          state.bundle = fixedBundle;
        });
      return state;
    });
    const bundleSession = flow.session;
    const [pinSession] = useState(() =>
      monoidCredentialsStore.createPINSession(),
    );
    const [secretPINSession] = useState(() => new CardSecretPINSession());
    const bundleEnabled = flow.bundle === 'card';
    const [pinInput, showPINInput] = useInputModal();
    const [selectedCard, setSelectedCard] = useState<string>();
    const [interruptedCard, setInterruptedCard] = useState<string>();
    const cardOperation = useRef<AbortController | undefined>(undefined);
    const mounted = useRef(true);
    const completing = useRef(false);
    const [busy, setBusy] = useState(false);
    const [singleComplete, setComplete] = useState(false);
    const [pendingPIN, setPendingPIN] = useState<MonoidAppletHello>();
    const [showPINSetup, setShowPINSetup] = useState(false);
    const bundleConfirmation = useRef(0);
    const [pendingBundleCard, setPendingBundleCard] = useState<{
      card: CardResetIdentity;
      generation: number;
    }>();

    const requestBundleCard = useCallback(
      async (candidate: BundleCandidate): Promise<void> => {
        if (!mounted.current || !isViewActive()) return;
        if (
          candidate.type === 'prepared' &&
          cardStore.get(candidate.card)?.requiresPINSetup
        )
          return;
        const card =
          candidate.type === 'prepared'
            ? {...candidate.card}
            : {
                id: uint8ArrayToHex(candidate.hello.id),
                publicKey: uint8ArrayToHex(candidate.hello.publicKey),
                alias: candidate.hello.alias,
                allowPeerExtension: candidate.hello.allowPeerExtension,
                authority: candidate.hello.authority,
                bundle:
                  candidate.hello.bundle === false
                    ? (false as const)
                    : uint8ArrayToHex(candidate.hello.bundle),
              };

        if (card.bundle === false) {
          if (candidate.type === 'prepared')
            await bundleSession.addPreparedCard(candidate.card);
          else await bundleSession.addCard(candidate.hello);
        } else {
          if (
            bundleSession.cards.some(
              member => member.publicKey === card.publicKey,
            )
          ) {
            throw new MonoidCardError('Card already added');
          }
          setPendingBundleCard({
            card: {...card, bundle: card.bundle},
            generation: ++bundleConfirmation.current,
          });
        }
      },
      [bundleSession, cardStore, isViewActive],
    );

    useEffect(() => {
      mounted.current = true;

      return () => {
        mounted.current = false;
        cardOperation.current?.abort();
        pinSession.clear();
        secretPINSession.clear();
      };
    }, [pinSession, secretPINSession]);

    useEffect(
      () =>
        reaction(
          isViewActive,
          active => {
            if (!active || flow.bundle === 'authority') return;
            if (view.cardInformation && !flow.informationForwarded) {
              runInAction(() => {
                flow.informationForwarded = true;
              });
              router
                .cardApplets({
                  cardInformation: view.cardInformation,
                  returnTo: bundleEnabled
                    ? 'bundle'
                    : fromCopy
                      ? 'copy'
                      : 'safe',
                  ...(bundleEnabled && {bundleId: view.bundleId}),
                  ...(fromCopy && {copyId: view.copyId}),
                })
                .$push();
              return;
            }
            if (flow.sourceConsumed || !bundleEnabled) return;
            runInAction(() => {
              flow.sourceConsumed = true;
            });
            const card = sourceCard;
            if (card)
              errorService.catch(
                requestBundleCard({
                  type: 'prepared',
                  card,
                }),
              );
          },
          {fireImmediately: true},
        ),
      [
        isViewActive,
        requestBundleCard,
        errorService,
        flow,
        bundleEnabled,
        sourceCard,
        view,
        router,
        fromCopy,
      ],
    );

    useEffect(
      () =>
        reaction(
          () => !isViewActive(),
          inactive => {
            if (inactive) {
              setShowPINSetup(false);
              bundleConfirmation.current++;
              setPendingBundleCard(undefined);
              cardOperation.current?.abort();
              pinSession.clear();
              secretPINSession.clear();
            }
          },
        ),
      [isViewActive, pinSession, secretPINSession],
    );

    const isActive = (): boolean => mounted.current && isViewActive();

    const requestSecretPIN = async (
      prefix: 'Set' | 'Enter',
      description: ReactNode,
      signal: AbortSignal,
    ): Promise<MonoidPIN | undefined> => {
      for (;;) {
        const input = await showPINInput(
          {
            type: 'password',
            ...getPINInputPlaceholder('Secret', prefix),
            description,
            center: true,
            maxLength: 16,
          },
          signal,
        );
        if (input === undefined || signal.aborted || !isActive()) return;
        if (MonoidPIN.is(input)) return input;
        description = 'Use 6 to 16 ASCII characters';
      }
    };

    const cacheSetup = (hello: MonoidAppletHello, emptyCard = false): void => {
      const identity = {
        id: uint8ArrayToHex(hello.id),
        publicKey: uint8ArrayToHex(hello.publicKey),
      };
      runInAction(() => {
        const cached =
          cardStore.get(identity) ??
          (emptyCard
            ? cardStore.set({
                ...identity,
                alias: hello.alias,
                allowPeerExtension: hello.allowPeerExtension,
                authority: hello.authority,
                bundle:
                  hello.bundle === false
                    ? false
                    : uint8ArrayToHex(hello.bundle),
                items: [],
              })
            : undefined);
        if (cached) {
          cached.requiresPINSetup =
            hello.pins.secret === false || hello.pins.access === false;
        }
      });
    };

    const completeSetup = async (hello: MonoidAppletHello): Promise<void> => {
      if (completing.current) return;
      completing.current = true;
      try {
        cacheSetup(hello);
        if (bundleEnabled) {
          await bundleSession.addCard(hello);
        } else {
          await copyFlow?.session.addTarget(hello);
          secretPINSession.clear();
          if (mounted.current) setComplete(true);
        }
        if (mounted.current) setPendingPIN(undefined);
      } finally {
        completing.current = false;
      }
    };

    const openMaintenance = (cardInformation: CardInformation): void => {
      router
        .cardApplets({
          cardInformation,
          returnTo: bundleEnabled ? 'bundle' : fromCopy ? 'copy' : 'safe',
          ...(bundleEnabled && {bundleId: view.bundleId}),
          ...(fromCopy && {copyId: view.copyId}),
        })
        .$push();
    };

    const validateScan = (hello: MonoidAppletHello): void => {
      if (bundleEnabled) bundleSession.validateAddition(hello);
      // An enrolled card may be reset even when its old PINs are blocked.
      if (bundleEnabled && hello.bundle !== false) return;
      assertCardPINsNotBlocked(hello);
    };

    const acceptScan = async (hello: MonoidAppletHello): Promise<void> => {
      validateScan(hello);
      if (bundleEnabled && hello.bundle !== false) {
        await requestBundleCard({type: 'scanned', hello});
        return;
      }
      if (hello.pins.secret === false || hello.pins.access === false) {
        cacheSetup(hello);
        setPendingPIN(hello);
        setShowPINSetup(true);
      } else {
        await completeSetup(hello);
      }
    };

    const scan = async (): Promise<void> => {
      if (cardOperation.current || pendingBundleCard || !isActive()) return;
      const operation = new AbortController();
      cardOperation.current = operation;
      setBusy(true);
      let completed: MonoidAppletHello | undefined;
      try {
        let result: Awaited<ReturnType<typeof readCardForSetup>> | undefined;
        await scanPrompt('Scan a card', async (sessionId, setState, signal) => {
          result = await readCardForSetup(
            sessionId,
            monoidApplet,
            setState,
            AbortSignal.any([signal, operation.signal]),
          );
          if (result.type === 'ready') validateScan(result.hello);
          if (
            result.type === 'ready' &&
            hasInitializedPINs(result.hello) &&
            (!bundleEnabled || result.hello.bundle === false)
          ) {
            completed = result.hello;
          }
        });
        if (!isActive() || operation.signal.aborted || !result) return;
        // A new discovery is independent of any reset whose new identity was lost.
        runInAction(() => {
          flow.pendingReset = undefined;
        });
        if (result.type === 'setup') openMaintenance(result.cardInformation);
        else if (!completed) await acceptScan(result.hello);
      } catch (error) {
        if (!isOperationCancelled(error, operation.signal)) throw error;
      } finally {
        try {
          // Keep a verified member when a queued signing request navigates away
          // as the NFC presentation closes.
          if (completed) {
            await completeSetup(completed);
            runInAction(() => {
              flow.pendingReset = undefined;
            });
          }
        } finally {
          if (cardOperation.current === operation)
            cardOperation.current = undefined;
          if (mounted.current) setBusy(false);
        }
      }
    };

    const resetAndAdd = async (reset: CardResetSession): Promise<void> => {
      if (cardOperation.current || !isActive()) return;
      const operation = new AbortController();
      const pinSignal = secretPINSession.signal;
      cardOperation.current = operation;
      runInAction(() => {
        flow.pendingReset = reset;
      });
      setBusy(true);
      let pin: MonoidPIN | undefined;
      let accessPIN: MonoidPIN | undefined;
      let initialized: MonoidAppletHello | undefined;
      let completed: MonoidAppletHello | undefined;
      let accessPINId: MonoidIdHex | undefined;
      try {
        if (!reset.attempted) {
          // One vault authorization covers removing the old ID and saving the new ID.
          await pinSession.authenticate(operation.signal);
          operation.signal.throwIfAborted();
          if (!isActive()) return;
          const requested = await requestCardPINs(
            showPINInput,
            {secretSet: false, accessSet: false},
            operation.signal,
          );
          if (!requested) return;
          pin = requested.secret;
          accessPIN = requested.access;
          operation.signal.throwIfAborted();
          if (!isActive()) return;
        }
        await scanPrompt(
          scanCardPrompt(reset.replacement ?? reset.card),
          async (sessionId, setState, scanSignal) => {
            const signal = AbortSignal.any([
              scanSignal,
              operation.signal,
              pinSignal,
            ]);
            signal.throwIfAborted();
            const applet = await monoidApplet.openSession(sessionId);
            signal.throwIfAborted();
            const current = MonoidAppletHello.satisfies(await applet.hello({}));
            setState(
              reset.attempted
                ? 'Checking card, hold tight...'
                : 'Resetting card, hold tight...',
            );
            const cached = cardStore.get(reset.card);
            let hello = await reset.readOrReset(
              applet,
              current,
              () => pinSession.removePIN(reset.card.id, undefined, signal),
              () =>
                runInAction(() => {
                  if (cached) {
                    cached.items = [];
                    cached.bundle = false;
                    cached.allowPeerExtension = false;
                    cached.requiresPINSetup = true;
                  }
                }),
              signal,
            );
            cacheSetup(
              hello,
              hello.pins.secret === false && hello.pins.access === false,
            );
            if (pin !== undefined) {
              signal.throwIfAborted();
              const rememberPIN = secretPINSession.onAuthenticated(
                readBackupCardIdentity(hello),
                pin,
              );
              setState('Setting Secret PIN, hold tight...');
              hello = await initializeMonoidCard(
                applet,
                hello,
                pin,
                signal,
                accessPIN,
              );
              rememberPIN();
              cacheSetup(hello);
              completed = hello;
              setState('Authenticating, hold tight...');
              await applet.authenticate({pin: accessPIN!});
              signal.throwIfAborted();
              accessPINId = uint8ArrayToHex(hello.id);
            }
            initialized = hello;
            if (hasInitializedPINs(hello)) completed = hello;
          },
        );
        if (accessPINId && pin && isActive() && !operation.signal.aborted) {
          try {
            await pinSession.setPIN(accessPINId, accessPIN!, operation.signal);
          } catch {
            toast({
              message: 'Access PIN was not saved on this device',
              color: 'warning',
            });
          }
        }
        if (!isActive() || operation.signal.aborted || !initialized) return;
        if (!completed) await acceptScan(initialized);
        runInAction(() => {
          flow.pendingReset = undefined;
        });
      } catch (error) {
        if (!isOperationCancelled(error, operation.signal)) throw error;
      } finally {
        pin = undefined;
        accessPIN = undefined;
        pinSession.clear();
        try {
          if (completed) {
            await completeSetup(completed);
            runInAction(() => {
              flow.pendingReset = undefined;
            });
          }
        } finally {
          if (cardOperation.current === operation)
            cardOperation.current = undefined;
          if (mounted.current) setBusy(false);
        }
      }
    };

    const configureCard = async (publicKey?: string): Promise<void> => {
      if (
        cardOperation.current ||
        busy ||
        !isActive() ||
        bundleSession.phase !== 'configuring' ||
        bundleSession.generationUncertain
      )
        return;
      const selected = bundleSession.cards.find(
        card => card.publicKey === publicKey,
      );
      const operation = new AbortController();
      cardOperation.current = operation;
      setBusy(true);
      let scannedPublicKey: string | undefined;
      try {
        const candidates = selected
          ? [selected]
          : bundleSession.cards.filter(card => card.status !== 'complete');
        await secretPINSession.run(
          candidates.map(card => ({...card, bundle: card.bundle ?? false})),
          (card, signal) =>
            requestSecretPIN(
              'Enter',
              card ? <>Card {cardName(card)}</> : 'For the card you will scan',
              AbortSignal.any([signal, operation.signal]),
            ),
          (credentials, pinSignal) =>
            scanPrompt(
              selected
                ? scanCardPrompt(selected)
                : bundleSession.configuredCount
                  ? 'Scan next card'
                  : 'Scan a card',
              async (sessionId, setState, scanSignal) => {
                const signal = AbortSignal.any([
                  scanSignal,
                  operation.signal,
                  pinSignal,
                ]);
                signal.throwIfAborted();
                const applet = await monoidApplet.openSession(sessionId);
                signal.throwIfAborted();
                const hello = MonoidAppletHello.satisfies(
                  await applet.hello({}),
                );
                signal.throwIfAborted();
                if (selected) assertSameCard(hello, selected);
                const member = bundleSession.validateCard(hello);
                const {pin, onAuthenticated} = credentials(
                  readBackupCardIdentity(hello),
                );
                scannedPublicKey = member.publicKey;
                setInterruptedCard(undefined);
                setState(
                  bundleSession.bundle
                    ? 'Joining bundle, hold tight...'
                    : 'Creating bundle, hold tight...',
                );
                const cached = cardStore.get({
                  id: uint8ArrayToHex(hello.id),
                  publicKey: uint8ArrayToHex(hello.publicKey),
                });
                try {
                  await bundleSession.configureCard(
                    applet,
                    hello,
                    pin,
                    signal,
                    onAuthenticated,
                  );
                } finally {
                  // An ACK remains authoritative even if navigation follows it.
                  runInAction(() => {
                    const confirmed = bundleSession.cards.find(
                      card => card.publicKey === member.publicKey,
                    );
                    if (cached && confirmed?.status === 'complete') {
                      cached.bundle = confirmed.bundle!;
                      cached.allowPeerExtension = true;
                      cardStore.set(cached);
                    }
                  });
                }
              },
            ),
        );
      } catch (error) {
        if (
          mounted.current &&
          scannedPublicKey &&
          bundleSession.cards.find(card => card.publicKey === scannedPublicKey)
            ?.status !== 'complete'
        )
          setInterruptedCard(scannedPublicKey);
        if (!isOperationCancelled(error, operation.signal)) throw error;
      } finally {
        if (bundleSession.configuredCount === bundleSession.cards.length)
          secretPINSession.clear();
        if (cardOperation.current === operation)
          cardOperation.current = undefined;
        if (mounted.current) setBusy(false);
      }
    };

    const complete =
      singleComplete || (bundleSession.phase === 'complete' && !busy);
    const configuring = bundleEnabled && bundleSession.phase !== 'collecting';
    const generationFailed = bundleSession.generationUncertain && !busy;
    const hasPendingCard = bundleSession.cards.some(
      card => card.status !== 'complete',
    );
    const collectionBusy = busy || !!pendingPIN || !!pendingBundleCard;
    const canReturn = complete || generationFailed;
    const backToCopy =
      canReturn && fromCopy
        ? router.$backTo(router.safe.copyItems.$exact)
        : undefined;
    const backToCard =
      canReturn && fromCard
        ? router.$backTo(router.safe.card.$exact)
        : undefined;
    const back = canReturn
      ? (backToCopy ?? backToCard ?? router.$backTo(router.safe.$exact))
      : undefined;
    const backLabel = backToCopy
      ? 'Back to Copy'
      : backToCard
        ? 'Back to Card'
        : 'Back to Safe';

    const bundleCards = bundleEnabled && (
      <>
        <CardGrid>
          {bundleSession.cards.map(card => (
            <CardPreviewButton
              key={card.publicKey}
              aria-label={
                configuring ? `Configure card ${card.id}` : `Card ${card.id}`
              }
              disabled={
                collectionBusy ||
                bundleSession.generationUncertain ||
                card.status === 'complete'
              }
              onClick={
                configuring
                  ? errorService.catch(() => configureCard(card.publicKey))
                  : () => setSelectedCard(card.publicKey)
              }
            >
              <CardPreview
                id={card.id}
                alias={card.alias}
                description={
                  card.status === 'complete'
                    ? 'complete'
                    : interruptedCard === card.publicKey
                      ? 'interrupted'
                      : configuring
                        ? 'pending'
                        : 'ready'
                }
                $scan={
                  configuring
                    ? card.status === 'complete'
                      ? 'ready'
                      : 'pending'
                    : undefined
                }
                $interrupted={interruptedCard === card.publicKey}
              />
            </CardPreviewButton>
          ))}
          {!configuring &&
            Array.from(
              {length: Math.max(1, 2 - bundleSession.cards.length)},
              (_, index) => (
                <CardPreviewButton
                  key={`add-${index}`}
                  aria-label="Add card"
                  disabled={collectionBusy}
                  onClick={errorService.catch(scan)}
                >
                  <CardPlaceholder aria-hidden="true">+</CardPlaceholder>
                </CardPreviewButton>
              ),
            )}
        </CardGrid>
        {generationFailed && (
          <WarningMessage role="alert">
            The bundle may have been created, but its setup data is incomplete.
            Start a new setup.
          </WarningMessage>
        )}
      </>
    );

    const bundleMode = !fromCopy && !fixedBundle && (
      <SegmentedControl
        aria-label="Bundle"
        value={flow.bundle ?? 'none'}
        options={[
          {value: 'none', label: 'None'},
          {value: 'card', label: 'Cards'},
          {value: 'authority', label: 'Authority'},
        ]}
        disabled={
          collectionBusy ||
          !!flow.authority?.busy ||
          (flow.bundle === 'authority'
            ? !!flow.authority?.joinedCount
            : bundleSession.cards.length > 0 || configuring)
        }
        onChange={errorService.catch(async mode => {
          if (mode === 'card' && sourceCard) {
            await requestBundleCard({type: 'prepared', card: sourceCard});
          }
          runInAction(() => {
            flow.bundle = mode === 'none' ? undefined : mode;
            flow.sourceConsumed = mode === 'card';
          });
        })}
      />
    );

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>
            {fromCopy
              ? 'Setup card'
              : fixedBundle === 'authority'
                ? 'Authority bundle'
                : fixedBundle === 'card'
                  ? 'Create bundle'
                  : 'Setup cards'}
          </ViewHeaderTitle>
        </ViewHeader>
        {flow.bundle === 'authority' ? (
          <AuthorityBundleSetup view={view} flow={flow} sourceCard={sourceCard}>
            {bundleMode}
          </AuthorityBundleSetup>
        ) : (
          <ViewContent
            footer={
              complete ? (
                back && (
                  <Button color="neutral" onClick={() => back()}>
                    {backLabel}
                  </Button>
                )
              ) : configuring ? (
                generationFailed ? (
                  back && (
                    <Button color="neutral" onClick={() => back()}>
                      {backLabel}
                    </Button>
                  )
                ) : (
                  <Button
                    disabled={!hasPendingCard || !!pendingBundleCard}
                    loading={busy}
                    onClick={errorService.catch(() => configureCard())}
                  >
                    {bundleSession.configuredCount
                      ? 'Scan next card'
                      : 'Scan a card'}
                  </Button>
                )
              ) : (
                <Buttons>
                  {bundleEnabled &&
                    !collectionBusy &&
                    bundleSession.cards.length >= 2 && (
                      <Button
                        color="primary"
                        onClick={errorService.catch(() =>
                          bundleSession.beginRoundTwo(),
                        )}
                      >
                        Continue
                      </Button>
                    )}
                  {pendingPIN ? (
                    <Button onClick={() => setShowPINSetup(true)}>
                      {pendingPIN.pins.secret === false
                        ? 'Set Secret PIN'
                        : pendingPIN.pins.access === false
                          ? 'Set Access PIN'
                          : 'Continue'}
                    </Button>
                  ) : (
                    <Button
                      color={
                        bundleEnabled && bundleSession.cards.length >= 2
                          ? 'neutral'
                          : 'primary'
                      }
                      disabled={!!pendingBundleCard}
                      loading={busy}
                      onClick={errorService.catch(() =>
                        flow.pendingReset?.replacement
                          ? resetAndAdd(flow.pendingReset)
                          : scan(),
                      )}
                    >
                      {flow.pendingReset?.replacement
                        ? 'Check card'
                        : bundleSession.cards.length
                          ? 'Add another card'
                          : 'Add a card'}
                    </Button>
                  )}
                </Buttons>
              )
            }
          >
            {complete ? (
              <OperationComplete />
            ) : (
              <>
                <Steps>
                  {bundleEnabled ? (
                    <>
                      <Step
                        title="Add cards"
                        numero={1}
                        activeNumero={configuring ? 2 : 1}
                        processing={busy && !configuring}
                      >
                        {bundleMode}
                        {bundleCards}
                      </Step>
                      <Step
                        title={
                          <InfoSectionHeader>
                            <span>Create bundle</span>
                            {configuring && (
                              <InfoSectionItemLabel>
                                {bundleSession.configuredCount}/
                                {bundleSession.cards.length}
                              </InfoSectionItemLabel>
                            )}
                          </InfoSectionHeader>
                        }
                        numero={2}
                        activeNumero={configuring ? 2 : 1}
                        processing={busy && configuring}
                      >
                        {bundleCards}
                      </Step>
                    </>
                  ) : (
                    <Step
                      title="Set up card"
                      numero={1}
                      activeNumero={1}
                      processing={busy}
                    >
                      {bundleMode}
                    </Step>
                  )}
                </Steps>
              </>
            )}
          </ViewContent>
        )}
        {selectedCard && !configuring && (
          <DetailsPopup
            aria-label="Card actions"
            onDismiss={() => setSelectedCard(undefined)}
          >
            <Button
              color="danger"
              onClick={errorService.catch(async () => {
                await bundleSession.removeCard(selectedCard);
                setSelectedCard(undefined);
              })}
            >
              Remove
            </Button>
          </DetailsPopup>
        )}
        {showPINSetup && pendingPIN && isActive() && (
          <CardSetupPIN
            hello={pendingPIN}
            secretPINSession={secretPINSession}
            onFinished={errorService.catch(async (initialized, current) => {
              if (!isActive()) return;
              setShowPINSetup(false);
              if (initialized && current) {
                await completeSetup(current);
              } else if (current) {
                setPendingPIN(current);
              }
            })}
          />
        )}
        {pendingBundleCard && !busy && isActive() && (
          <ConfirmPopup
            key={pendingBundleCard.generation}
            title="Reset card and join bundle?"
            confirmColor="danger"
            confirmText={['I understand, add card', 'Confirm']}
            onCancel={() => {
              bundleConfirmation.current++;
              setPendingBundleCard(undefined);
            }}
            onConfirm={errorService.catch(async () => {
              if (
                !isActive() ||
                pendingBundleCard.generation !== bundleConfirmation.current
              )
                return;
              bundleConfirmation.current++;
              setPendingBundleCard(undefined);
              await resetAndAdd(new CardResetSession(pendingBundleCard.card));
            })}
          >
            <p>
              Card {cardName(pendingBundleCard.card)} already belongs to a
              bundle.
            </p>
            <ol>
              <li>
                Adding this card will erase its stored items and both PINs, and
                change its Card ID.
              </li>
              <li>
                This card will no longer be able to receive data from other
                cards in its original bundle.
              </li>
            </ol>
          </ConfirmPopup>
        )}
        {isActive() && pinInput}
      </View>
    );
  },
);
