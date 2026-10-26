import {Plus as plus, RotateCcw as rotateCcw} from 'lucide-react';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {useEntrances} from '../../../../@entrances.js';
import {readCardInformation} from '../../../../@lib/global-platform/card-information.js';
import {
  type AppletStage,
  type CardBackupIdentity,
  type MonoidAppletHello,
  MonoidCardError,
  assertSameCardWithBundle,
  createMonoidApplet,
  readBackupCardIdentity,
  readMonoidAppletInstallation,
  resolveMonoidAppletMaintenanceAid,
} from '../../../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../../../@lib/operation-cancelled.js';
import type {Router} from '../../../../@routes.js';
import {hexToUint8Array} from '../../../../@utils/index.js';
import {KeyListItem, KeyListPlaceholder} from '../../../@key/key-list.js';
import {
  CardGrid,
  CardPlaceholder,
  CardPreview,
  CardPreviewButton,
} from '../../../@monoid/card-preview.js';
import {
  MonoidScanStatePromptContentHighlight,
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {getPINInputPlaceholder} from '../../../@monoid/pin-input-placeholder.js';
import {AppIcon} from '../../../@ui/app-icon.js';
import {Button, Buttons} from '../../../@ui/button.js';
import {ConfirmPopup} from '../../../@ui/confirm-popup.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../../@ui/details-popup.js';
import {InfoMessage, WarningMessage} from '../../../@ui/message-content.js';
import {OperationComplete} from '../../../@ui/operation-complete.js';
import {OperationSteps, Step} from '../../../@ui/step.js';
import {useToast} from '../../../@ui/toast.js';
import {Toggle} from '../../../@ui/toggle.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderTitle,
  useViewActive,
} from '../../../@view/index.js';
import {
  formatCardResourceCount,
  getCardResourceGroups,
} from '../card-resource-groups.js';
import {readCardAddressPreviews} from '../scan-card.js';

import {CardResourceItem, CardResourceList} from './@resource-item.js';
import {CardSecretPINSession} from './card-secret-pin-session.js';
import {
  type CardSyncProgress,
  authenticateCardSync,
} from './card-sync-session.js';
import {SyncCardsState} from './sync-cards-state.js';

const Description = styled.p`
  margin: 0;
  font-size: 14px;
  line-height: 21px;
  color: var(--color-text-secondary);
`;

function assertSyncCard(
  hello: MonoidAppletHello,
  expected: CardBackupIdentity,
): void {
  assertSameCardWithBundle(hello, expected, 'Card bundle changed, start over');
}

function progressContent(progress: CardSyncProgress): ReactNode {
  const label = {
    reading: 'Reading items',
    exporting: 'Exporting items',
    checking: 'Checking item',
    writing: 'Syncing items',
  }[progress.stage];

  return (
    <MonoidScanStatePromptProgress
      current={progress.current}
      total={progress.total}
    >
      {label}
    </MonoidScanStatePromptProgress>
  );
}

export const SyncCardsView = observer(
  ({view}: RouteComponentProps<Router['safe']['syncCards']>): ReactNode => {
    const {
      router,
      cardStore,
      walletStorageService,
      syncCardsStore,
      cardMaintenanceService,
      errorService,
    } = useEntrances();
    const isViewActive = useViewActive(view);
    const toast = useToast();
    const [flow] = useState(() =>
      syncCardsStore.getOrCreate(
        view.syncId,
        () =>
          new SyncCardsState(
            view.card ? cardStore.get(view.card)?.snapshot() : undefined,
          ),
      ),
    );
    const session = flow.session;
    const maintenance = flow.maintenance;
    const maintenanceTarget =
      maintenance &&
      session.cards.find(card => card.publicKey === maintenance.card.publicKey);
    const pendingPeers = flow.pendingMaintenanceCards;
    const allMaintenanceTargets =
      !!maintenance && flow.maintenanceTargets.length === session.cards.length;
    const collecting = session.phase === 'collect';
    const needsRecoveryExport =
      !!maintenance &&
      !collecting &&
      !pendingPeers.length &&
      !flow.maintenanceSaved;
    const [scanContent, scan] = useMonoidScanPrompt({
      auth: false,
      ensureSetup: false,
      retryOnError: false,
    });
    const [pinInput, showPINInput] = useInputModal();
    const [secretPINs] = useState(() => new CardSecretPINSession());
    const [working, setWorking] = useState(false);
    const [details, setDetails] = useState<string>();
    const [confirmRestart, setConfirmRestart] = useState(false);
    const mounted = useRef(true);
    const operation = useRef<AbortController | undefined>(undefined);
    const busy = working || session.busy;
    const complete =
      (maintenance ? flow.maintenanceSaved : session.phase === 'complete') &&
      !busy;
    const hasIssues = session.cards.some(card => card.issues?.length);
    const activeStep =
      complete && !maintenance && !hasIssues ? 3 : collecting ? 1 : 2;
    const source = !flow.sourceConsumed ? flow.sourceCard : undefined;
    const bundles = [
      ...new Set(
        [...(source ? [source] : []), ...session.cards]
          .map(card => card.bundle)
          .filter(bundle => bundle !== false),
      ),
    ];
    const bundleLabel = (bundle: string | false): string | undefined =>
      bundle === false
        ? undefined
        : bundles.length > 1
          ? `bundle ${bundles.indexOf(bundle) + 1}`
          : 'bundle';
    const selectedCard = session.cards.find(card => card.publicKey === details);
    const backToCard =
      view.card || flow.sourceCard
        ? router.$backTo(router.safe.card.$exact)
        : undefined;
    const back = maintenance
      ? router.$backTo(router.cardApplets.$exact)
      : (backToCard ?? router.$backTo(router.safe.$exact));
    const backLabel = maintenance
      ? 'Back to Card Applets'
      : backToCard
        ? 'Back to Card'
        : 'Back to Safe';

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        operation.current?.abort();
        secretPINs.clear();
      };
    }, [secretPINs]);

    useEffect(
      () =>
        reaction(
          isViewActive,
          active => {
            if (!active) {
              operation.current?.abort();
              secretPINs.clear();
              setDetails(undefined);
              setConfirmRestart(false);
            }
          },
          {fireImmediately: true},
        ),
      [isViewActive, secretPINs],
    );

    useEffect(() => {
      if (complete) secretPINs.clear();
    }, [complete, secretPINs]);

    const run = async (
      callback: (signal: AbortSignal) => Promise<void>,
    ): Promise<void> => {
      if (operation.current || busy || !mounted.current || !isViewActive())
        return;
      const controller = new AbortController();
      operation.current = controller;
      setWorking(true);
      try {
        await callback(controller.signal);
      } catch (error) {
        if (mounted.current && isViewActive()) {
          const cancelled = isOperationCancelled(error);
          if (!cancelled) {
            errorService.catch(Promise.reject(error));
          }
        }
      } finally {
        operation.current = undefined;
        if (mounted.current) setWorking(false);
      }
    };

    const scanCard = async (
      signal: AbortSignal,
      expectedCard?: CardBackupIdentity,
    ): Promise<void> => {
      const expected = expectedCard ?? source;
      const previewCard = view.card ?? flow.sourceCard;
      signal.throwIfAborted();
      if (!mounted.current || !isViewActive()) return;
      await secretPINs.run(
        expected
          ? [expected]
          : collecting
            ? []
            : maintenance
              ? pendingPeers.length && !allMaintenanceTargets
                ? pendingPeers
                : session.cards.filter(
                    card =>
                      flow.needsExport(card.publicKey) ||
                      pendingPeers.includes(card),
                  )
              : session.cards.filter(card => !card.complete),
        (card, pinSignal) =>
          showPINInput(
            {
              type: 'password',
              ...getPINInputPlaceholder('Secret', 'Enter card'),
              description: card?.id,
              center: true,
              maxLength: 16,
            },
            AbortSignal.any([signal, pinSignal]),
          ),
        async (credentials, pinSignal) => {
          await scan(
            expected ? (
              <>
                Scan card{' '}
                <MonoidScanStatePromptContentHighlight>
                  {expected.id}
                </MonoidScanStatePromptContentHighlight>
              </>
            ) : collecting ? (
              'Scan a card'
            ) : needsRecoveryExport ? (
              'Scan a card to export'
            ) : (
              'Scan a pending card'
            ),
            async (
              applet,
              setState,
              hello,
              nativeSignal,
            ): Promise<void | {message: string}> => {
              const activeSignal = AbortSignal.any([
                signal,
                nativeSignal,
                pinSignal,
              ]);
              activeSignal.throwIfAborted();
              const identity = readBackupCardIdentity(hello);
              const scanned = session.cards.find(
                card => card.publicKey === identity.publicKey,
              );
              if (
                !collecting &&
                session.series.hasFinished(identity.publicKey) &&
                !(
                  maintenance &&
                  flow.needsExport(identity.publicKey) &&
                  (needsRecoveryExport || allMaintenanceTargets)
                )
              ) {
                return {message: 'Already synced'};
              }
              const {pin, onAuthenticated} = credentials(identity);
              flow.markInterrupted(identity.publicKey, false);
              const isPreviewCard =
                previewCard?.id === identity.id &&
                previewCard.publicKey === identity.publicKey;
              const knownCard =
                !collecting && isPreviewCard
                  ? cardStore.get(previewCard!)
                  : undefined;
              const knownItems = knownCard
                ? knownCard.items.map(item => ({
                    index: item.index,
                    type: item.type,
                    secret: item.secret,
                    publicKey: item.publicKey,
                    derivations: [
                      ...(item.derivations ?? []),
                      ...Object.values(item.refs).map(
                        ({addressType, seed, curve, path, publicKey}) => ({
                          addressType,
                          seed,
                          curve,
                          path,
                          publicKey,
                        }),
                      ),
                    ],
                  }))
                : flow.sourceCard?.items;
              try {
                setState('Authenticating, hold tight...');
                if (collecting) {
                  await session.add(
                    applet,
                    hello,
                    activeSignal,
                    pin,
                    progress => {
                      setState(progressContent(progress));
                    },
                    onAuthenticated,
                  );
                  if (maintenance && maintenance.phase !== 'manual-restore') {
                    const sessionId = applet.activeSessionId;
                    const information = await readCardInformation(
                      sessionId,
                      activeSignal,
                    );
                    const installed = await readMonoidAppletInstallation(
                      sessionId,
                      activeSignal,
                      {authenticateRegistry: true},
                    );
                    const appletAid = await resolveMonoidAppletMaintenanceAid(
                      sessionId,
                      installed,
                      activeSignal,
                    );
                    const maintenanceApplet = await createMonoidApplet(
                      hexToUint8Array(appletAid),
                    ).openSession(sessionId);
                    await authenticateCardSync(
                      maintenanceApplet,
                      hello,
                      pin,
                      activeSignal,
                    );
                    const candidate = await cardMaintenanceService.prepare(
                      maintenanceApplet,
                      {
                        mode:
                          maintenance.mode === 'update'
                            ? 'update'
                            : 'reinstall',
                        appletAid,
                        cardInformation: information,
                        selectedOptionalStages: Object.entries(
                          installed.optional,
                        ).flatMap(([stage, state]) =>
                          state?.installed || state?.loaded
                            ? [stage as AppletStage]
                            : [],
                        ),
                        signal: activeSignal,
                      },
                    );
                    flow.addMaintenanceCard(
                      candidate,
                      cardMaintenanceService.isUpdateAvailable(hello),
                    );
                  }
                  flow.consumeSource();
                } else {
                  // Completed peers still need a fresh authenticated export;
                  // ordinary Sync intentionally skips auth for no-op writes.
                  if (maintenance && scanned?.complete) {
                    await authenticateCardSync(
                      applet,
                      hello,
                      pin,
                      activeSignal,
                      onAuthenticated,
                    );
                  }
                  await session.write(
                    applet,
                    hello,
                    activeSignal,
                    pin,
                    progress => {
                      setState(progressContent(progress));
                    },
                    onAuthenticated,
                  );
                  if (
                    maintenance &&
                    maintenanceTarget &&
                    (!flow.pendingMaintenanceCards.length ||
                      allMaintenanceTargets) &&
                    flow.needsExport(identity.publicKey)
                  ) {
                    const target = flow.maintenanceTargets.find(
                      target =>
                        target.card.publicKey !== identity.publicKey &&
                        !flow.recoveries.has(target.id),
                    )!;
                    const archive = await session.exportRecovery(
                      applet,
                      hello,
                      session.cards.find(
                        card => card.publicKey === target.card.publicKey,
                      )!,
                      activeSignal,
                      progress => setState(progressContent(progress)),
                      session.cards,
                    );
                    flow.acceptRecovery(archive);
                    const targets = flow.maintenanceTargets;
                    if (
                      targets.every(target => flow.recoveries.has(target.id))
                    ) {
                      try {
                        if (targets.length === 1)
                          await cardMaintenanceService.saveBundleRecovery(
                            maintenance,
                            flow.recoveries.get(maintenance.id)!,
                            activeSignal,
                          );
                        else
                          await cardMaintenanceService.saveBundleRecoveryBatch(
                            targets.map(operation => ({
                              operation,
                              recovery: flow.recoveries.get(operation.id)!,
                            })),
                            activeSignal,
                          );
                        flow.finishMaintenance();
                      } catch (error) {
                        flow.recoveries.clear();
                        throw error;
                      }
                    }
                  }
                }
              } catch (error) {
                flow.markInterrupted(identity.publicKey, true);
                throw error;
              }

              const confirmed = session.confirmedSnapshot;
              if (
                activeSignal.aborted ||
                !mounted.current ||
                !isViewActive() ||
                collecting ||
                maintenance ||
                !isPreviewCard ||
                confirmed?.id !== identity.id ||
                confirmed.publicKey !== identity.publicKey
              )
                return;

              // Confirmed sync progress survives a later address-preview failure.
              setState('Reading addresses, hold tight...');
              const items = await readCardAddressPreviews(
                applet,
                confirmed.items,
                (current, total) => {
                  setState(
                    <MonoidScanStatePromptProgress
                      current={current}
                      total={total}
                    >
                      Reading addresses
                    </MonoidScanStatePromptProgress>,
                  );
                },
                activeSignal,
                knownItems,
                walletStorageService.keys,
              ).catch(error => {
                if (
                  !activeSignal.aborted &&
                  mounted.current &&
                  isViewActive()
                ) {
                  toast({
                    message: 'Card contents saved, address preview unavailable',
                    color: 'warning',
                    position: 'top',
                  });
                }
                if (activeSignal.aborted) throw error;
                return undefined;
              });
              if (items) {
                cardStore.set({...confirmed, items});
              }
            },
            hello => {
              signal.throwIfAborted();
              if (!mounted.current || !isViewActive()) {
                throw Object.assign(new Error('Sync cancelled'), {
                  code: 'CANCELLED',
                });
              }
              if (expected) assertSyncCard(hello, expected);
              if (maintenance && maintenanceTarget) {
                const identity = readBackupCardIdentity(hello);
                if (
                  (collecting &&
                    identity.publicKey === maintenanceTarget.publicKey) ||
                  (!collecting &&
                    flow.deferredCards.has(identity.publicKey) &&
                    !flow.needsExport(identity.publicKey))
                )
                  throw new MonoidCardError('Scan another card in this bundle');
                if (identity.bundle !== maintenanceTarget.bundle)
                  throw new MonoidCardError('Scan a card in the same bundle');
              }
              if (!collecting) {
                const identity = readBackupCardIdentity(hello);
                const target = session.cards.find(
                  card => card.publicKey === identity.publicKey,
                );
                if (!target)
                  throw new MonoidCardError('Scan a card added to this sync');
                assertSyncCard(hello, target);
              }
            },
          );
        },
      );
      // Return only after NFC cleanup. Installation still requires an explicit
      // action on the original Card Applets page.
      if (flow.maintenanceSaved && isViewActive()) back?.();
    };

    const readCard = (expected?: CardBackupIdentity): void => {
      void run(signal => scanCard(signal, expected));
    };
    const prepare = (): void => {
      void run(async () => {
        flow.prepare();
      });
    };
    const placeholders = collecting
      ? Math.max(1, 2 - session.cards.length - (source ? 1 : 0))
      : 0;
    const cards = (
      <CardGrid>
        {source && (
          <CardPreviewButton disabled={busy} onClick={() => readCard(source)}>
            <CardPreview
              id={source.id}
              subtitle={bundleLabel(source.bundle)}
              description="scan to read"
              $pending
            />
          </CardPreviewButton>
        )}
        {session.cards.map(card => (
          <CardPreviewButton
            key={card.publicKey}
            disabled={busy}
            aria-label={`Card ${card.id}`}
            onClick={() => setDetails(card.publicKey)}
          >
            <CardPreview
              id={card.id}
              subtitle={
                collecting &&
                maintenance &&
                flow.maintenanceCards.get(card.publicKey)?.target
                  ? maintenance.mode === 'update'
                    ? 'update'
                    : 'reinstall'
                  : bundleLabel(card.bundle)
              }
              description={
                collecting
                  ? maintenance?.mode === 'update' && card !== maintenanceTarget
                    ? flow.maintenanceCards.get(card.publicKey)
                        ?.updateAvailable === true
                      ? 'update available'
                      : flow.maintenanceCards.get(card.publicKey)
                            ?.updateAvailable === false
                        ? 'up to date'
                        : 'installed version unknown'
                    : `items ${formatCardResourceCount(getCardResourceGroups(card.items))}`
                  : maintenance &&
                      flow.deferredCards.has(card.publicKey) &&
                      !flow.needsExport(card.publicKey)
                    ? 'restore later'
                    : (needsRecoveryExport ||
                          (allMaintenanceTargets && card.complete)) &&
                        flow.needsExport(card.publicKey)
                      ? 'scan to export'
                      : card.complete
                        ? card.issues?.length
                          ? `skipped ${card.issues.length}`
                          : 'synced'
                        : `items ${card.completed}/${card.total}`
              }
              // Dimmed while this card still needs a scan in the current step.
              $pending={
                needsRecoveryExport || (!collecting && allMaintenanceTargets)
                  ? flow.needsExport(card.publicKey)
                  : !collecting &&
                    !flow.deferredCards.has(card.publicKey) &&
                    !card.complete
              }
              $interrupted={
                flow.interruptedCards.has(card.publicKey) ||
                !!card.issues?.length
              }
            />
          </CardPreviewButton>
        ))}
        {Array.from({length: placeholders}, (_, index) => (
          <CardPreviewButton
            key={index}
            disabled={busy}
            aria-label="Add a card"
            onClick={() => readCard()}
          >
            <CardPlaceholder>
              <AppIcon icon={plus} />
            </CardPlaceholder>
          </CardPreviewButton>
        ))}
      </CardGrid>
    );

    return (
      <>
        <View>
          <ViewHeader>
            <ViewHeaderTitle>Sync cards</ViewHeaderTitle>
            {session.cards.length > 0 &&
              !complete &&
              (!maintenance || back) && (
                <ViewHeaderButton
                  disabled={busy}
                  aria-label="Start over"
                  onClick={() => setConfirmRestart(true)}
                >
                  <AppIcon icon={rotateCcw} />
                </ViewHeaderButton>
              )}
          </ViewHeader>
          <ViewContent
            footer={
              complete ? (
                back && (
                  <Button color="neutral" onClick={() => back()}>
                    {backLabel}
                  </Button>
                )
              ) : collecting ? (
                <>
                  {session.cards.length >= 2 &&
                    (session.noSyncRequired && !maintenance ? (
                      back && (
                        <Button
                          color="neutral"
                          disabled={busy}
                          onClick={() => back()}
                        >
                          {backLabel}
                        </Button>
                      )
                    ) : (
                      <Button color="primary" disabled={busy} onClick={prepare}>
                        Continue
                      </Button>
                    ))}
                  <Button
                    color={session.cards.length >= 2 ? 'neutral' : 'primary'}
                    disabled={busy}
                    onClick={() => readCard()}
                  >
                    {source
                      ? 'Scan card'
                      : session.cards.length
                        ? 'Add another card'
                        : 'Add a card'}
                  </Button>
                </>
              ) : (
                <Button
                  color="primary"
                  disabled={busy}
                  onClick={() => readCard()}
                >
                  {needsRecoveryExport
                    ? 'Scan a card to export'
                    : 'Scan a pending card'}
                </Button>
              )
            }
          >
            {flow.stepsExited ? (
              <OperationComplete />
            ) : (
              <OperationSteps
                $exiting={complete && !maintenance && !hasIssues}
                onAnimationEnd={event => {
                  if (
                    complete &&
                    !hasIssues &&
                    !maintenance &&
                    event.target === event.currentTarget
                  )
                    flow.exitSteps();
                }}
              >
                <Step
                  title="Add cards"
                  numero={1}
                  activeNumero={activeStep}
                  processing={busy && collecting}
                >
                  {cards}
                  {maintenance ? (
                    <InfoMessage>
                      {maintenance.phase === 'manual-restore'
                        ? 'Add cards from this bundle to restore items.'
                        : 'Choose the bundle cards to maintain. All recovery archives are saved before installation.'}
                    </InfoMessage>
                  ) : (
                    bundles.length > 0 && (
                      <InfoMessage>
                        Secret items stay within each bundle.
                      </InfoMessage>
                    )
                  )}
                </Step>
                <Step
                  title="Sync cards"
                  numero={2}
                  activeNumero={activeStep}
                  processing={busy && !collecting}
                >
                  {cards}
                  {hasIssues && (
                    <WarningMessage>
                      Some items were skipped. View card details.
                    </WarningMessage>
                  )}
                </Step>
              </OperationSteps>
            )}
          </ViewContent>
        </View>
        {scanContent}
        {pinInput}
        {selectedCard && isViewActive() && (
          <DetailsPopup
            aria-label="Card items"
            onDismiss={() => setDetails(undefined)}
          >
            <DetailsPopupTitle>Card · {selectedCard.id}</DetailsPopupTitle>
            <DetailsPopupDivider />
            <Description title={selectedCard.bundle || undefined}>
              {selectedCard.bundle
                ? `Bundle · ${selectedCard.bundle.slice(0, 8)}`
                : 'Not in a bundle'}
            </Description>
            {collecting &&
              maintenance &&
              maintenance.phase !== 'manual-restore' &&
              selectedCard !== maintenanceTarget &&
              flow.maintenanceCards.has(selectedCard.publicKey) && (
                <>
                  {maintenance.mode === 'update' && (
                    <Description>
                      {flow.maintenanceCards.get(selectedCard.publicKey)!
                        .updateAvailable === true
                        ? 'Update available'
                        : flow.maintenanceCards.get(selectedCard.publicKey)!
                              .updateAvailable === false
                          ? 'Up to date'
                          : 'Installed version unknown'}
                    </Description>
                  )}
                  <Toggle
                    checked={
                      flow.maintenanceCards.get(selectedCard.publicKey)!.target
                    }
                    disabled={busy}
                    onChange={selected =>
                      flow.selectMaintenanceCard(
                        selectedCard.publicKey,
                        selected,
                      )
                    }
                  >
                    {maintenance.mode === 'update'
                      ? 'Update too'
                      : 'Reinstall too'}
                  </Toggle>
                </>
              )}
            {!!selectedCard.issues?.length && (
              <WarningMessage>
                {selectedCard.issues
                  .map(issue => `${issue.index} (${issue.reason})`)
                  .join(', ')}
              </WarningMessage>
            )}
            <CardResourceList $contained data-popup-animation-group>
              {getCardResourceGroups(selectedCard.items).map(({item}) => (
                <CardResourceItem
                  key={item.index}
                  data={item}
                  resources={selectedCard.items}
                />
              ))}
              {!selectedCard.items.length && (
                <KeyListItem>
                  <KeyListPlaceholder>No items</KeyListPlaceholder>
                </KeyListItem>
              )}
            </CardResourceList>
            <Buttons data-popup-animation-group>
              {(collecting
                ? selectedCard !== maintenanceTarget
                : !flow.deferredCards.has(selectedCard.publicKey) ||
                  flow.needsExport(selectedCard.publicKey)) &&
                (collecting ||
                  !selectedCard.complete ||
                  needsRecoveryExport ||
                  (allMaintenanceTargets &&
                    flow.needsExport(selectedCard.publicKey))) && (
                  <Button
                    color="primary"
                    disabled={busy}
                    onClick={() => {
                      setDetails(undefined);
                      readCard(selectedCard);
                    }}
                  >
                    {collecting
                      ? 'Read card'
                      : selectedCard.complete &&
                          flow.needsExport(selectedCard.publicKey)
                        ? 'Export items'
                        : 'Sync card'}
                  </Button>
                )}
              {collecting && selectedCard !== maintenanceTarget && (
                <Button
                  color="neutral"
                  disabled={busy}
                  onClick={() => {
                    session.remove(selectedCard.publicKey);
                    setDetails(undefined);
                  }}
                >
                  Remove card
                </Button>
              )}
            </Buttons>
          </DetailsPopup>
        )}
        {confirmRestart && isViewActive() && (
          <ConfirmPopup
            title="Start over?"
            confirmText="Start over"
            onCancel={() => setConfirmRestart(false)}
            onConfirm={() => {
              setConfirmRestart(false);
              secretPINs.clear();
              flow.restart();
              if (maintenance) back?.();
            }}
          >
            Changes already written to cards will remain.
          </ConfirmPopup>
        )}
      </>
    );
  },
);
