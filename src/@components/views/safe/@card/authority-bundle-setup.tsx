import {List as list} from 'lucide-react';
import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import {
  AuthorityError,
  type AuthorityGroup,
  type AuthorityNamespace,
  validateAuthorityBundleName,
} from '../../../../@lib/authority-client.js';
import type {CardInformation} from '../../../../@lib/global-platform/card-information.js';
import {
  MonoidAppletHello,
  assertSameCard,
  cardName,
  readBackupCardIdentity,
} from '../../../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../../../@lib/operation-cancelled.js';
import type {Router} from '../../../../@routes.js';
import {
  CardGrid,
  CardPlaceholder,
  CardPreview,
  CardPreviewButton,
} from '../../../@monoid/card-preview.js';
import {scanCardPrompt} from '../../../@monoid/monoid-scan-prompt.js';
import {getPINInputPlaceholder} from '../../../@monoid/pin-input-placeholder.js';
import {useIsoDepScanPrompt} from '../../../@monoid/use-isodep-scan-prompt.js';
import {AuthorityAccountInfo} from '../../../@ui/authority-account.js';
import {Button, Buttons} from '../../../@ui/button.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../../../@ui/details-popup.js';
import {EllipsisInMiddle} from '../../../@ui/ellipsis-in-middle.js';
import {
  InfoSection,
  InfoSectionHeader,
  InfoSectionItemLabel,
} from '../../../@ui/info-section.js';
import {InputWithAction} from '../../../@ui/input.js';
import {
  List,
  ListItemButton,
  ListItemContent,
  ListItemDescription,
  ListItemName,
} from '../../../@ui/list.js';
import {InfoMessage} from '../../../@ui/message-content.js';
import {OperationComplete} from '../../../@ui/operation-complete.js';
import {RippleEffect} from '../../../@ui/ripple-effect.js';
import {SegmentedControl} from '../../../@ui/segmented-control.js';
import {OperationSteps, Step} from '../../../@ui/step.js';
import {Toggle} from '../../../@ui/toggle.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';
import {ViewContent, useViewActive} from '../../../@view/index.js';

import type {
  AuthorityBundleCard,
  AuthorityBundleSession,
} from './authority-bundle-session.js';
import type {CardResetIdentity} from './card-reset-session.js';
import {useBundleCardAddition} from './use-bundle-card-addition.js';

// Use the recipient picker's full-bleed list layout inside DetailsPopup.
const Bundles = styled(InfoSection)`
  container-type: inline-size;
  --ion-color-dark: white;
  --color-text-secondary: var(--color-text-label);
  --view-padding: calc((100vw - 100cqw) / 2);
  --list-item-padding-inline: var(--view-padding);
  --bundle-safe-offset: calc(
    (var(--view-inset-left) - var(--view-inset-right)) / 2
  );

  ${List} {
    margin-left: calc(-1 * var(--view-padding) - var(--bundle-safe-offset));
    margin-right: calc(-1 * var(--view-padding) + var(--bundle-safe-offset));
  }

  ${ListItemButton} {
    padding-left: calc(var(--view-padding) + var(--bundle-safe-offset));
    padding-right: calc(var(--view-padding) - var(--bundle-safe-offset));
  }

  ${ListItemName} {
    overflow-wrap: anywhere;
  }
`;

const BundlePath = styled.span`
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const BundleOwnerAddress = styled(EllipsisInMiddle)`
  display: inline-flex;
  width: 13ch;
  vertical-align: bottom;
`;

export const AuthorityBundleSetup = observer(function AuthorityBundleSetup({
  children,
  view,
  session,
}: {
  children?: ReactNode;
  view: RouteComponentProps<Router['safe']['setupCard']>['view'];
  session: AuthorityBundleSession;
}): ReactNode {
  const {
    authorityService: authority,
    errorService,
    router,
    cardStore,
    monoidApplet,
  } = useEntrances();
  const isViewActive = useViewActive(view);
  const secretPINSession = session.secretPINs;
  const chosen = session.choice;
  const [working, setWorking] = useState(false);
  const [stepsExited, setStepsExited] = useState(session.complete);
  const [pinInput, showPINInput] = useInputModal();
  const scan = useIsoDepScanPrompt();
  const operation = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const installing = useRef(false);
  const isActive = useCallback(
    () => mounted.current && isViewActive(),
    [isViewActive],
  );
  const validateAddition = useCallback(
    (
      hello: MonoidAppletHello,
      signal: AbortSignal,
      setState?: (message: string) => void,
    ) => session.resolveBundle(hello, authority, signal, setState),
    [session, authority],
  );
  const acceptsBundle = useCallback(
    (hello: MonoidAppletHello) => session.acceptsBundle(hello),
    [session],
  );
  const onAdded = useCallback(
    (hello: MonoidAppletHello, replaced?: CardResetIdentity) =>
      session.addCard(hello, replaced),
    [session],
  );
  const onNeedsInstall = useCallback(
    (cardInformation: CardInformation) => {
      installing.current = true;
      router
        .cardApplets({
          cardInformation,
          returnTo: 'bundle',
          bundleId: view.bundleId,
        })
        .$push();
    },
    [router, view],
  );
  const addition = useBundleCardAddition({
    isActive,
    validateAddition,
    acceptsBundle,
    onAdded,
    onNeedsInstall,
    secretPINSession,
  });
  const acceptInstalledCard = useRef(addition.acceptCard);
  acceptInstalledCard.current = addition.acceptCard;
  const busy = working || addition.busy;
  const complete = session.complete && !busy;

  useEffect(() => {
    runInAction(() => {
      session.busy = busy;
    });
    return () => {
      runInAction(() => {
        session.busy = false;
      });
    };
  }, [busy, session]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      void authority.signOut();
      if (!installing.current) secretPINSession.clear();
    };
  }, [authority, secretPINSession]);
  useEffect(
    () =>
      reaction(isViewActive, active => {
        if (active) installing.current = false;
        else {
          operation.current?.abort();
          void authority.signOut();
          if (!installing.current) secretPINSession.clear();
        }
      }),
    [authority, isViewActive, secretPINSession],
  );
  useEffect(
    () =>
      reaction(
        () =>
          isViewActive() && authority.signedIn && !busy
            ? session.installedCard
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
                if (consumed && session.installedCard === hello)
                  runInAction(() => {
                    session.installedCard = undefined;
                  });
              }
            })(),
          );
        },
        {fireImmediately: true},
      ),
    [authority, busy, errorService, isViewActive, session],
  );
  const account = authority.account;
  const [namespaces, setNamespaces] = useState<AuthorityNamespace[]>([]);
  const [owner, setOwner] = useState<AuthorityNamespace>();
  const [groups, setGroups] = useState<AuthorityGroup[]>();
  const [loading, setLoading] = useState(false);
  const [showBundles, setShowBundles] = useState(false);
  const [name, setName] = useState('');
  const [allowPeerExtension, setAllowPeerExtension] = useState(true);

  useEffect(() => {
    let current = true;
    setNamespaces([]);
    setOwner(undefined);
    setShowBundles(false);
    setLoading(!!account);
    if (!account) return;

    errorService.catch(
      authority
        .namespaces()
        .then(result => {
          if (!current) return;
          const available = result.filter(
            namespace => namespace.source !== 'github-organization',
          );
          setNamespaces(available);
          setOwner(
            available.find(
              namespace =>
                namespace.source === session.choice?.owner.source &&
                namespace.id === session.choice.owner.id,
            ) ?? available[0],
          );
        })
        .finally(() => {
          if (current) setLoading(false);
        }),
    );
    return () => {
      current = false;
    };
  }, [account, authority, errorService, session]);

  useEffect(() => {
    let current = true;
    setGroups(undefined);
    setName('');
    setAllowPeerExtension(true);
    setShowBundles(false);
    if (!owner || !account) return;
    setLoading(true);

    errorService.catch(
      authority
        .groups({source: owner.source, id: owner.id})
        .then(result => {
          if (!current) return;
          setGroups(result);
          const recent = result.reduce<AuthorityGroup | undefined>(
            (latest, group) =>
              !latest || group.createdAt > latest.createdAt ? group : latest,
            undefined,
          );
          setName(recent?.name.normalize('NFC') ?? '');
        })
        .finally(() => {
          if (current) setLoading(false);
        }),
    );
    return () => {
      current = false;
    };
  }, [owner, account, authority, errorService]);

  let validName: string | undefined;
  try {
    validName = validateAuthorityBundleName(name);
  } catch {
    // Like derivation paths, invalid input disables the step's confirmation.
  }
  const existing = groups?.find(group => group.name === validName);
  const policy = existing?.allowPeerExtension ?? allowPeerExtension;
  const step = complete ? 3 : account && chosen ? 2 : 1;
  const host = new URL(authority.authorityUrl).host;
  const backToCard = view.card
    ? router.$backTo(router.safe.card.$exact)
    : undefined;
  const back = backToCard ?? router.$backTo(router.safe.$exact);

  const join = async (card: AuthorityBundleCard): Promise<void> => {
    if (operation.current || busy || !isActive() || card.joined) return;
    const controller = new AbortController();
    operation.current = controller;
    setWorking(true);
    let needsReset: MonoidAppletHello | undefined;
    try {
      await secretPINSession.run(
        [card],
        async (expected, pinSignal) => {
          const signal = AbortSignal.any([controller.signal, pinSignal]);
          let description = `Card ${cardName(expected!)}`;
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
            scanCardPrompt(card),
            async (sessionId, setState, scanSignal) => {
              const signal = AbortSignal.any([
                controller.signal,
                pinSignal,
                scanSignal,
              ]);
              signal.throwIfAborted();
              const applet = await monoidApplet.openSession(sessionId);
              signal.throwIfAborted();
              const hello = MonoidAppletHello.satisfies(await applet.hello({}));
              signal.throwIfAborted();
              assertSameCard(hello, card);
              await session.resolveBundle(hello, authority, signal, setState);
              if (hello.bundle !== false && !session.acceptsBundle(hello)) {
                needsReset = hello;
                return;
              }
              const cached = cardStore.get(card);
              try {
                if (session.recognizeJoined(hello, card)) return;
                const {pin, onAuthenticated} = credentials(
                  readBackupCardIdentity(hello),
                );
                await session.join(
                  applet,
                  hello,
                  card,
                  authority,
                  pin,
                  onAuthenticated,
                  signal,
                  setState,
                );
              } finally {
                if (card.joined && cached)
                  runInAction(() => {
                    cached.bundle = card.bundle;
                    cached.allowPeerExtension = card.allowPeerExtension!;
                    cardStore.set(cached);
                  });
              }
            },
          ),
      );
      if (needsReset && isActive() && !controller.signal.aborted)
        await addition.acceptCard(needsReset);
    } catch (error) {
      if (!isOperationCancelled(error, controller.signal)) throw error;
    } finally {
      if (operation.current === controller) operation.current = undefined;
      if (mounted.current) setWorking(false);
    }
  };

  return (
    <>
      <ViewContent
        footer={
          complete ? (
            back && (
              <Button color="neutral" onClick={() => back()}>
                {backToCard ? 'Back to Card' : 'Back to Safe'}
              </Button>
            )
          ) : !account ? (
            <Button
              loading={authority.signInState.status === 'pending'}
              onClick={errorService.catch(async () => {
                try {
                  await authority.signIn();
                } catch (error) {
                  if (
                    !(
                      error instanceof AuthorityError &&
                      error.code === 'cancelled'
                    )
                  )
                    throw error;
                }
              })}
            >
              Sign in
            </Button>
          ) : step === 1 ? (
            <Button
              disabled={loading || !owner || !groups || validName === undefined}
              onClick={() => {
                if (validName === undefined) return;
                session.choose({
                  owner: owner!,
                  name: validName,
                  allowPeerExtension: policy,
                });
              }}
            >
              Continue
            </Button>
          ) : (
            <Buttons>
              <Button
                loading={busy}
                onClick={errorService.catch(() =>
                  session.nextCard &&
                  !addition.pendingPIN &&
                  !addition.pendingReset
                    ? join(session.nextCard)
                    : addition.resume(),
                )}
              >
                {addition.pendingPIN || addition.pendingReset
                  ? addition.buttonLabel
                  : session.nextCard
                    ? 'Join bundle'
                    : session.cards.length
                      ? 'Add another card'
                      : 'Add a card'}
              </Button>
              {!session.joinedCount ? (
                <Button
                  disabled={busy}
                  color="neutral"
                  onClick={() => session.choose()}
                >
                  Change bundle
                </Button>
              ) : (
                !session.nextCard && (
                  <Button
                    disabled={busy}
                    color="neutral"
                    onClick={() => {
                      runInAction(() => {
                        session.complete = true;
                      });
                      secretPINSession.clear();
                      void authority.signOut();
                    }}
                  >
                    Done
                  </Button>
                )
              )}
            </Buttons>
          )
        }
      >
        {stepsExited ? (
          <OperationComplete />
        ) : (
          <OperationSteps
            $exiting={complete}
            onAnimationEnd={event => {
              if (complete && event.target === event.currentTarget)
                setStepsExited(true);
            }}
          >
            <Step
              title="Choose bundle"
              numero={1}
              activeNumero={step}
              processing={!!account && loading}
              summary={
                chosen && (
                  <BundlePath>
                    {chosen.owner.source === 'reown' ? (
                      'Account'
                    ) : chosen.owner.source === 'wallet' ? (
                      <BundleOwnerAddress title={chosen.owner.displayName}>
                        {chosen.owner.displayName}
                      </BundleOwnerAddress>
                    ) : (
                      chosen.owner.displayName
                    )}
                    {' / '}
                    {chosen.name}
                  </BundlePath>
                )
              }
            >
              {children}
              {account ? (
                <AuthorityAccountInfo account={account} />
              ) : (
                <InfoMessage>Bundles are issued by {host}.</InfoMessage>
              )}
              {account && namespaces.length > 1 && (
                <SegmentedControl
                  aria-label="Owner"
                  value={String(namespaces.indexOf(owner!))}
                  options={namespaces.map((namespace, index) => ({
                    value: String(index),
                    label:
                      namespace.source === 'reown'
                        ? 'Account'
                        : namespace.source === 'wallet'
                          ? 'Wallet'
                          : 'GitHub',
                  }))}
                  onChange={value => setOwner(namespaces[Number(value)])}
                />
              )}
              {account && (
                <>
                  <InputWithAction
                    aria-label="Bundle name"
                    placeholder="Bundle name"
                    aria-invalid={!!name && validName === undefined}
                    value={name}
                    disabled={loading || !groups}
                    onChange={event =>
                      setName(event.target.value.normalize('NFC'))
                    }
                    action={
                      groups?.length
                        ? {
                            label: 'Choose bundle',
                            icon: list,
                            onClick: () => setShowBundles(true),
                          }
                        : undefined
                    }
                  />
                  <Toggle
                    checked={policy}
                    disabled={loading || !groups || !!existing}
                    onChange={setAllowPeerExtension}
                  >
                    Members can add cards
                  </Toggle>
                  {groups && !existing && (
                    <InfoMessage>
                      A new bundle's policy can't be changed after its first
                      card joins.
                    </InfoMessage>
                  )}
                </>
              )}
            </Step>
            <Step
              title={
                <InfoSectionHeader>
                  <span>Add cards</span>
                  {chosen && (
                    <InfoSectionItemLabel>
                      {session.joinedCount}/{session.cards.length}
                    </InfoSectionItemLabel>
                  )}
                </InfoSectionHeader>
              }
              numero={2}
              activeNumero={step}
              processing={busy}
              keepExpanded
            >
              <CardGrid>
                {session.cards.map(card => (
                  <CardPreviewButton
                    key={card.publicKey}
                    aria-label={`Join card ${card.id}`}
                    disabled={busy || card.joined}
                    onClick={errorService.catch(() => join(card))}
                  >
                    <CardPreview
                      id={card.id}
                      alias={card.alias}
                      aliasToggle
                      description={
                        card.joined
                          ? 'joined'
                          : card === session.nextCard
                            ? 'pending'
                            : 'join later'
                      }
                      $scan={
                        card.joined
                          ? 'ready'
                          : card === session.nextCard
                            ? 'next'
                            : 'pending'
                      }
                    />
                  </CardPreviewButton>
                ))}
                <CardPreviewButton
                  aria-label="Add card"
                  disabled={busy}
                  onClick={errorService.catch(addition.resume)}
                >
                  <CardPlaceholder aria-hidden="true">+</CardPlaceholder>
                </CardPreviewButton>
              </CardGrid>
            </Step>
          </OperationSteps>
        )}
      </ViewContent>
      {account && showBundles && (
        <DetailsPopup
          aria-label="Choose bundle"
          onDismiss={() => setShowBundles(false)}
        >
          <DetailsPopupTitle>Choose bundle</DetailsPopupTitle>
          <DetailsPopupDivider />
          <Bundles>
            <List>
              {groups?.map(group => (
                <ListItemButton
                  key={group.name}
                  className="ion-activatable"
                  onClick={() => {
                    setName(group.name.normalize('NFC'));
                    setShowBundles(false);
                  }}
                >
                  <ListItemContent>
                    <ListItemName>{group.name}</ListItemName>
                    <ListItemDescription>
                      {group.allowPeerExtension
                        ? 'Members can add cards'
                        : 'Only the Authority adds cards'}
                    </ListItemDescription>
                  </ListItemContent>
                  <RippleEffect />
                </ListItemButton>
              ))}
            </List>
          </Bundles>
          <Button color="neutral" onClick={() => setShowBundles(false)}>
            Cancel
          </Button>
        </DetailsPopup>
      )}
      {addition.content}
      {isActive() && pinInput}
    </>
  );
});
