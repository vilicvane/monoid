import {
  Check as check,
  CircleAlert as circleAlert,
  CreditCard as creditCard,
  Plus as plus,
  RotateCcw as rotateCcw,
  X as x,
} from 'lucide-react';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import {
  type MonoidAppletHelloWithSafe,
  MonoidCardError,
  MonoidWrongCardError,
} from '../../../../@lib/monoid/index.js';
import type {Router} from '../../../../@routes.js';
import {isCredentialRequestCancelled} from '../../../../@services/index.js';
import {MonoidCard, MonoidCardFrame} from '../../../@monoid/monoid-card.js';
import {
  MonoidScanStatePromptContentHighlight,
  MonoidScanStatePromptProgress,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {AppIcon} from '../../../@ui/app-icon.js';
import {Button, Buttons} from '../../../@ui/button.js';
import {CenteredPopup} from '../../../@ui/centered-popup.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../../@ui/details-popup.js';
import {IconButton} from '../../../@ui/icon-button.js';
import {InfoSection} from '../../../@ui/info-section.js';
import {
  List,
  ListItem,
  ListItemContent,
  ListItemDescription,
  ListItemName,
} from '../../../@ui/list.js';
import {Step, Steps} from '../../../@ui/step.js';
import {useToast} from '../../../@ui/toast.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderTitle,
} from '../../../@view/index.js';

import {CardResourceItem, CardResourceList} from './@resource-item.js';
import {
  type CardBackupIdentity,
  type CardBackupItem,
  CardBackupSession,
  type CardBackupTarget,
  assertBackupCard,
  getBackupCardIdentity,
  initializeBackupTarget,
  readBackupCardIdentity,
} from './card-backup-session.js';

const Description = styled.p`
  margin: 0;
  font-size: 14px;
  line-height: 21px;
  color: var(--color-text-secondary);
`;

const Notice = styled.div`
  margin: 8px 0;
  padding: 12px;
  border-radius: 10px;
  background: var(--ion-color-light);
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 21px;

  &[role='alert'] {
    color: var(--ion-color-danger-shade);
  }
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

const DetailButton = styled.button`
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ion-color-primary);
  font: inherit;
  line-height: 22px;
  text-align: left;
  cursor: pointer;

  &:disabled {
    color: var(--color-text-secondary);
    cursor: default;
  }
`;

const CardGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
  max-width: 300px;
`;

const CardPreviewButton = styled.button`
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--ion-color-dark);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:disabled {
    cursor: default;
  }

  &:focus-visible {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: 3px;
  }
`;

const CardPreview = styled(MonoidCard)`
  --monoid-card-logo-width: calc(72 / 430 * 100%);

  box-shadow: inset 0 0 0 0.5px var(--ion-color-medium-tint);
`;

const CardPlaceholder = styled(MonoidCardFrame)`
  --monoid-card-background: var(--ion-color-light);

  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  border: 0.5px solid var(--ion-color-light-shade);
  color: var(--ion-color-light-shade);
  font-size: 24px;
  text-align: center;
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

const DestinationCards = ({
  targets,
  items,
  busy,
  onRemove,
  progress,
}: {
  targets: CardBackupTarget[];
  items: CardBackupItem[];
  busy: boolean;
  onRemove?: (publicKey: string) => void;
  progress?: 'export' | 'import';
}): ReactNode => (
  <Items>
    {targets.map(target => {
      const copied = target.items.filter(item => item.imported).length;
      const exported = target.items.filter(item => item.exported).length;
      const conflicts =
        progress === 'import' ? target.items.filter(item => item.conflict) : [];
      const done =
        progress === 'export'
          ? exported === target.items.length
          : target.complete;
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
            {progress && (
              <ListItemDescription>
                {progress === 'export' ? exported : copied} of{' '}
                {target.items.length} items{' '}
                {progress === 'export' ? 'exported' : 'copied'}
              </ListItemDescription>
            )}
            {conflicts.length > 0 && (
              <ConflictDescription>
                Conflicts:{' '}
                {conflicts
                  .map(transfer => {
                    const item = items.find(
                      item => item.index === transfer.index,
                    )!;
                    return item.alias || `Item ${item.index.slice(4, 12)}`;
                  })
                  .join(', ')}
              </ConflictDescription>
            )}
          </ListItemContent>
          {onRemove && (
            <IconButton
              aria-label={`Remove destination card ${target.id}`}
              disabled={busy}
              onClick={() => onRemove(target.publicKey)}
            >
              <AppIcon icon={x} />
            </IconButton>
          )}
        </ListItem>
      );
    })}
  </Items>
);

export const BackupCardView = observer(
  ({view}: RouteComponentProps<Router['safe']['backupCard']>): ReactNode => {
    const {router, errorService} = useEntrances();
    const toast = useToast();
    const [session] = useState(
      () => new CardBackupSession(view.sourceCard, view.sourceIndexes),
    );
    const backup = session.backup;
    const [working, setWorking] = useState(false);
    const [notice, setNotice] = useState<string>();
    const [failed, setFailed] = useState(false);
    const [confirmRestart, setConfirmRestart] = useState(false);
    const [details, setDetails] = useState<
      'items' | 'destinations' | 'exports' | 'imports'
    >();
    const [safePINInput, showSafePINInput] = useInputModal();
    const [accessPINInput, scanWithAccess] = useMonoidScanPrompt({
      safe: true,
      auth: 'access',
      ensureSetup: false,
    });
    const [scanContent, scan] = useMonoidScanPrompt({
      safe: true,
      ensureSetup: false,
    });
    const mounted = useRef(true);
    const running = useRef(false);

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);

    const selected = backup?.items.filter(item => item.selected) ?? [];
    const selectedLabel = `${selected.length} ${selected.length === 1 ? 'item' : 'items'} selected`;
    const targets = backup?.targets ?? [];
    const transfers = targets.flatMap(target => target.items);
    const exported = transfers.filter(item => item.exported).length;
    const imported = transfers.filter(item => item.imported).length;
    const conflicts = transfers.filter(item => item.conflict).length;
    const completedCards = targets.filter(target => target.complete).length;
    const sourceId = backup?.source.id;
    const step = backup?.complete
      ? 5
      : !backup
        ? 1
        : !backup.targetsConfirmed
          ? 2
          : exported < transfers.length
            ? 3
            : 4;
    const busy = working || session.busy;
    const destinationsEditable = !!backup && !backup.importStarted;
    const operationNotice = notice && (
      <Notice role={failed ? 'alert' : 'status'}>{notice}</Notice>
    );

    const run = async (operation: () => Promise<void>): Promise<void> => {
      if (running.current || session.busy) return;

      running.current = true;
      setWorking(true);
      setNotice(undefined);
      setFailed(false);

      try {
        await operation();
      } catch (error) {
        if (mounted.current) {
          const cancelled =
            isCredentialRequestCancelled(error) ||
            (error instanceof Error && error.name === 'AbortError');
          setFailed(!cancelled);
          setNotice(
            cancelled
              ? 'Interrupted. You can continue on this page.'
              : `${error instanceof Error ? error.message : 'Copy interrupted.'} Try again to continue.`,
          );
        }
      } finally {
        running.current = false;
        if (mounted.current) setWorking(false);
      }
    };

    const addDestination = async (): Promise<void> => {
      try {
        await scanDestination();
      } catch (error) {
        if (
          error instanceof MonoidCardError ||
          isCredentialRequestCancelled(error) ||
          (error instanceof Error && error.name === 'AbortError')
        )
          return;

        errorService.catch(Promise.reject(error));
      }
    };

    const scanDestination = async (): Promise<void> => {
      let uninitialized: MonoidAppletHelloWithSafe | undefined;
      await scan(
        'Scan a destination card',
        async (_applet, _setState, hello) => {
          const identity = readBackupCardIdentity(hello);
          if (identity.publicKey === backup!.source.publicKey) {
            throw new MonoidCardError('Use a different card');
          }
          if (targets.some(target => target.publicKey === identity.publicKey)) {
            throw new MonoidCardError('Card already added');
          }
          if (hello.safe.pin === 0)
            throw new MonoidCardError('Safe PIN blocked');
          if (hello.pin === 0) throw new MonoidCardError('Access PIN blocked');
          if (
            hello.pin === false ||
            hello.safe.pin === false ||
            !hello.safe.unlocked
          ) {
            uninitialized = hello;
          } else {
            await session.addTarget(hello);
          }
        },
      );
      if (
        !uninitialized ||
        !mounted.current ||
        view.$leaving ||
        !view.$match.$exact.$active
      )
        return;

      const expected = uninitialized;
      const identity = readBackupCardIdentity(expected);
      const isNew = expected.safe.pin === false;
      let pin = await showSafePINInput({
        type: 'password',
        placeholder: isNew ? 'Set Safe PIN' : 'Enter existing Safe PIN',
        description:
          expected.pin === false
            ? 'Will be used as initial Access PIN'
            : 'Access PIN stays the same',
        center: true,
        maxLength: 16,
      });

      try {
        if (
          pin === undefined ||
          !mounted.current ||
          view.$leaving ||
          !view.$match.$exact.$active
        )
          return;
        if (!MonoidPIN.is(pin)) {
          toast({
            message: 'Safe PIN must contain 6 to 16 characters',
            color: 'danger',
            position: 'top',
          });
          return;
        }
        await scan(
          <>
            Scan destination card{' '}
            <MonoidScanStatePromptContentHighlight>
              {identity.id}
            </MonoidScanStatePromptContentHighlight>
          </>,
          async (applet, setState, hello, signal) => {
            const operation = new AbortController();
            const cancel = (): void => operation.abort();
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();
            const stopWatching = reaction(
              () => !!view.$leaving || !view.$match.$exact.$active,
              leaving => {
                if (leaving) cancel();
              },
              {fireImmediately: true},
            );

            try {
              setState(isNew ? 'Setting Safe PIN...' : 'Unlocking safe...');
              const initialized = await initializeBackupTarget(
                applet,
                hello,
                expected,
                pin!,
                operation.signal,
              );
              await session.addTarget(initialized);
            } finally {
              stopWatching();
              signal.removeEventListener('abort', cancel);
            }
          },
          hello => {
            if (
              readBackupCardIdentity(hello).publicKey !== identity.publicKey
            ) {
              throw new MonoidWrongCardError(identity.id);
            }
          },
        );
      } finally {
        pin = undefined;
      }
    };

    const backToSafe = (): void => {
      const back = router.$backTo(router.safe.$exact);
      if (back) {
        back();
      } else {
        router.safe.$replace();
      }
    };

    const proceed = async (): Promise<void> => {
      if (!backup) {
        let source: CardBackupIdentity | undefined;

        await scanWithAccess(
          'Scan the source card',
          async (applet, setState, hello, signal) => {
            setState('Reading items...');
            await session.readSource(applet, hello, signal, view.sourceIndexes);
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
        let pin = await showSafePINInput({
          type: 'password',
          placeholder: 'Enter source card Safe PIN',
          center: true,
          maxLength: 16,
        });

        if (
          !mounted.current ||
          view.$leaving ||
          !view.$match.$exact.$active ||
          pin === undefined
        )
          return;
        if (!MonoidPIN.is(pin)) {
          throw new MonoidCardError(
            'Safe PIN must contain 6 to 16 characters.',
          );
        }

        try {
          await scan(
            <>
              Scan source card{' '}
              <MonoidScanStatePromptContentHighlight>
                {backup.source.id}
              </MonoidScanStatePromptContentHighlight>
            </>,
            async (applet, setState, hello, signal) => {
              setState('Authenticating with Safe PIN...');
              await session.exportItems(
                applet,
                hello,
                pin!,
                signal,
                (current, total) => {
                  setState(
                    <MonoidScanStatePromptProgress
                      current={current}
                      total={total}
                      showCount
                    >
                      Exporting items
                    </MonoidScanStatePromptProgress>,
                  );
                },
              );
            },
            hello => assertBackupCard(hello, backup.source),
          );
        } finally {
          pin = undefined;
        }
      } else if (!backup.complete) {
        let target: CardBackupTarget | undefined;
        await scanWithAccess(
          'Scan a destination card',
          async (applet, setState, hello, signal) => {
            await session.importItems(
              applet,
              hello,
              signal,
              (current, total) => {
                setState(
                  <MonoidScanStatePromptProgress
                    current={current}
                    total={total}
                    showCount
                  >
                    Importing items
                  </MonoidScanStatePromptProgress>,
                );
              },
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
            if (matched.complete) {
              throw new MonoidCardError('Already copied to this card');
            }
            target = matched;
          },
        );

        if (
          session.backup?.complete &&
          mounted.current &&
          !view.$leaving &&
          view.$match.$exact.$active
        ) {
          backToSafe();
        }
      } else {
        backToSafe();
      }
    };

    const primaryLabel = [
      '',
      'Scan source card',
      targets.length ? 'Continue to export' : 'Scan destination card',
      'Scan source card',
      completedCards ? 'Scan next destination card' : 'Scan a destination card',
      'Done',
    ][step];

    const sourceCardSummary = (
      <InfoSection>
        <CardGrid>
          <CardPreviewButton
            aria-label={
              sourceId ? `Source card ${sourceId}` : 'Scan source card'
            }
            disabled={busy}
            onClick={() => (sourceId ? setDetails('items') : void run(proceed))}
          >
            {sourceId ? (
              <CardPreview id={sourceId} />
            ) : (
              <CardPlaceholder>
                <AppIcon icon={plus} />
              </CardPlaceholder>
            )}
          </CardPreviewButton>
        </CardGrid>
        {sourceId && (
          <DetailButton disabled={busy} onClick={() => setDetails('items')}>
            {selectedLabel}
          </DetailButton>
        )}
      </InfoSection>
    );

    const destinationCardsSummary = (
      <InfoSection>
        <CardGrid>
          {targets.map(target => (
            <CardPreviewButton
              key={target.publicKey}
              aria-label={`Destination card ${target.id}`}
              disabled={busy}
              onClick={() => setDetails('destinations')}
            >
              <CardPreview id={target.id} />
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
        {targets.length > 0 && (
          <DetailButton
            disabled={busy}
            onClick={() => setDetails('destinations')}
          >
            {targets.length}{' '}
            {targets.length === 1 ? 'destination card' : 'destination cards'}
          </DetailButton>
        )}
      </InfoSection>
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
              <>
                <Button
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
            }
          >
            <Steps>
              <Step
                title="Choose items"
                numero={1}
                activeNumero={step}
                processing={working && step === 1}
                summary={sourceCardSummary}
              >
                {sourceCardSummary}
                <span>
                  Scan the source card{sourceId && ` ${sourceId}`} to choose
                  items to copy.
                </span>
                <span>The source card stays unchanged.</span>
                {operationNotice}
              </Step>
              <Step
                title="Add destination cards"
                numero={2}
                activeNumero={step}
                processing={working && step === 2}
                summary={destinationCardsSummary}
              >
                {destinationCardsSummary}
                Scan one or more destination cards.
              </Step>
              <Step
                title="Export from source card"
                numero={3}
                activeNumero={step}
                processing={working && step === 3}
                summary={
                  <DetailButton
                    disabled={busy}
                    onClick={() => setDetails('exports')}
                  >
                    {selected.length} items exported for {targets.length}{' '}
                    {targets.length === 1 ? 'card' : 'cards'}
                  </DetailButton>
                }
              >
                Enter the Safe PIN for source card {sourceId}, then hold it
                against your phone to export for all destination cards.
                {exported > 0 && (
                  <DetailButton
                    disabled={busy}
                    onClick={() => setDetails('exports')}
                  >
                    {exported} of {transfers.length} exports ready.
                  </DetailButton>
                )}
                {operationNotice}
              </Step>
              <Step
                title="Import to destination cards"
                numero={4}
                activeNumero={step}
                processing={working && step === 4}
                summary={
                  <DetailButton
                    disabled={busy}
                    onClick={() => setDetails('imports')}
                  >
                    Copy complete · {completedCards}{' '}
                    {completedCards === 1 ? 'card' : 'cards'}
                  </DetailButton>
                }
              >
                Scan each destination card in any order and hold it against your
                phone until importing finishes. You’ll need that card’s Access
                PIN.
                <DetailButton
                  disabled={busy}
                  onClick={() => setDetails('imports')}
                >
                  {imported} of {transfers.length} items copied
                  <br />
                  {completedCards} of {targets.length} cards complete
                </DetailButton>
                {conflicts > 0 && (
                  <Notice role="status">
                    Some items conflict with existing contents. Existing
                    contents were not overwritten. View card details, then retry
                    or start over to choose other cards.
                  </Notice>
                )}
                {operationNotice}
              </Step>
            </Steps>
          </ViewContent>
        </View>
        {accessPINInput}
        {scanContent}
        {safePINInput}
        {details && backup && view.$match.$exact.$active && !view.$leaving && (
          <DetailsPopup
            aria-label={
              details === 'items'
                ? 'Selected items'
                : details === 'exports'
                  ? 'Export progress'
                  : details === 'imports'
                    ? 'Import progress'
                    : 'Destination cards'
            }
            onDismiss={() => setDetails(undefined)}
          >
            <DetailsPopupTitle>
              {details === 'items'
                ? selectedLabel
                : details === 'exports'
                  ? 'Export progress'
                  : details === 'imports'
                    ? 'Import progress'
                    : 'Destination cards'}
            </DetailsPopupTitle>
            <DetailsPopupDivider />
            {destinationsEditable &&
              exported > 0 &&
              details === 'destinations' && (
                <Description>
                  Changes require scanning the source card again.
                </Description>
              )}
            {details === 'items' ? (
              <CardResourceList $contained data-popup-animation-group>
                {selected.length === 0 && (
                  <ListItemDescription>No items selected.</ListItemDescription>
                )}
                {selected.map(item => (
                  <CardResourceItem key={item.index} data={item} />
                ))}
              </CardResourceList>
            ) : (
              <DestinationCards
                targets={targets}
                items={selected}
                busy={busy}
                progress={
                  details === 'exports'
                    ? 'export'
                    : details === 'imports'
                      ? 'import'
                      : undefined
                }
                onRemove={
                  destinationsEditable && details === 'destinations'
                    ? publicKey =>
                        void run(() => session.removeTarget(publicKey))
                    : undefined
                }
              />
            )}
            {details !== 'items' && (
              <Buttons data-popup-animation-group>
                {destinationsEditable && details === 'destinations' && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setDetails(undefined);
                      void run(addDestination);
                    }}
                  >
                    Scan another card
                  </Button>
                )}
                <Button onClick={() => setDetails(undefined)}>Done</Button>
              </Buttons>
            )}
          </DetailsPopup>
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
                    await session.reset(view.sourceCard, view.sourceIndexes);
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
