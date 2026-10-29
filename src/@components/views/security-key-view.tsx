import {
  CreditCardMinus as creditCardMinus,
  Ellipsis as ellipsis,
  KeyRound as keyRound,
} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {MonoidIdHex, type SafeIndexHex} from '../../@atomics.js';
import {useEntrances} from '../../@entrances.js';
import {
  assertCardPINs,
  assertSameCard,
  cardNameWithId,
  readCardIdentity,
  removeItems,
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
import {uint8ArrayToHex} from '../../@utils/index.js';
import {CardHeaderTags} from '../@monoid/card-header-tags.js';
import {
  MonoidScanCardAppletsRequiredError,
  type MonoidScanPromptCallback,
  type MonoidScanPromptValidateCard,
  scanCardPrompt,
  useMonoidScanPrompt,
} from '../@monoid/monoid-scan-prompt.js';
import {scanNextCards} from '../@monoid/scan-next-cards.js';
import {useCardOperation} from '../@monoid/use-card-operation.js';
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
  ViewActionButton,
  ViewContent,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderTitle,
  ViewPlaceholder,
  useViewActive,
} from '../@view/index.js';

import {CardScanPlaceholder} from './card/card-management-content.js';
import {CardResourceItem, CardResourceList} from './safe/index.js';

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
    const {monoidCredentialsStore, errorService} = useEntrances();
    const active = useViewActive(view);
    const [snapshot, setSnapshot] = useState<SecurityKeySnapshot>();
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
      cardAppletsReturnTo: 'securityKey',
      pinSession,
    });
    const {busy, run: runOperation} = useCardOperation({
      active,
      pinSession,
      scan,
      onLeave: () => {
        setPopup(undefined);
        setDetail(undefined);
        setDeleting(undefined);
        setOpenRow(undefined);
        setSelection(undefined);
        setConfiguration(undefined);
        setSnapshot(undefined);
      },
    });
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

    async function deleteCredential(
      item: SecurityKeyCredentialItem,
    ): Promise<void> {
      if (!snapshot) return;
      await runOperation(async ({signal, active, scan}) => {
        setDeleting(undefined);
        setDetail(undefined);
        const identity = {
          ...readCardIdentity(snapshot.hello),
          alias: snapshot.hello.alias,
        };

        const validate =
          (card: typeof identity | undefined): MonoidScanPromptValidateCard =>
          hello => {
            if (card) assertSameCard(hello, card);
            assertCardPINs(hello);
          };
        // A card without the record has nothing left to delete.
        const deleteFromCard: MonoidScanPromptCallback = async (
          applet,
          setState,
          _hello,
          signal,
        ) => {
          setState('Deleting credential, hold tight...');
          await removeItems(applet, new Set([item.index]), signal, () => {});
        };

        await scan(
          scanCardPrompt(identity),
          async (applet, setState, hello, scanSignal) => {
            await deleteFromCard(applet, setState, hello, scanSignal);
            if (active())
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
          signal,
        );
        await scanNextCards({
          scan,
          scanned: new Set([identity.publicKey]),
          content: 'Scan next card to delete',
          callback: deleteFromCard,
          validate: validate(undefined),
          signal,
        });
      });
    }

    async function run(config?: SecurityKeyConfiguration): Promise<void> {
      await runOperation(async ({signal, active, scan}) => {
        setPopup(undefined);
        const identity = config
          ? {
              ...readCardIdentity(config.snapshot.hello),
              alias: config.snapshot.hello.alias,
            }
          : undefined;
        try {
          await scan(
            identity ? scanCardPrompt(identity) : 'Scan a card',
            async (applet, setState, hello, signal) => {
              signal.throwIfAborted();
              if (config) {
                await config.apply(applet, hello, signal);
              }
              signal.throwIfAborted();
              setState('Reading credentials, hold tight...');
              const next = await readSecurityKeySnapshot(applet, hello, signal);
              // Card Applets installs the missing applet on this card.
              if (!config && !next.installed)
                throw new MonoidScanCardAppletsRequiredError();
              if (active()) {
                setSnapshot(next);
                setConfiguration(undefined);
              }
            },
            hello => {
              if (identity) assertSameCard(hello, identity);
              // Card Applets sets up the PINs on this card.
              if (hello.pins.access === false || hello.pins.secret === false)
                throw new MonoidScanCardAppletsRequiredError();
              assertCardPINs(hello, {secret: true});
            },
            signal,
          );
        } finally {
          if (config?.complete) pinSession.clear();
        }
      });
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

    const headerCard = snapshot && {
      id: MonoidIdHex.satisfies(uint8ArrayToHex(snapshot.hello.id)),
      alias: snapshot.hello.alias,
    };
    const canEnable = !!snapshot?.installed && !configured && !configuration;
    const canContinue =
      !!configuration && !configuration.complete && !configuration.uncertain;
    const configureLabel = configured
      ? 'Change seed'
      : 'Enable Security Key on card';
    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Security Key</ViewHeaderTitle>
          {headerCard && <CardHeaderTags card={headerCard} />}
          {configured && (
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
            <>
              <ViewActionButton
                visible={canEnable}
                disabled={busy}
                onClick={() => setPopup('configure')}
              >
                {configureLabel}
              </ViewActionButton>
              <ViewActionButton
                visible={canContinue}
                loading={busy}
                onClick={errorService.catch(() => run(configuration))}
              >
                Continue
              </ViewActionButton>
              <Button
                color={canEnable || canContinue ? 'neutral' : 'primary'}
                loading={busy}
                onClick={errorService.catch(() => run())}
              >
                Scan a card
              </Button>
            </>
          }
        >
          {snapshot ? (
            <>
              {configuration?.uncertain && (
                <WarningMessage>
                  Scan card {cardNameWithId(configuration.snapshot.hello)} again
                  to check changes before continuing
                </WarningMessage>
              )}
              {configured && (
                <InfoSection>
                  <InfoSectionHeader>
                    <ListSectionTitle>Seed</ListSectionTitle>
                  </InfoSectionHeader>
                  <CardResourceList $contained>
                    <CardResourceItem
                      data={{...boundSeed, type: 'seed'}}
                      disabled={busy || !!configuration}
                      onOpen={() => setPopup('configure')}
                    />
                  </CardResourceList>
                </InfoSection>
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
            </>
          )}
        </ViewContent>
        {popup === 'menu' && configured && (
          <DetailsPopup
            onDismiss={() => setPopup(undefined)}
            aria-label="Security Key menu"
          >
            <DetailsPopupTitle>Security Key</DetailsPopupTitle>
            <DetailsPopupDivider />
            <Buttons data-popup-animation-group>
              <Button
                disabled={!!configuration}
                onClick={() => setPopup('configure')}
              >
                {configureLabel}
              </Button>
            </Buttons>
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
              Create dedicated seed
            </Button>
          </DetailsPopup>
        )}
        {selection && (
          <ConfirmPopup
            title="Change seed?"
            confirmColor="warning"
            confirmText="Change seed"
            onCancel={() => setSelection(undefined)}
            onConfirm={() => configure(selection, true)}
          >
            Accounts registered with the current seed stop working, including
            ones not listed here. Select the current seed again to restore them.
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
