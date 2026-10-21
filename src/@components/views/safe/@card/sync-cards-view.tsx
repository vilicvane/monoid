import {Plus as plus, RotateCcw as rotateCcw} from 'lucide-react';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import {
  type MonoidAppletHello,
  MonoidCardError,
  MonoidWrongCardError,
} from '../../../../@lib/monoid/index.js';
import type {Router} from '../../../../@routes.js';
import {isCredentialRequestCancelled} from '../../../../@services/index.js';
import {popOutAnimationCSS} from '../../../@animations.js';
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
import {InfoMessage} from '../../../@ui/message-content.js';
import {OperationComplete} from '../../../@ui/operation-complete.js';
import {Step, Steps} from '../../../@ui/step.js';
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
  formatCardResourceCount,
  getCardResourceGroups,
} from '../card-resource-groups.js';
import {readCardAddressPreviews} from '../scan-card.js';

import {CardResourceItem, CardResourceList} from './@resource-item.js';
import {
  type CardBackupIdentity,
  readBackupCardIdentity,
} from './card-backup-session.js';
import type {CardSyncProgress} from './card-sync-session.js';
import {SyncCardsState} from './sync-cards-state.js';

const Description = styled.p`
  margin: 0;
  font-size: 14px;
  line-height: 21px;
  color: var(--color-text-secondary);
`;

const SyncSteps = styled(Steps)<{$exiting: boolean}>`
  ${props => props.$exiting && popOutAnimationCSS}

  @media (prefers-reduced-motion: reduce) {
    animation-duration: 1ms;
  }
`;

function assertSyncCard(
  hello: MonoidAppletHello,
  expected: CardBackupIdentity,
): void {
  const identity = readBackupCardIdentity(hello);
  if (
    identity.publicKey !== expected.publicKey ||
    identity.id !== expected.id
  ) {
    throw new MonoidWrongCardError(expected.id);
  }
  if (identity.bundle !== expected.bundle) {
    throw new MonoidCardError('Card bundle changed, start over');
  }
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
    const collecting = session.phase === 'collect';
    const [scanContent, scan] = useMonoidScanPrompt({
      auth: false,
      ensureSetup: false,
      retryOnError: false,
    });
    const [pinInput, showPINInput] = useInputModal();
    const [working, setWorking] = useState(false);
    const [details, setDetails] = useState<string>();
    const [confirmRestart, setConfirmRestart] = useState(false);
    const mounted = useRef(true);
    const operation = useRef<AbortController | undefined>(undefined);
    const busy = working || session.busy;
    const complete = session.phase === 'complete' && !busy;
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
    const back = backToCard ?? router.$backTo(router.safe.$exact);
    const backLabel = backToCard ? 'Back to Card' : 'Back to Safe';

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        operation.current?.abort();
      };
    }, []);

    useEffect(
      () =>
        reaction(
          isViewActive,
          active => {
            if (!active) {
              operation.current?.abort();
              setDetails(undefined);
              setConfirmRestart(false);
            }
          },
          {fireImmediately: true},
        ),
      [isViewActive],
    );

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
          const cancelled =
            isCredentialRequestCancelled(error) ||
            (error instanceof Error && error.name === 'AbortError');
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
      let pin: string | undefined;

      try {
        signal.throwIfAborted();
        if (!mounted.current || !isViewActive()) return;
        pin = await showPINInput({
          type: 'password',
          ...getPINInputPlaceholder('Secret', 'Enter card'),
          description: expected?.id,
          center: true,
          maxLength: 16,
        });
        if (
          pin === undefined ||
          signal.aborted ||
          !mounted.current ||
          !isViewActive()
        )
          return;
        if (!MonoidPIN.is(pin)) {
          throw new MonoidCardError(
            'Secret PIN must contain 6 to 16 characters',
          );
        }
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
          ) : (
            'Scan a pending card'
          ),
          async (
            applet,
            setState,
            hello,
            nativeSignal,
          ): Promise<void | {message: string}> => {
            const activeSignal = AbortSignal.any([signal, nativeSignal]);
            activeSignal.throwIfAborted();
            const identity = readBackupCardIdentity(hello);
            if (
              !collecting &&
              session.cards.some(
                card => card.publicKey === identity.publicKey && card.complete,
              )
            ) {
              return {message: 'Already synced'};
            }
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
            // Confirmed writes invalidate cached previews, including an ACK
            // received after the owning view unmounts. Progress stays in session.
            const stopObservingWrites = collecting
              ? undefined
              : reaction(
                  () => session.confirmedSnapshot,
                  snapshot => {
                    if (
                      snapshot?.id === identity.id &&
                      snapshot.publicKey === identity.publicKey
                    ) {
                      cardStore.forget(snapshot);
                    }
                  },
                );
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
                );
                flow.consumeSource();
              } else {
                await session.write(
                  applet,
                  hello,
                  activeSignal,
                  pin,
                  progress => {
                    setState(progressContent(progress));
                  },
                );
              }
            } catch (error) {
              flow.markInterrupted(identity.publicKey, true);
              throw error;
            } finally {
              stopObservingWrites?.();
            }

            const confirmed = session.confirmedSnapshot;
            if (
              activeSignal.aborted ||
              !mounted.current ||
              !isViewActive() ||
              collecting ||
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
              if (!activeSignal.aborted && mounted.current && isViewActive()) {
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
      } finally {
        pin = undefined;
      }
    };

    const readCard = (expected?: CardBackupIdentity): void => {
      void run(signal => scanCard(signal, expected));
    };
    const prepare = (): void => {
      void run(async () => {
        session.prepare();
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
              subtitle={bundleLabel(card.bundle)}
              description={
                collecting
                  ? `items ${formatCardResourceCount(getCardResourceGroups(card.items))}`
                  : card.complete
                    ? 'synced'
                    : `items ${card.completed}/${card.total}`
              }
              $pending={!collecting && !card.completed && !card.complete}
              $interrupted={flow.interruptedCards.has(card.publicKey)}
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
            {session.cards.length > 0 && !complete && (
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
                    (session.noSyncRequired ? (
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
                  Scan a pending card
                </Button>
              )
            }
          >
            {flow.stepsExited ? (
              <OperationComplete />
            ) : (
              <SyncSteps
                $exiting={complete}
                onAnimationEnd={event => {
                  if (complete && event.target === event.currentTarget)
                    flow.exitSteps();
                }}
              >
                <Step
                  title="Add cards"
                  numero={1}
                  activeNumero={complete ? 3 : collecting ? 1 : 2}
                  processing={busy && collecting}
                >
                  {cards}
                  {bundles.length > 0 && (
                    <InfoMessage>
                      Secret items stay within each bundle.
                    </InfoMessage>
                  )}
                </Step>
                <Step
                  title="Sync cards"
                  numero={2}
                  activeNumero={complete ? 3 : collecting ? 1 : 2}
                  processing={busy && !collecting}
                >
                  {cards}
                </Step>
              </SyncSteps>
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
            <CardResourceList $contained data-popup-animation-group>
              {getCardResourceGroups(selectedCard.items).map(({item}) => (
                <CardResourceItem
                  key={item.index}
                  data={item}
                  resources={selectedCard.items}
                />
              ))}
              {!selectedCard.items.length && (
                <Description>No items</Description>
              )}
            </CardResourceList>
            <Buttons data-popup-animation-group>
              {(collecting || !selectedCard.complete) && (
                <Button
                  color="primary"
                  disabled={busy}
                  onClick={() => {
                    setDetails(undefined);
                    readCard(selectedCard);
                  }}
                >
                  {collecting ? 'Read card' : 'Sync card'}
                </Button>
              )}
              {collecting && (
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
              flow.restart();
            }}
          >
            Changes already written to cards will remain.
          </ConfirmPopup>
        )}
      </>
    );
  },
);
