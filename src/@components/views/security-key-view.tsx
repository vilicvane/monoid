import {
  CreditCardMinus as creditCardMinus,
  Ellipsis as ellipsis,
  KeyRound as keyRound,
} from 'lucide-react';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {MonoidIdHex, type SafeIndexHex} from '../../@atomics.js';
import {useEntrances} from '../../@entrances.js';
import {AppletNotFoundError} from '../../@lib/applet.js';
import {
  MonoidCardError,
  MonoidWrongCardError,
} from '../../@lib/monoid/index.js';
import {
  SecurityKeyConfiguration,
  type SecurityKeyCredentialItem,
  type SecurityKeySnapshot,
  isSecurityKeyCredentialActive,
  readSecurityKeySnapshot,
  securityKeySeedChangeNeedsConfirmation,
} from '../../@lib/security-key.js';
import type {Router} from '../../@routes.js';
import {isCredentialRequestCancelled} from '../../@services/index.js';
import {uint8ArrayToHex} from '../../@utils/index.js';
import {KeyAliasTag} from '../@key/key-tags.js';
import {
  type MonoidScanPromptCallback,
  type MonoidScanPromptValidateCard,
  MonoidScanRedirectError,
  MonoidScanStatePromptContentHighlight,
  useMonoidScanPrompt,
} from '../@monoid/monoid-scan-prompt.js';
import {scanNextCards} from '../@monoid/scan-next-cards.js';
import {AppIcon} from '../@ui/app-icon.js';
import {Button, Buttons} from '../@ui/button.js';
import {ConfirmPopup} from '../@ui/confirm-popup.js';
import {
  DetailsPopup,
  DetailsPopupDivider,
  DetailsPopupTitle,
} from '../@ui/details-popup.js';
import {
  InfoSection,
  InfoSectionDivider,
  InfoSectionHeader,
  InfoSectionItem,
  InfoSectionItemContent,
  InfoSectionItemLabel,
} from '../@ui/info-section.js';
import {
  IconList,
  ListItemButton,
  ListItemContent,
  ListItemDescription,
  ListItemName,
  ListSectionTitle,
} from '../@ui/list.js';
import {InfoMessage, WarningMessage} from '../@ui/message-content.js';
import {
  SwipeAction,
  SwipeActionIcon,
  SwipeableItem,
} from '../@ui/swipeable-item.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderIdentifier,
  ViewHeaderTitle,
  ViewPlaceholder,
  useViewActive,
  viewHeaderTagCSS,
} from '../@view/index.js';

import {CardScanPlaceholder} from './card/card-management-content.js';
import {
  CardResourceItem,
  CardResourceList,
  deleteCardResources,
  readBackupCardIdentity,
} from './safe/index.js';

const SeedAliasTag = styled(KeyAliasTag)`
  ${viewHeaderTagCSS}
`;

const CredentialIcon = styled(AppIcon)`
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 8px;
  border-radius: 9px;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
`;

const Credentials = styled(IconList)`
  flex: none;
`;

const SeedAlternative = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--color-text-label);
  font-size: 14px;

  ${InfoSectionDivider} {
    flex: 1;
    align-self: center;
  }
`;

function CredentialDetails({
  item,
  available,
  onDismiss,
}: {
  item: SecurityKeyCredentialItem;
  available: boolean;
  onDismiss: () => void;
}): ReactNode {
  const credential = item.credential;
  const entries: [string, string][] = credential
    ? [
        ['Website', credential.rpId],
        ...(credential.userName === undefined
          ? []
          : [['User name', credential.userName] as [string, string]]),
        ...(credential.displayName === undefined
          ? []
          : [['Display name', credential.displayName] as [string, string]]),
        ['User ID', uint8ArrayToHex(credential.userId)],
        ['Credential ID', uint8ArrayToHex(credential.credentialId)],
        ['Status', available ? 'Available' : 'Inactive'],
      ]
    : [];
  return (
    <DetailsPopup onDismiss={onDismiss} aria-label="Credential">
      <DetailsPopupTitle>Credential</DetailsPopupTitle>
      <DetailsPopupDivider />
      {!credential && <InfoMessage>Invalid credential data</InfoMessage>}
      {[...entries, ['Item ID', item.index]].map(([label, value]) => (
        <InfoSectionItem key={label}>
          <InfoSectionItemLabel>{label}</InfoSectionItemLabel>
          <InfoSectionItemContent>{value}</InfoSectionItemContent>
        </InfoSectionItem>
      ))}
    </DetailsPopup>
  );
}

export const SecurityKeyView = observer(
  ({view}: RouteComponentProps<Router['securityKey']>): ReactNode => {
    const {router, monoidCredentialsStore, errorService} = useEntrances();
    const active = useViewActive(view);
    const [snapshot, setSnapshot] = useState<SecurityKeySnapshot>();
    const [missingMonoid, setMissingMonoid] = useState(false);
    const [needsPINSetup, setNeedsPINSetup] = useState(false);
    const [busy, setBusy] = useState(false);
    const [popup, setPopup] = useState<'menu' | 'configure'>();
    const [detail, setDetail] = useState<SecurityKeyCredentialItem>();
    const [deleting, setDeleting] = useState<SecurityKeyCredentialItem>();
    const [openRow, setOpenRow] = useState<SafeIndexHex>();
    const [selection, setSelection] = useState<SafeIndexHex | 'create'>();
    const [configuration, setConfiguration] =
      useState<SecurityKeyConfiguration>();
    const [pinSession] = useState(() =>
      monoidCredentialsStore.createPINSession(),
    );
    const [scanContent, scan] = useMonoidScanPrompt({
      auth: 'access',
      ensureSetup: false,
      pinSession,
    });
    const controller = useRef<AbortController | undefined>(undefined);
    const mounted = useRef(true);
    const configuredSeed = snapshot?.grant?.seed;
    const boundSeed =
      configuredSeed &&
      snapshot?.seeds.find(
        seed => seed.index === uint8ArrayToHex(configuredSeed.index),
      );
    const configured =
      !!boundSeed &&
      snapshot?.installed &&
      !!snapshot.scope &&
      snapshot?.grant?.types?.some(
        ([type, writable]) => type === -3839 && writable,
      );

    useEffect(() => {
      mounted.current = true;
      const dispose = reaction(active, value => {
        if (!value) {
          controller.current?.abort();
          pinSession.clear();
          setPopup(undefined);
          setDetail(undefined);
          setDeleting(undefined);
          setOpenRow(undefined);
          setSelection(undefined);
          setConfiguration(undefined);
          setSnapshot(undefined);
          setMissingMonoid(false);
          setNeedsPINSetup(false);
        }
      });
      return () => {
        mounted.current = false;
        controller.current?.abort();
        pinSession.clear();
        dispose();
      };
    }, [active, pinSession]);

    async function deleteCredential(
      item: SecurityKeyCredentialItem,
    ): Promise<void> {
      if (!snapshot || controller.current || !active()) return;
      const operation = new AbortController();
      controller.current = operation;
      setBusy(true);
      setDeleting(undefined);
      setDetail(undefined);
      const identity = readBackupCardIdentity(snapshot.hello);

      const validate =
        (card: typeof identity | undefined): MonoidScanPromptValidateCard =>
        hello => {
          if (operation.signal.aborted || !mounted.current || !active())
            throw new MonoidScanRedirectError();
          const current = readBackupCardIdentity(hello);
          if (
            card &&
            (current.id !== card.id || current.publicKey !== card.publicKey)
          )
            throw new MonoidWrongCardError(card.id);
          if (hello.pins.access === false || hello.pins.secret === false)
            throw new MonoidCardError('Set up card PINs first');
          if (hello.pins.access === 0)
            throw new MonoidCardError('Access PIN blocked');
        };
      // A card without the record has nothing left to delete.
      const deleteFromCard: MonoidScanPromptCallback = async (
        applet,
        setState,
        _hello,
        scanSignal,
      ) => {
        const signal = AbortSignal.any([operation.signal, scanSignal]);
        setState('Deleting credential, hold tight...');
        await deleteCardResources(
          applet,
          new Set([item.index]),
          signal,
          () => {},
        );
      };

      try {
        await scan(
          <>
            Scan card{' '}
            <MonoidScanStatePromptContentHighlight>
              {identity.id}
            </MonoidScanStatePromptContentHighlight>
          </>,
          async (applet, setState, hello, scanSignal) => {
            await deleteFromCard(applet, setState, hello, scanSignal);
            if (mounted.current && active())
              setSnapshot(
                current =>
                  current && {
                    ...current,
                    credentials: current.credentials.filter(
                      credential => credential.index !== item.index,
                    ),
                  },
              );
          },
          validate(identity),
          operation.signal,
        );
        await scanNextCards({
          scan,
          scanned: new Set([identity.publicKey]),
          content: 'Scan next card to delete',
          callback: deleteFromCard,
          validate: validate(undefined),
          signal: operation.signal,
        });
      } catch (error) {
        if (
          !operation.signal.aborted &&
          !isCredentialRequestCancelled(error) &&
          !(error instanceof Error && error.name === 'AbortError')
        )
          throw error;
      } finally {
        if (controller.current === operation) controller.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }

    async function run(config?: SecurityKeyConfiguration): Promise<void> {
      if (controller.current || !active()) return;
      const operation = new AbortController();
      controller.current = operation;
      setBusy(true);
      setPopup(undefined);
      const identity = config
        ? readBackupCardIdentity(config.snapshot.hello)
        : undefined;
      try {
        await scan(
          identity ? (
            <>
              Scan card{' '}
              <MonoidScanStatePromptContentHighlight>
                {identity.id}
              </MonoidScanStatePromptContentHighlight>
            </>
          ) : (
            'Scan a card'
          ),
          async (applet, setState, hello, scanSignal) => {
            const signal = AbortSignal.any([operation.signal, scanSignal]);
            signal.throwIfAborted();
            if (config) {
              await config.apply(applet, hello, signal);
            }
            signal.throwIfAborted();
            setState('Reading credentials, hold tight...');
            const next = await readSecurityKeySnapshot(applet, hello, signal);
            if (mounted.current && active()) {
              setSnapshot(next);
              setMissingMonoid(false);
              setNeedsPINSetup(false);
              setConfiguration(undefined);
            }
          },
          hello => {
            if (operation.signal.aborted || !mounted.current || !active())
              throw new MonoidScanRedirectError();
            const card = readBackupCardIdentity(hello);
            if (
              identity &&
              (card.id !== identity.id ||
                card.publicKey !== identity.publicKey ||
                card.bundle !== identity.bundle)
            )
              throw new MonoidWrongCardError(identity.id);
            if (hello.pins.access === false || hello.pins.secret === false) {
              setConfiguration(undefined);
              setSnapshot(undefined);
              setMissingMonoid(false);
              setNeedsPINSetup(true);
              throw new MonoidScanRedirectError();
            }
            if (hello.pins.access === 0)
              throw new MonoidCardError('Access PIN blocked');
            if (hello.pins.secret === 0)
              throw new MonoidCardError('Secret PIN blocked');
          },
          operation.signal,
        );
      } catch (error) {
        if (
          !config &&
          !operation.signal.aborted &&
          mounted.current &&
          active() &&
          error instanceof Error &&
          error.cause instanceof AppletNotFoundError
        ) {
          setMissingMonoid(true);
          setNeedsPINSetup(false);
          setSnapshot(undefined);
          setConfiguration(undefined);
          return;
        }
        if (
          !operation.signal.aborted &&
          !isCredentialRequestCancelled(error) &&
          !(error instanceof Error && error.name === 'AbortError')
        )
          throw error;
      } finally {
        if (config?.complete) pinSession.clear();
        if (controller.current === operation) controller.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }

    function configure(seed: SafeIndexHex | 'create', confirmed = false): void {
      if (!snapshot || configuration || busy) return;
      setPopup(undefined);
      if (
        !confirmed &&
        securityKeySeedChangeNeedsConfirmation(snapshot, seed)
      ) {
        setSelection(seed);
        return;
      }
      setSelection(undefined);
      const next = new SecurityKeyConfiguration(snapshot, seed, confirmed);
      setConfiguration(next);
      errorService.catch(run(next));
    }

    const applets = (): void => {
      router.cardApplets({returnTo: 'securityKey'}).$push();
    };
    const needsInstall = missingMonoid || snapshot?.installed === false;
    const configureLabel = configured
      ? 'Configure Seed'
      : 'Enable Security Key on card';
    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Security Key</ViewHeaderTitle>
          {snapshot && (
            <ViewHeaderIdentifier
              identifier={{
                type: 'card',
                id: MonoidIdHex.satisfies(uint8ArrayToHex(snapshot.hello.id)),
              }}
            />
          )}
          {configured && boundSeed.alias && (
            <SeedAliasTag>{boundSeed.alias}</SeedAliasTag>
          )}
          {snapshot && (
            <ViewHeaderButton
              aria-label="Security Key menu"
              disabled={busy}
              onClick={() => setPopup('menu')}
            >
              <AppIcon icon={ellipsis} />
            </ViewHeaderButton>
          )}
        </ViewHeader>
        <ViewContent
          footer={
            <Buttons>
              {needsInstall || needsPINSetup ? (
                <Button onClick={applets}>Open Card Applets</Button>
              ) : snapshot?.installed && !configured && !configuration ? (
                <Button disabled={busy} onClick={() => setPopup('configure')}>
                  {configureLabel}
                </Button>
              ) : null}
              {configuration &&
                !configuration.complete &&
                !configuration.uncertain && (
                  <Button
                    loading={busy}
                    onClick={errorService.catch(() => run(configuration))}
                  >
                    Continue
                  </Button>
                )}
              <Button
                color={
                  snapshot || needsInstall || needsPINSetup
                    ? 'neutral'
                    : 'primary'
                }
                loading={busy}
                onClick={errorService.catch(() => run())}
              >
                Scan a card
              </Button>
            </Buttons>
          }
        >
          {snapshot ? (
            <>
              {needsInstall && (
                <InfoMessage>Install Monoid Security Key Applet</InfoMessage>
              )}
              {configuration?.uncertain && (
                <WarningMessage>
                  Scan card again to check changes before continuing
                </WarningMessage>
              )}
              {snapshot.credentials.length === 0 ? (
                <ViewPlaceholder>No credentials</ViewPlaceholder>
              ) : (
                <InfoSection>
                  <InfoSectionHeader>
                    <ListSectionTitle>Credentials</ListSectionTitle>
                  </InfoSectionHeader>
                  <Credentials>
                    {snapshot.credentials.map(item => (
                      <SwipeableItem
                        key={item.index}
                        open={openRow === item.index}
                        disabled={busy}
                        onOpenChange={open =>
                          setOpenRow(open ? item.index : undefined)
                        }
                        actions={
                          <SwipeAction
                            type="button"
                            $color="var(--ion-color-danger)"
                            disabled={busy}
                            onClick={() => {
                              setOpenRow(undefined);
                              setDeleting(item);
                            }}
                          >
                            <SwipeActionIcon>
                              <AppIcon icon={creditCardMinus} />
                            </SwipeActionIcon>
                            Delete
                          </SwipeAction>
                        }
                      >
                        <ListItemButton
                          data-swipeable-content
                          onClick={() =>
                            openRow ? setOpenRow(undefined) : setDetail(item)
                          }
                        >
                          <CredentialIcon icon={keyRound} />
                          <ListItemContent>
                            <ListItemName>
                              {item.credential?.rpId ?? 'Invalid credential'}
                            </ListItemName>
                            <ListItemDescription>
                              {item.credential?.displayName ||
                                item.credential?.userName ||
                                item.index}
                            </ListItemDescription>
                          </ListItemContent>
                          {item.credential &&
                            !isSecurityKeyCredentialActive(snapshot, item) && (
                              <ListItemDescription>
                                Inactive
                              </ListItemDescription>
                            )}
                        </ListItemButton>
                      </SwipeableItem>
                    ))}
                  </Credentials>
                </InfoSection>
              )}
            </>
          ) : (
            <>
              <CardScanPlaceholder />
              {missingMonoid && (
                <InfoMessage>Install Monoid Applet in Card Applets</InfoMessage>
              )}
              {needsPINSetup && (
                <InfoMessage>Set up PINs in Card Applets</InfoMessage>
              )}
            </>
          )}
        </ViewContent>
        {popup === 'menu' && (
          <DetailsPopup
            onDismiss={() => setPopup(undefined)}
            aria-label="Security Key menu"
          >
            <DetailsPopupTitle>Security Key</DetailsPopupTitle>
            <DetailsPopupDivider />
            {snapshot?.installed && (
              <Button
                disabled={!!configuration}
                onClick={() => setPopup('configure')}
              >
                {configureLabel}
              </Button>
            )}
            <Button
              color="neutral"
              onClick={() => {
                setPopup(undefined);
                applets();
              }}
            >
              Card Applets
            </Button>
          </DetailsPopup>
        )}
        {popup === 'configure' && snapshot && (
          <DetailsPopup
            onDismiss={() => setPopup(undefined)}
            aria-label={configureLabel}
          >
            <DetailsPopupTitle>{configureLabel}</DetailsPopupTitle>
            <DetailsPopupDivider />
            {snapshot.seeds.length > 0 && (
              <>
                <CardResourceList $contained data-popup-animation-group>
                  {snapshot.seeds.map(seed => (
                    <CardResourceItem
                      key={seed.index}
                      data={{...seed, type: 'seed'}}
                      onOpen={() => configure(seed.index)}
                    />
                  ))}
                </CardResourceList>
                <SeedAlternative>
                  <InfoSectionDivider aria-hidden="true" />
                  or
                  <InfoSectionDivider aria-hidden="true" />
                </SeedAlternative>
              </>
            )}
            <Button color="neutral" onClick={() => configure('create')}>
              Create dedicated Seed
            </Button>
          </DetailsPopup>
        )}
        {selection && (
          <ConfirmPopup
            title="Change Seed?"
            confirmColor="warning"
            confirmText="Change Seed"
            onCancel={() => setSelection(undefined)}
            onConfirm={() => configure(selection, true)}
          >
            Accounts registered with the current Seed stop working, including
            ones not listed here. Select the current Seed again to restore them.
          </ConfirmPopup>
        )}
        {detail && (
          <CredentialDetails
            item={detail}
            available={
              !!snapshot && isSecurityKeyCredentialActive(snapshot, detail)
            }
            onDismiss={() => setDetail(undefined)}
          />
        )}
        {deleting && (
          <ConfirmPopup
            title="Delete credential?"
            confirmColor="danger"
            confirmText="Delete"
            onCancel={() => setDeleting(undefined)}
            onConfirm={() => errorService.catch(deleteCredential(deleting))}
          >
            Websites can no longer sign in with it on this card. Scan any other
            cards that hold it next.
          </ConfirmPopup>
        )}
        {scanContent}
      </View>
    );
  },
);
