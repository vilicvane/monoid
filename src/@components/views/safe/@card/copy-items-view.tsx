import {
  Check as check,
  CircleAlert as circleAlert,
  CreditCard as creditCard,
  Plus as plus,
  RotateCcw as rotateCcw,
} from 'lucide-react';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import type {CardInformation} from '../../../../@lib/global-platform/card-information.js';
import {
  type CardBackupIdentity,
  type MonoidAppletHello,
  MonoidCardError,
  assertCardPINsNotBlocked,
  assertSameCardWithBundle,
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
import {
  MonoidScanStatePromptContentHighlight,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {getPINInputPlaceholder} from '../../../@monoid/pin-input-placeholder.js';
import {requestCardPINs} from '../../../@monoid/request-card-pins.js';
import {useIsoDepScanPrompt} from '../../../@monoid/use-isodep-scan-prompt.js';
import {AppIcon} from '../../../@ui/app-icon.js';
import {Button, Buttons} from '../../../@ui/button.js';
import {CenteredPopup} from '../../../@ui/centered-popup.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../../@ui/details-popup.js';
import {
  List,
  ListItem,
  ListItemContent,
  ListItemDescription,
  ListItemName,
} from '../../../@ui/list.js';
import {WarningMessage} from '../../../@ui/message-content.js';
import {OperationComplete} from '../../../@ui/operation-complete.js';
import {OperationSteps, Step} from '../../../@ui/step.js';
import {useToast} from '../../../@ui/toast.js';
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
  type CardResourceGroup,
  formatCardResourceCount,
  getCardResourceGroups,
} from '../card-resource-groups.js';

import {CardResourceItem, CardResourceList} from './@resource-item.js';
import {
  type CardBackupItem,
  type CardBackupTarget,
  assertBackupBundle,
  assertBackupCard,
  getBackupCardIdentity,
  initializeBackupTarget,
} from './card-backup-session.js';
import {CardSecretPINSession} from './card-secret-pin-session.js';
import {CopyItemsState} from './copy-items-state.js';
import {readCardForSetup} from './read-card-for-setup.js';

const Description = styled.p`
  margin: 0;
  font-size: 14px;
  line-height: 21px;
  color: var(--color-text-secondary);
`;

const Items = styled(List)`
  --list-item-content-gap: 3px;
  --list-item-gap: 12px;

  flex: 0;

  ${ListItem} {
    align-items: center;
  }

  ${ListItemName} {
    overflow-wrap: anywhere;
  }
`;

const ConflictDescription = styled(ListItemDescription)`
  white-space: normal;
  overflow-wrap: anywhere;
  color: var(--ion-color-warning-shade);
`;

const StatusIcon = styled(AppIcon)<{$done: boolean; $conflict: boolean}>`
  flex-shrink: 0;
  width: 22px;
  font-size: 20px;
  color: ${props =>
    props.$conflict
      ? 'var(--ion-color-warning-shade)'
      : props.$done
        ? 'var(--ion-color-safe)'
        : 'var(--ion-color-primary)'};
`;

function getCopyProgress(
  targets: readonly CardBackupTarget[],
  phase: 'exported' | 'imported',
): string {
  const transfers = targets.flatMap(target => target.items);
  return `${transfers.filter(transfer => transfer[phase]).length}/${transfers.length}`;
}

const CopyProgress = ({
  children,
  value,
}: {
  children: string;
  value: string;
}): ReactNode => (
  <>
    {children}...
    <br />
    <MonoidScanStatePromptContentHighlight>
      {value}
    </MonoidScanStatePromptContentHighlight>
  </>
);

const DestinationCards = ({
  targets,
  groups,
}: {
  targets: CardBackupTarget[];
  groups: CardResourceGroup<CardBackupItem>[];
}): ReactNode => (
  <Items>
    {targets.map(target => {
      const conflicts = groups.filter(group =>
        group.items.some(item =>
          target.items.some(
            transfer => transfer.index === item.index && transfer.conflict,
          ),
        ),
      );
      const done = target.complete;
      return (
        <ListItem key={target.publicKey}>
          <StatusIcon
            icon={conflicts.length ? circleAlert : done ? check : creditCard}
            $done={done}
            $conflict={conflicts.length > 0}
            aria-hidden="true"
          />
          <ListItemContent>
            <ListItemName>{target.id}</ListItemName>
            <ListItemDescription>
              Items · {getCopyProgress([target], 'imported')}
            </ListItemDescription>
            {conflicts.length > 0 && (
              <ConflictDescription>
                Conflicts:{' '}
                {conflicts
                  .map(
                    ({item}) => item.alias || `Item ${item.index.slice(4, 12)}`,
                  )
                  .join(', ')}
              </ConflictDescription>
            )}
          </ListItemContent>
        </ListItem>
      );
    })}
  </Items>
);

export const CopyItemsView = observer(
  ({view}: RouteComponentProps<Router['safe']['copyItems']>): ReactNode => {
    const {
      router,
      errorService,
      monoidApplet,
      monoidCredentialsStore,
      copyItemsStore,
    } = useEntrances();
    const isViewActive = useViewActive(view);
    const toast = useToast();
    const [copyState] = useState(() =>
      copyItemsStore.getOrCreate(
        view.copyId,
        () => new CopyItemsState(view.sourceCard, view.sourceIndexes),
      ),
    );
    const {session, failed, stepsExited, interruptedCards, startedImports} =
      copyState;
    const [pinSession] = useState(() =>
      monoidCredentialsStore.createPINSession(),
    );
    const [secretPINs] = useState(() => new CardSecretPINSession());
    const backup = session.backup;
    const [workingStep, setWorkingStep] = useState<number>();
    const working = workingStep !== undefined;
    const [confirmRestart, setConfirmRestart] = useState(false);
    const [details, setDetails] = useState<'items' | CardBackupIdentity>();
    const [destination, setDestination] = useState<CardBackupIdentity>();
    const [secretPINInput, showSecretPINInput] = useInputModal();
    const [accessPINInput, scanWithAccess] = useMonoidScanPrompt({
      auth: 'access',
      ensureSetup: false,
      pinSession,
    });
    const [scanContent, scan] = useMonoidScanPrompt({
      ensureSetup: false,
    });
    const scanRawDestination = useIsoDepScanPrompt();
    const mounted = useRef(true);
    const running = useRef(false);

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        pinSession.clear();
        secretPINs.clear();
      };
    }, [pinSession, secretPINs]);

    useEffect(
      () =>
        reaction(
          () => !isViewActive(),
          leaving => {
            if (leaving) {
              pinSession.clear();
              secretPINs.clear();
            }
          },
          {fireImmediately: true},
        ),
      [pinSession, secretPINs, isViewActive],
    );

    useEffect(() => {
      if (backup?.complete && !working) {
        pinSession.clear();
        secretPINs.clear();
      }
    }, [backup?.complete, working, pinSession, secretPINs]);

    const selected = backup?.items.filter(item => item.selected) ?? [];
    const selectedGroups = getCardResourceGroups(selected);
    const itemCountLabel = `items ${formatCardResourceCount(selectedGroups)}`;
    const targets = backup?.targets ?? [];
    const transfers = targets.flatMap(target => target.items);
    const exported = transfers.filter(item => item.exported).length;
    const conflicts = transfers.filter(item => item.conflict).length;
    const completedCards = session.series.completedCount;
    const sourceId = backup?.source.id;
    const nextStep = backup?.complete
      ? 5
      : !backup
        ? 1
        : !backup.targetsConfirmed
          ? 2
          : exported < transfers.length
            ? 3
            : 4;
    const step = workingStep ?? nextStep;
    const activeStep = Math.min(step, 4);
    const busy = working || session.busy;
    const complete = backup?.complete && !busy && !failed;
    const destinationsEditable = !!backup && !backup.importStarted;

    useEffect(() => {
      if (!backup?.targetsConfirmed) {
        copyState.clearProgress();
      }
    }, [backup?.targetsConfirmed, copyState]);

    const run = async (operation: () => Promise<void>): Promise<void> => {
      if (
        running.current ||
        session.busy ||
        !mounted.current ||
        !isViewActive()
      )
        return;

      running.current = true;
      setWorkingStep(step);
      copyState.setFailed(false);

      try {
        await operation();
      } catch (error) {
        if (mounted.current) {
          const cancelled = isOperationCancelled(error);
          copyState.setFailed(!cancelled);
          if (!cancelled) errorService.catch(Promise.reject(error));
        }
      } finally {
        running.current = false;
        if (mounted.current) setWorkingStep(undefined);
      }
    };

    const addDestination = async (): Promise<void> => {
      try {
        await scanDestination();
      } catch (error) {
        if (error instanceof MonoidCardError || isOperationCancelled(error))
          return;

        errorService.catch(Promise.reject(error));
      }
    };

    const scanDestination = async (): Promise<void> => {
      let scanned: MonoidAppletHello | undefined;
      let cardInformation: CardInformation | undefined;
      await scanRawDestination(
        'Scan a destination card',
        async (sessionId, setStateContent, signal) => {
          const result = await readCardForSetup(
            sessionId,
            monoidApplet,
            setStateContent,
            signal,
          );
          signal.throwIfAborted();
          if (result.type === 'setup') {
            cardInformation = result.cardInformation;
            return;
          }
          const {hello} = result;
          const identity = readBackupCardIdentity(hello);
          assertBackupBundle(backup!.source, identity);
          if (identity.publicKey === backup!.source.publicKey) {
            throw new MonoidCardError('Use a different card');
          }
          if (targets.some(target => target.publicKey === identity.publicKey)) {
            throw new MonoidCardError('Card already added');
          }
          assertCardPINsNotBlocked(hello);
          scanned = hello;
        },
      );
      if (!mounted.current || !isViewActive()) return;
      if (cardInformation) {
        router
          .cardApplets({cardInformation, returnTo: 'copy', copyId: view.copyId})
          .$push();
        return;
      }
      if (!scanned) return;

      if (scanned.pins.access !== false && scanned.pins.secret !== false) {
        await session.addTarget(scanned);
        return;
      }

      const expected = scanned;
      const identity = readBackupCardIdentity(expected);
      const isNew = expected.pins.secret === false;
      const pinSignal = secretPINs.signal;
      const saved = await pinSession.getPINs(pinSignal);
      if (!mounted.current || !isViewActive() || pinSignal.aborted) return;
      let requested = await requestCardPINs(
        showSecretPINInput,
        {
          secretSet: !isNew,
          accessSet: expected.pins.access !== false,
          savedAccessPIN: saved[uint8ArrayToHex(expected.id)],
        },
        pinSignal,
      );
      let pin = requested?.secret;
      let initializedAccessPIN = false;

      try {
        if (
          pin === undefined ||
          pinSignal.aborted ||
          !mounted.current ||
          !isViewActive()
        )
          return;
        if (!MonoidPIN.is(pin)) {
          toast({
            message: 'Secret PIN must contain 6 to 16 characters',
            color: 'danger',
            position: 'top',
          });
          return;
        }
        const onAuthenticated = secretPINs.onAuthenticated(identity, pin);
        await scan(
          <>
            Scan destination card{' '}
            <MonoidScanStatePromptContentHighlight>
              {identity.id}
            </MonoidScanStatePromptContentHighlight>
          </>,
          async (applet, setState, hello, nativeSignal) => {
            const signal = AbortSignal.any([nativeSignal, pinSignal]);
            const operation = new AbortController();
            const cancel = (): void => operation.abort();
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();
            const stopWatching = reaction(
              () => !isViewActive(),
              leaving => {
                if (leaving) cancel();
              },
              {fireImmediately: true},
            );

            try {
              setState(
                isNew
                  ? 'Setting Secret PIN, hold tight...'
                  : 'Setting Access PIN, hold tight...',
              );
              const initialized = await initializeBackupTarget(
                applet,
                hello,
                expected,
                pin!,
                operation.signal,
                onAuthenticated,
                requested?.access,
              );
              if (expected.pins.access === false) {
                await applet.authenticate({pin: requested!.access!});
                initializedAccessPIN = true;
              }
              await session.addTarget(initialized);
            } finally {
              stopWatching();
              signal.removeEventListener('abort', cancel);
            }
          },
          hello => {
            assertSameCardWithBundle(hello, identity);
          },
        );
      } finally {
        if (
          initializedAccessPIN &&
          requested?.access &&
          !pinSignal.aborted &&
          isViewActive()
        ) {
          try {
            await pinSession.setPIN(
              uint8ArrayToHex(expected.id),
              requested.access,
              pinSignal,
            );
          } catch {
            toast({
              message: 'Access PIN was not saved on this device',
              color: 'warning',
            });
          }
        }
        pin = undefined;
        requested = undefined;
      }
    };

    const backToCard = router.$backTo(router.safe.card.$exact);
    const back = backToCard ?? router.$backTo(router.safe.$exact);
    const backLabel = backToCard ? 'Back to Card' : 'Back to Safe';

    const proceed = async (): Promise<void> => {
      if (!backup) {
        let source: CardBackupIdentity | undefined;

        await scanWithAccess(
          'Scan the source card',
          async (applet, setState, hello, signal) => {
            setState('Reading items, hold tight...');
            await session.readSource(
              applet,
              hello,
              signal,
              copyState.sourceIndexes,
              (current, total) => {
                setState(
                  <CopyProgress value={`${current}/${total}`}>
                    Reading address records
                  </CopyProgress>,
                );
              },
            );
          },
          hello => {
            if (source) {
              assertBackupCard(hello, source);
            } else {
              const identity = getBackupCardIdentity(hello);
              source = identity;
            }
          },
        );
      } else if (!backup.targetsConfirmed && !targets.length) {
        await addDestination();
      } else if (!backup.targetsConfirmed) {
        await session.confirmTargets();
      } else if (exported < transfers.length) {
        try {
          copyState.markInterrupted(backup.source.publicKey, false);
          await secretPINs.run(
            [backup.source],
            (card, pinSignal) =>
              showSecretPINInput(
                {
                  type: 'password',
                  ...getPINInputPlaceholder('Secret', 'Enter source card'),
                  description: card?.id,
                  center: true,
                  maxLength: 16,
                },
                pinSignal,
              ),
            async (credentials, pinSignal) => {
              await scan(
                <>
                  Scan source card{' '}
                  <MonoidScanStatePromptContentHighlight>
                    {backup.source.id}
                  </MonoidScanStatePromptContentHighlight>
                </>,
                async (applet, setState, hello, signal) => {
                  const {pin, onAuthenticated} = credentials(
                    readBackupCardIdentity(hello),
                  );
                  const activeSignal = AbortSignal.any([signal, pinSignal]);
                  setState('Authenticating, hold tight...');
                  await session.exportItems(
                    applet,
                    hello,
                    pin,
                    activeSignal,
                    () => {
                      setState(
                        <CopyProgress
                          value={getCopyProgress(
                            session.backup!.targets,
                            'exported',
                          )}
                        >
                          Exporting items
                        </CopyProgress>,
                      );
                    },
                    onAuthenticated,
                  );
                },
                hello => assertBackupCard(hello, backup.source),
              );
            },
          );
        } catch (error) {
          if (
            session.backup!.targets.some(target =>
              target.items.some(item => !item.exported),
            )
          ) {
            copyState.markInterrupted(backup.source.publicKey, true);
          }
          throw error;
        }
      } else if (!backup.complete) {
        let target: CardBackupTarget | undefined;
        try {
          await secretPINs.run(
            targets.filter(card => !card.complete),
            (card, pinSignal) =>
              showSecretPINInput(
                {
                  type: 'password',
                  ...getPINInputPlaceholder('Secret', 'Enter destination card'),
                  description: card?.id,
                  center: true,
                  maxLength: 16,
                },
                pinSignal,
              ),
            async (credentials, pinSignal) => {
              await scan(
                'Scan a destination card',
                async (applet, setState, hello, signal) => {
                  const {pin, onAuthenticated} = credentials(
                    readBackupCardIdentity(hello),
                  );
                  const activeSignal = AbortSignal.any([signal, pinSignal]);
                  copyState.markInterrupted(target!.publicKey, false);
                  copyState.startImport(target!.publicKey);
                  setState('Authenticating, hold tight...');
                  await session.importItems(
                    applet,
                    hello,
                    pin,
                    activeSignal,
                    () => {
                      setState(
                        <CopyProgress
                          value={getCopyProgress(
                            session.backup!.targets.filter(
                              card => card.publicKey === target!.publicKey,
                            ),
                            'imported',
                          )}
                        >
                          Importing items
                        </CopyProgress>,
                      );
                    },
                    onAuthenticated,
                  );
                },
                hello => {
                  if (target) {
                    assertBackupCard(hello, target);
                    return;
                  }
                  const identity = getBackupCardIdentity(hello);
                  const matched = targets.find(
                    card => card.publicKey === identity.publicKey,
                  );
                  if (!matched) {
                    throw new MonoidCardError(
                      'Scan one of the added destination cards.',
                    );
                  }
                  session.series.assertPending(
                    matched.publicKey,
                    'Already copied to this card',
                  );
                  target = matched;
                },
              );
            },
          );
        } catch (error) {
          const interruptedTarget = session.backup!.targets.find(
            card => card.publicKey === target?.publicKey,
          );
          if (interruptedTarget && !interruptedTarget.complete) {
            copyState.markInterrupted(interruptedTarget.publicKey, true);
          }
          throw error;
        }
      } else {
        back?.();
      }
    };

    const primaryLabel = [
      '',
      'Scan source card',
      targets.length ? 'Continue to export' : 'Scan destination card',
      'Scan source card',
      completedCards ? 'Scan next destination card' : 'Scan a destination card',
      backLabel,
    ][step];

    const sourceCard = (
      <CardGrid>
        <CardPreviewButton
          aria-label={sourceId ? `Source card ${sourceId}` : 'Scan source card'}
          disabled={busy}
          onClick={() => (sourceId ? setDetails('items') : void run(proceed))}
        >
          {sourceId ? (
            <CardPreview
              id={sourceId}
              description={
                step === 3
                  ? `items ${getCopyProgress(targets, 'exported')}`
                  : itemCountLabel
              }
              $interrupted={interruptedCards.has(backup!.source.publicKey)}
            />
          ) : (
            <CardPlaceholder>
              <AppIcon icon={plus} />
            </CardPlaceholder>
          )}
        </CardPreviewButton>
      </CardGrid>
    );

    const destinationCards = (
      <CardGrid>
        {targets.map(target => (
          <CardPreviewButton
            key={target.publicKey}
            aria-label={`Destination card ${target.id}`}
            disabled={busy || (step !== 4 && !destinationsEditable)}
            onClick={() =>
              step === 4 ? setDetails(target) : setDestination(target)
            }
          >
            <CardPreview
              id={target.id}
              description={
                activeStep === 4 && startedImports.has(target.publicKey)
                  ? `items ${getCopyProgress([target], 'imported')}`
                  : undefined
              }
              $interrupted={interruptedCards.has(target.publicKey)}
              $pending={
                activeStep === 4 && !startedImports.has(target.publicKey)
              }
            />
          </CardPreviewButton>
        ))}
        {targets.length === 0 && (
          <CardPreviewButton
            aria-label="Scan a destination card"
            disabled={busy}
            onClick={() => void run(addDestination)}
          >
            <CardPlaceholder>
              <AppIcon icon={plus} />
            </CardPlaceholder>
          </CardPreviewButton>
        )}
      </CardGrid>
    );

    return (
      <>
        <View>
          <ViewHeader>
            <ViewHeaderTitle>Copy items</ViewHeaderTitle>
            {backup && !backup.complete && (
              <ViewHeaderButton
                aria-label="Restart copying"
                disabled={busy}
                onClick={() => setConfirmRestart(true)}
              >
                <AppIcon icon={rotateCcw} />
              </ViewHeaderButton>
            )}
          </ViewHeader>
          <ViewContent
            footer={
              (step < 5 || back) && (
                <>
                  <Button
                    color={step === 5 ? 'neutral' : 'primary'}
                    loading={busy}
                    disabled={!!backup && selected.length === 0}
                    onClick={() => void run(proceed)}
                  >
                    {primaryLabel}
                  </Button>
                  {step === 2 && targets.length > 0 && (
                    <Button
                      color="neutral"
                      disabled={busy}
                      onClick={() => void run(addDestination)}
                    >
                      Scan another card
                    </Button>
                  )}
                </>
              )
            }
          >
            {stepsExited ? (
              <OperationComplete />
            ) : (
              <OperationSteps
                $exiting={!!complete}
                onAnimationEnd={event => {
                  if (complete && event.target === event.currentTarget) {
                    copyState.exitSteps();
                  }
                }}
              >
                <Step
                  title="Choose items"
                  numero={1}
                  activeNumero={activeStep}
                  processing={working && step === 1}
                  summary={step === 2 ? sourceCard : undefined}
                >
                  {sourceCard}
                </Step>
                <Step
                  title="Add destination cards"
                  numero={2}
                  activeNumero={activeStep}
                  processing={working && step === 2}
                >
                  {destinationCards}
                </Step>
                <Step
                  title="Export from source card"
                  numero={3}
                  activeNumero={activeStep}
                  processing={working && step === 3}
                >
                  {sourceCard}
                </Step>
                <Step
                  title="Import to destination cards"
                  numero={4}
                  activeNumero={activeStep}
                  processing={working && step === 4}
                >
                  {destinationCards}
                  {conflicts > 0 && (
                    <WarningMessage>
                      Some items conflict with existing contents. Existing
                      contents were not overwritten. View card details, then
                      retry or start over to choose other cards.
                    </WarningMessage>
                  )}
                </Step>
              </OperationSteps>
            )}
          </ViewContent>
        </View>
        {accessPINInput}
        {scanContent}
        {secretPINInput}
        {details && backup && isViewActive() && (
          <DetailsPopup
            aria-label={
              details === 'items' ? 'Selected items' : 'Import progress'
            }
            onDismiss={() => setDetails(undefined)}
          >
            <DetailsPopupTitle>
              {details === 'items'
                ? `Selected items · ${formatCardResourceCount(selectedGroups)}`
                : 'Import progress'}
            </DetailsPopupTitle>
            <DetailsPopupDivider />
            {details === 'items' ? (
              <CardResourceList $contained data-popup-animation-group>
                {selected.length === 0 && (
                  <ListItemDescription>No items selected.</ListItemDescription>
                )}
                {selectedGroups.map(({item}) => (
                  <CardResourceItem
                    key={item.index}
                    data={item}
                    resources={copyState.sourceCard?.items ?? backup?.items}
                  />
                ))}
              </CardResourceList>
            ) : (
              <DestinationCards
                targets={targets.filter(
                  target => target.publicKey === details.publicKey,
                )}
                groups={selectedGroups}
              />
            )}
            {details !== 'items' && (
              <Buttons data-popup-animation-group>
                <Button onClick={() => setDetails(undefined)}>Done</Button>
              </Buttons>
            )}
          </DetailsPopup>
        )}
        {destination && destinationsEditable && isViewActive() && (
          <CenteredPopup
            aria-label={`Destination card ${destination.id}`}
            onDismiss={() => setDestination(undefined)}
          >
            <Button
              color="danger"
              disabled={busy}
              onClick={() => {
                setDestination(undefined);
                void run(() => session.removeTarget(destination.publicKey));
              }}
            >
              Remove
            </Button>
          </CenteredPopup>
        )}
        {confirmRestart && (
          <CenteredPopup
            aria-label="Restart copying"
            onDismiss={() => setConfirmRestart(false)}
          >
            <DetailsPopupTitle>Restart copying?</DetailsPopupTitle>
            <Description>
              Choose the destination cards again. Items already copied to the
              destination cards will remain.
            </Description>
            <Buttons data-popup-animation-group>
              <Button
                color="danger"
                onClick={() => {
                  setConfirmRestart(false);
                  void run(async () => {
                    pinSession.clear();
                    secretPINs.clear();
                    await copyState.restart();
                  });
                }}
              >
                Start over
              </Button>
              <Button color="neutral" onClick={() => setConfirmRestart(false)}>
                Cancel
              </Button>
            </Buttons>
          </CenteredPopup>
        )}
      </>
    );
  },
);
