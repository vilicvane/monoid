import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {CardInformation} from '../../../../@lib/global-platform/card-information.js';
import {
  MonoidAppletHello,
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
import {MonoidScanStatePromptContentHighlight} from '../../../@monoid/monoid-scan-prompt.js';
import {getPINInputPlaceholder} from '../../../@monoid/pin-input-placeholder.js';
import {useIsoDepScanPrompt} from '../../../@monoid/use-isodep-scan-prompt.js';
import {Button} from '../../../@ui/button.js';
import {InfoMessage} from '../../../@ui/message-content.js';
import {OperationComplete} from '../../../@ui/operation-complete.js';
import {OperationSteps, Step} from '../../../@ui/step.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  useViewActive,
} from '../../../@view/index.js';

import {CardBundleExtensionSession} from './card-bundle-extension-session.js';
import {CardSecretPINSession} from './card-secret-pin-session.js';
import {useBundleCardAddition} from './use-bundle-card-addition.js';

export const ExtendBundleView = observer(
  ({view}: RouteComponentProps<Router['safe']['extendBundle']>): ReactNode => {
    const {router, cardBundleStore, cardStore, monoidApplet, errorService} =
      useEntrances();
    const isViewActive = useViewActive(view);
    const [session] = useState(() =>
      cardBundleStore.getOrCreateExtension(
        view.extensionId,
        () => new CardBundleExtensionSession(view.card),
      ),
    );
    const [working, setWorking] = useState(false);
    const [stepsExited, setStepsExited] = useState(
      () => session.phase === 'complete',
    );
    const [secretPINSession] = useState(() => new CardSecretPINSession());
    const [pinInput, showPINInput] = useInputModal();
    const scan = useIsoDepScanPrompt();
    const operation = useRef<AbortController | undefined>(undefined);
    const mounted = useRef(true);
    const isActive = useCallback(
      () => mounted.current && isViewActive(),
      [isViewActive],
    );
    const validateAddition = useCallback(
      (hello: MonoidAppletHello) => session.validateAddition(hello),
      [session],
    );
    const onAdded = useCallback(
      (hello: MonoidAppletHello) => session.addCard(hello),
      [session],
    );
    const onNeedsInstall = useCallback(
      (cardInformation: CardInformation) => {
        router
          .cardApplets({
            cardInformation,
            returnTo: 'bundleExtension',
            extensionId: view.extensionId,
          })
          .$push();
      },
      [router, view],
    );
    const addition = useBundleCardAddition({
      isActive,
      validateAddition,
      onAdded,
      onNeedsInstall,
      secretPINSession,
      label: 'Scan new card',
    });
    const acceptInstalledCard = useRef(addition.acceptCard);
    acceptInstalledCard.current = addition.acceptCard;
    const busy = working || addition.busy || session.busy;

    useEffect(
      () =>
        reaction(
          () =>
            isViewActive() && !busy
              ? cardBundleStore.getExtensionCard(view.extensionId)
              : undefined,
          hello => {
            if (!hello) return;
            errorService.catch(
              (async () => {
                let consumed = false;
                try {
                  consumed = await acceptInstalledCard.current(hello);
                } catch (error) {
                  consumed = true;
                  throw error;
                } finally {
                  if (
                    consumed &&
                    cardBundleStore.getExtensionCard(view.extensionId) === hello
                  ) {
                    cardBundleStore.consumeExtensionCard(view.extensionId);
                  }
                }
              })(),
            );
          },
          {fireImmediately: true},
        ),
      [busy, cardBundleStore, errorService, isViewActive, view],
    );
    const complete = session.phase === 'complete' && !busy;
    const activeNumero = {
      collecting: 1,
      requesting: 2,
      approving: 2,
      joining: 3,
      complete: 4,
    }[session.phase];
    const backToCard = router.$backTo(router.safe.card.$exact);
    const back = backToCard ?? router.$backTo(router.safe.$exact);

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        operation.current?.abort();
        secretPINSession.clear();
      };
    }, [secretPINSession]);

    useEffect(
      () =>
        reaction(isViewActive, active => {
          if (!active) {
            operation.current?.abort();
            secretPINSession.clear();
          }
        }),
      [isViewActive, secretPINSession],
    );

    const configure = async (): Promise<void> => {
      if (operation.current || busy || !isActive()) return;
      const phase = session.phase;
      if (phase === 'collecting' || phase === 'complete') return;
      const expected =
        phase === 'requesting'
          ? session.requester
          : phase === 'joining'
            ? session.target
            : undefined;
      const controller = new AbortController();
      operation.current = controller;
      setWorking(true);
      try {
        await secretPINSession.run(
          expected
            ? [
                {
                  ...expected,
                  bundle: phase === 'joining' ? false : session.bundle,
                },
              ]
            : [],
          async (card, pinSignal) => {
            const signal = AbortSignal.any([controller.signal, pinSignal]);
            let description: ReactNode = card
              ? `Card ${card.id}`
              : phase === 'requesting'
                ? 'For a card in this bundle'
                : 'For another card in this bundle';
            for (;;) {
              const input = await showPINInput(
                {
                  type: 'password',
                  ...getPINInputPlaceholder('Secret', 'Enter'),
                  description,
                  center: true,
                  maxLength: 16,
                },
                signal,
              );
              if (input === undefined || !isActive()) return;
              signal.throwIfAborted();
              if (MonoidPIN.is(input)) return input;
              description = 'Use 6 to 16 ASCII characters';
            }
          },
          (credentials, pinSignal) =>
            scan(
              expected ? (
                <>
                  Scan card{' '}
                  <MonoidScanStatePromptContentHighlight>
                    {expected.id}
                  </MonoidScanStatePromptContentHighlight>
                </>
              ) : phase === 'requesting' ? (
                'Scan a bundle card'
              ) : (
                'Scan another bundle card'
              ),
              async (sessionId, setState, scanSignal) => {
                const signal = AbortSignal.any([
                  controller.signal,
                  scanSignal,
                  pinSignal,
                ]);
                signal.throwIfAborted();
                const applet = await monoidApplet.openSession(sessionId);
                signal.throwIfAborted();
                const hello = MonoidAppletHello.satisfies(
                  await applet.hello({}),
                );
                signal.throwIfAborted();
                session.validateCard(hello);
                const {pin, onAuthenticated} = credentials(
                  readBackupCardIdentity(hello),
                );
                setState('Authenticating, hold tight...');
                const cached = cardStore.get({
                  id: uint8ArrayToHex(hello.id),
                  publicKey: uint8ArrayToHex(hello.publicKey),
                });
                try {
                  await session.configureCard(
                    applet,
                    hello,
                    pin,
                    signal,
                    onAuthenticated,
                  );
                } finally {
                  // Keep a confirmed join even if navigation follows its response.
                  if (session.phase === 'complete' && cached) {
                    runInAction(() => {
                      cached.bundle = session.bundle;
                      cached.allowPeerExtension = true;
                      cardStore.set(cached);
                    });
                  }
                }
              },
            ),
        );
      } catch (error) {
        if (!isOperationCancelled(error, controller.signal)) throw error;
      } finally {
        if (session.phase === 'complete') secretPINSession.clear();
        if (operation.current === controller) operation.current = undefined;
        if (mounted.current) setWorking(false);
      }
    };

    const scanButton = (
      <Button
        loading={busy}
        onClick={errorService.catch(
          session.phase === 'collecting' ? addition.resume : configure,
        )}
      >
        {session.phase === 'collecting'
          ? addition.pendingReset?.replacement
            ? 'Scan new card'
            : addition.buttonLabel
          : session.phase === 'approving'
            ? 'Scan another bundle card'
            : session.phase === 'requesting'
              ? session.requester
                ? 'Scan this card'
                : 'Scan a bundle card'
              : 'Scan new card'}
      </Button>
    );

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Extend bundle</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footer={
            complete
              ? back && (
                  <Button color="neutral" onClick={() => back()}>
                    {backToCard ? 'Back to Card' : 'Back to Safe'}
                  </Button>
                )
              : scanButton
          }
        >
          {stepsExited ? (
            <OperationComplete />
          ) : (
            <OperationSteps
              $exiting={complete}
              onAnimationEnd={event => {
                if (complete && event.target === event.currentTarget) {
                  setStepsExited(true);
                }
              }}
            >
              <Step
                title="Add new card"
                numero={1}
                activeNumero={activeNumero}
                keepExpanded={activeNumero < 3}
                processing={busy && activeNumero === 1}
              >
                <CardGrid>
                  {session.target ? (
                    <CardPreview
                      id={session.target.id}
                      alias={session.target.alias}
                      aliasToggle
                      description="ready"
                    />
                  ) : (
                    <CardPreviewButton
                      aria-label="Scan new card"
                      disabled={busy}
                      onClick={errorService.catch(addition.resume)}
                    >
                      <CardPlaceholder aria-hidden="true">+</CardPlaceholder>
                    </CardPreviewButton>
                  )}
                </CardGrid>
              </Step>
              <Step
                title="Extend bundle"
                numero={2}
                activeNumero={activeNumero}
                keepExpanded
                processing={busy && activeNumero === 2}
              >
                <CardGrid>
                  {session.requester ? (
                    <CardPreview
                      id={session.requester.id}
                      alias={session.requester.alias}
                      aliasToggle
                      description={
                        session.phase === 'requesting' ? 'pending' : 'complete'
                      }
                      $scan={session.phase === 'requesting' ? 'next' : 'ready'}
                    />
                  ) : (
                    <CardPreviewButton
                      aria-label="Scan a bundle card"
                      disabled={busy || session.phase !== 'requesting'}
                      onClick={errorService.catch(configure)}
                    >
                      <CardPlaceholder aria-hidden="true">+</CardPlaceholder>
                    </CardPreviewButton>
                  )}
                  {session.approver ? (
                    <CardPreview
                      id={session.approver.id}
                      alias={session.approver.alias}
                      aliasToggle
                      description="complete"
                      $scan="ready"
                    />
                  ) : (
                    <CardPreviewButton
                      aria-label="Scan another bundle card"
                      disabled={busy || session.phase !== 'approving'}
                      onClick={errorService.catch(configure)}
                    >
                      <CardPlaceholder aria-hidden="true">+</CardPlaceholder>
                    </CardPreviewButton>
                  )}
                </CardGrid>
                {activeNumero === 2 && (
                  <InfoMessage>
                    {session.phase === 'requesting' && session.requester
                      ? `Scan card ${session.requester.id} to retry.`
                      : 'Scan two cards from this bundle.'}
                  </InfoMessage>
                )}
              </Step>
              <Step
                title="Join bundle"
                numero={3}
                activeNumero={activeNumero}
                keepExpanded
                processing={busy && activeNumero === 3}
              >
                <CardGrid>
                  {session.target && (
                    <CardPreview
                      id={session.target.id}
                      alias={session.target.alias}
                      aliasToggle
                      description={activeNumero === 3 ? 'pending' : 'complete'}
                      $scan={
                        activeNumero === 3
                          ? 'next'
                          : activeNumero > 3
                            ? 'ready'
                            : undefined
                      }
                    />
                  )}
                </CardGrid>
                {activeNumero === 3 && (
                  <InfoMessage>
                    Scan card {session.target!.id} added in step 1.
                  </InfoMessage>
                )}
              </Step>
            </OperationSteps>
          )}
        </ViewContent>
        {addition.content}
        {isActive() && pinInput}
      </View>
    );
  },
);
