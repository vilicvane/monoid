import {
  Broom as broom,
  CreditCardMinus as creditCardMinus,
  Ellipsis as ellipsis,
} from 'lucide-react';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type MouseEvent, type ReactNode, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {
  MONOID_PIN_MAX_LENGTH,
  MONOID_PIN_MIN_LENGTH,
  MonoidPIN,
} from '../../@atomics.js';
import {useEntrances} from '../../@entrances.js';
import {
  MonoidCardError,
  assertCardPINs,
  assertSameCard,
} from '../../@lib/monoid/index.js';
import {
  addOTPAccount,
  authorizeOTPAccounts,
  isOTPInstalled,
  readOTPCard,
  removeOTPAccount,
} from '../../@lib/otp-card.js';
import type {OTPAlgorithm, OTPImportAccount} from '../../@lib/otp.js';
import type {Router} from '../../@routes.js';
import type {OTPAccount, OTPCard} from '../../@services/index.js';
import {uint8ArrayToHex} from '../../@utils/index.js';
import {
  ExpandableKeyGroup,
  KeyGroupItem,
  keyGroupReveal,
} from '../@key/expandable-key-group.js';
import {KeyList, KeyListItemContent} from '../@key/key-list.js';
import {KeyDerivationBadge, KeyTags} from '../@key/key-tags.js';
import {
  type MonoidScanAuthentication,
  type MonoidScanPromptCallback,
  type MonoidScanPromptValidateCard,
  scanCardPrompt,
  useMonoidScanPrompt,
} from '../@monoid/monoid-scan-prompt.js';
import {getPINInputPlaceholder} from '../@monoid/pin-input-placeholder.js';
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
import {ListItemName} from '../@ui/list.js';
import {InfoMessage} from '../@ui/message-content.js';
import {RippleEffect} from '../@ui/ripple-effect.js';
import {
  SwipeAction,
  SwipeActionIcon,
  SwipeableItem,
} from '../@ui/swipeable-item.js';
import {Tag, WhiteTag} from '../@ui/tag.js';
import {useInputModal} from '../@ui/use-input-modal.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderButton,
  ViewHeaderTitle,
  ViewPlaceholder,
  useViewActive,
} from '../@view/index.js';

import {splitOTPAccountLabel} from './otp/otp-account-label.js';
import {OTPAccountPopup} from './otp/otp-account-popup.js';

const Accounts = styled(KeyList)`
  flex: none;
`;
const AccountRow = styled(SwipeableItem)<{$revealing?: boolean}>`
  ${keyGroupReveal}
`;
const AccountItem = styled(KeyGroupItem)`
  cursor: pointer;
`;
const AccountName = styled(ListItemName)`
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:focus-visible {
    outline: 2px solid var(--ion-color-primary);
    outline-offset: -2px;
  }
`;
const ALGORITHM_COLORS: Record<OTPAlgorithm, string> = {
  SHA1: 'primary',
  SHA256: 'seed',
  SHA512: 'warning',
};
const AlgorithmTag = styled(Tag)<{$algorithm: OTPAlgorithm}>`
  background-color: var(
    --color-${({$algorithm}) => ALGORITHM_COLORS[$algorithm]}-light
  );
  border-color: var(
    --color-${({$algorithm}) => ALGORITHM_COLORS[$algorithm]}-light-shade
  );
  color: var(
    --color-${({$algorithm}) => ALGORITHM_COLORS[$algorithm]}-light-contrast
  );
`;
const ProviderTag = styled(WhiteTag)`
  flex-shrink: 1;
  min-width: 0;
  display: block;
  align-content: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 20px;

  &[type='button'] {
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid var(--ion-color-primary);
      outline-offset: -2px;
    }
  }
`;
function groupAccounts(
  accounts: readonly OTPAccount[],
): Map<
  string,
  {provider: string; accounts: {account: OTPAccount; name: string}[]}
> {
  const groups = new Map<
    string,
    {provider: string; accounts: {account: OTPAccount; name: string}[]}
  >();
  for (const account of accounts) {
    const {provider, name} = splitOTPAccountLabel(account.label);
    // A missing issuer does not imply that unrelated accounts share a provider.
    const id = provider ? `provider:${provider}` : `account:${account.index}`;
    let group = groups.get(id);
    if (!group) {
      group = {provider: provider || 'OTP', accounts: []};
      groups.set(id, group);
    }
    group.accounts.push({account, name});
  }
  return groups;
}

type Operation =
  | {type: 'read' | 'authorize'}
  | {type: 'add'; account: OTPImportAccount}
  | {type: 'remove'; account: OTPAccount};

export const OTPView = observer(
  ({view}: RouteComponentProps<Router['otp']>): ReactNode => {
    const {router, cardStore, otpStore, monoidCredentialsStore, errorService} =
      useEntrances();
    const active = useViewActive(view);
    const [requestedCard] = useState(() => view.card);
    const [card, setCard] = useState<OTPCard>();
    const [popup, setPopup] = useState<'menu' | 'add'>();
    const [uri, setURI] = useState<string>();
    const [remove, setRemove] = useState<OTPAccount>();
    const [openRow, setOpenRow] = useState<string>();
    const [pinSession] = useState(() =>
      monoidCredentialsStore.createPINSession(),
    );
    const [pinInput, showPINInput] = useInputModal();
    const [scanInput, scan] = useMonoidScanPrompt({
      auth: 'access',
      ensureSetup: false,
      pinSession,
    });
    const {busy, run: runOperation} = useCardOperation({
      active,
      pinSession,
      scan,
      onLeave: () => {
        setPopup(undefined);
        setURI(undefined);
        setRemove(undefined);
        setCard(undefined);
      },
      onBackground: () => {
        setPopup(undefined);
        setURI(undefined);
        setRemove(undefined);
      },
    });
    const groups = groupAccounts(otpStore.accounts);

    useEffect(
      () =>
        reaction(
          active,
          value => {
            if (!value || !view.importId) return;
            const imported = otpStore.takeImport(view.importId);
            if (imported) {
              setURI(imported);
              setPopup('add');
            }
          },
          {fireImmediately: true},
        ),
      [active, view, otpStore],
    );

    async function run(
      operation: Operation,
      expected?: Pick<OTPCard, 'id' | 'publicKey'> &
        Partial<Pick<OTPCard, 'alias'>>,
    ): Promise<void> {
      if (expected && expected.alias === undefined)
        expected = cardStore.get(expected) ?? expected;
      await runOperation(async ({signal, active, getPINs, scan}) => {
        setPopup(undefined);
        setURI(undefined);
        setOpenRow(undefined);
        setRemove(undefined);
        let installed = true;
        try {
          const pins = await getPINs();
          // Explicit card management can request a missing PIN before NFC.
          // For codes, the shared scanner chooses the PIN of the card actually tapped.
          if (expected) {
            if (!pins[expected.id]) {
              let description: string | undefined;
              for (;;) {
                const value = await showPINInput(
                  {
                    type: 'password',
                    ...getPINInputPlaceholder('Access'),
                    center: true,
                    maxLength: MONOID_PIN_MAX_LENGTH,
                    description,
                  },
                  signal,
                );
                if (value === undefined) return;
                signal.throwIfAborted();
                if (MonoidPIN.is(value)) {
                  pinSession.rememberPIN(expected.id, value);
                  break;
                }
                description = `Use ${MONOID_PIN_MIN_LENGTH} to ${MONOID_PIN_MAX_LENGTH} ASCII characters`;
              }
            }
          }
          signal.throwIfAborted();
          if (!active()) return;

          const scanned = new Set<string>();
          const process: MonoidScanPromptCallback = async (
            applet,
            setState,
            hello,
            signal,
          ) => {
            const identity = {
              id: uint8ArrayToHex(hello.id),
              publicKey: uint8ArrayToHex(hello.publicKey),
              alias: hello.alias,
            };
            signal.throwIfAborted();
            let accounts: OTPAccount[] | undefined;
            if (operation.type === 'add') {
              setState('Adding account, hold tight...');
              accounts = await addOTPAccount(applet, operation.account, signal);
            } else if (operation.type === 'remove') {
              setState('Removing account, hold tight...');
              accounts = await removeOTPAccount(
                applet,
                identity,
                operation.account,
                signal,
              );
            } else if (operation.type === 'authorize') {
              setState('Enabling OTP, hold tight...');
              accounts = await authorizeOTPAccounts(applet, signal);
            }
            let next: OTPCard;
            if (operation.type === 'authorize' && accounts) {
              // The explicit grant is authoritative for this tap.
              next = {...identity, accounts, installed, authorized: installed};
            } else {
              setState('Reading accounts, hold tight...');
              next = await readOTPCard(applet, hello, signal, accounts);
            }
            scanned.add(identity.publicKey);
            signal.throwIfAborted();
            await otpStore.save(next.accounts);
            if (active()) {
              setCard(next);
            }
          };
          const validate =
            (card: typeof expected): MonoidScanPromptValidateCard =>
            hello => {
              if (card) assertSameCard(hello, card);
              assertCardPINs(hello);
            };
          const authentication: MonoidScanAuthentication | undefined =
            operation.type === 'add' || operation.type === 'remove'
              ? {
                  prepare: async (applet, setState, _hello, signal) => {
                    setState('Checking OTP, hold tight...');
                    installed = await isOTPInstalled(applet, signal);
                    if (operation.type === 'add' && !installed)
                      throw new MonoidCardError(
                        'OTP is not installed on this card',
                      );
                  },
                }
              : undefined;

          await scan(
            expected ? scanCardPrompt(expected) : 'Scan a card',
            process,
            validate(expected),
            signal,
            authentication,
          );
          if (operation.type === 'remove')
            await scanNextCards({
              scan,
              scanned,
              content: 'Scan next card to delete',
              callback: process,
              validate: validate(undefined),
              signal,
              authentication,
            });
        } finally {
          if (operation.type === 'add') operation.account.secret.fill(0);
        }
      });
    }

    const execute = (operation: Operation, target?: OTPCard): void => {
      errorService.catch(run(operation, target));
    };

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>One-time Password</ViewHeaderTitle>
          <ViewHeaderButton
            aria-label="OTP menu"
            disabled={busy}
            onClick={() => setPopup('menu')}
          >
            <AppIcon icon={ellipsis} />
          </ViewHeaderButton>
        </ViewHeader>
        <ViewContent
          footer={
            <Buttons>
              {card?.installed && !card.authorized && (
                <Button
                  disabled={busy}
                  onClick={() => execute({type: 'authorize'}, card)}
                >
                  Enable OTP on card
                </Button>
              )}
              <Button
                color="neutral"
                disabled={busy}
                onClick={() =>
                  errorService.catch(
                    run({type: 'read'}, card ? undefined : requestedCard),
                  )
                }
              >
                Scan a card
              </Button>
            </Buttons>
          }
        >
          {!otpStore.accounts.length && (
            <ViewPlaceholder>No OTP accounts</ViewPlaceholder>
          )}
          {card?.installed === false && (
            <InfoMessage>OTP is not installed on this card</InfoMessage>
          )}
          <Accounts>
            {Array.from(groups, ([groupId, {provider, accounts}]) => (
              <ExpandableKeyGroup
                key={groupId}
                focusSelector=".key-group-primary"
                autoExpand={groups.size === 1}
              >
                {({expanded, collapsing, revealing, expand, collapse}) => {
                  const collapsed = accounts.length > 1 && !expanded;
                  const representative = accounts[0];
                  return (collapsed ? [representative] : accounts).map(item => {
                    const {account, name} = item;
                    const collapsedRow =
                      accounts.length > 1 &&
                      (collapsed || collapsing) &&
                      item === representative;
                    const id = `otp-${account.index}`;
                    return (
                      <AccountRow
                        key={account.index}
                        className={
                          item === representative
                            ? 'key-group-primary'
                            : undefined
                        }
                        $revealing={revealing && item !== representative}
                        disabled={busy || collapsed || collapsing}
                        open={openRow === id}
                        onOpenChange={open => setOpenRow(open ? id : undefined)}
                        actions={
                          <>
                            <SwipeAction
                              type="button"
                              $color="var(--ion-color-warning)"
                              disabled={busy}
                              onClick={errorService.catch(async () => {
                                await otpStore.forget(account.index);
                                setOpenRow(undefined);
                              })}
                            >
                              <SwipeActionIcon>
                                <AppIcon icon={broom} />
                              </SwipeActionIcon>
                              Forget
                            </SwipeAction>
                            <SwipeAction
                              type="button"
                              $color="var(--ion-color-danger)"
                              disabled={busy}
                              onClick={() => setRemove(account)}
                            >
                              <SwipeActionIcon>
                                <AppIcon icon={creditCardMinus} />
                              </SwipeActionIcon>
                              Delete
                            </SwipeAction>
                          </>
                        }
                      >
                        <AccountItem
                          className={busy ? undefined : 'ion-activatable'}
                          data-swipeable-content={
                            collapsedRow ? true : undefined
                          }
                          aria-expanded={collapsedRow ? false : undefined}
                          aria-label={
                            collapsedRow
                              ? `Show ${accounts.length} ${provider} accounts`
                              : undefined
                          }
                          disabled={busy}
                          onExpand={
                            collapsedRow
                              ? () => {
                                  setOpenRow(undefined);
                                  expand();
                                }
                              : undefined
                          }
                          onClick={() => {
                            if (busy) return;
                            setOpenRow(undefined);
                            if (active())
                              router.otp
                                .account({index: account.index})
                                .$push();
                          }}
                        >
                          <KeyListItemContent>
                            <KeyTags>
                              <AlgorithmTag $algorithm={account.algorithm}>
                                {account.algorithm.replace('SHA', 'SHA-')}
                              </AlgorithmTag>
                              <ProviderTag
                                as={
                                  !collapsedRow && accounts.length > 1
                                    ? 'button'
                                    : 'div'
                                }
                                type={
                                  !collapsedRow && accounts.length > 1
                                    ? 'button'
                                    : undefined
                                }
                                data-swipeable-content
                                title={provider}
                                aria-expanded={
                                  !collapsedRow && accounts.length > 1
                                    ? true
                                    : undefined
                                }
                                aria-label={
                                  !collapsedRow && accounts.length > 1
                                    ? `Collapse ${provider} accounts`
                                    : undefined
                                }
                                disabled={busy}
                                onClick={(event: MouseEvent<HTMLElement>) => {
                                  if (!collapsedRow && accounts.length > 1) {
                                    event.stopPropagation();
                                    setOpenRow(undefined);
                                    collapse();
                                  }
                                }}
                              >
                                {provider}
                              </ProviderTag>
                              {collapsedRow && (
                                <UnmountAnimationClone>
                                  <KeyDerivationBadge
                                    $primary
                                    $revealing
                                    aria-label={`${accounts.length} accounts`}
                                  >
                                    {accounts.length}
                                  </KeyDerivationBadge>
                                </UnmountAnimationClone>
                              )}
                            </KeyTags>
                            <AccountName
                              role={collapsedRow ? undefined : 'button'}
                              tabIndex={collapsedRow || busy ? undefined : 0}
                              aria-disabled={busy || undefined}
                              aria-label={
                                collapsedRow
                                  ? undefined
                                  : `Get codes for ${account.label}`
                              }
                              data-swipeable-content
                              title={name}
                              onKeyDown={event => {
                                if (
                                  !collapsedRow &&
                                  !busy &&
                                  (event.key === 'Enter' || event.key === ' ')
                                ) {
                                  event.preventDefault();
                                  if (!event.repeat)
                                    event.currentTarget.click();
                                }
                              }}
                            >
                              {name}
                            </AccountName>
                          </KeyListItemContent>
                          {!busy && <RippleEffect />}
                        </AccountItem>
                      </AccountRow>
                    );
                  });
                }}
              </ExpandableKeyGroup>
            ))}
          </Accounts>
        </ViewContent>
        {popup === 'menu' && (
          <DetailsPopup
            aria-label="OTP menu"
            onDismiss={() => setPopup(undefined)}
          >
            <DetailsPopupTitle>One-time Password</DetailsPopupTitle>
            <DetailsPopupDivider />
            <Buttons data-popup-animation-group>
              <Button
                onClick={() => {
                  setURI(undefined);
                  setPopup('add');
                }}
              >
                Enter manually
              </Button>
              <Button
                color="neutral"
                onClick={() => execute({type: 'authorize'}, card)}
              >
                Enable OTP on card
              </Button>
            </Buttons>
          </DetailsPopup>
        )}
        {popup === 'add' && (
          <OTPAccountPopup
            initialURI={uri}
            onDismiss={() => {
              setPopup(undefined);
              setURI(undefined);
            }}
            onSave={account => execute({type: 'add', account}, card)}
          />
        )}
        {remove && (
          <ConfirmPopup
            title="Delete from card"
            confirmColor="danger"
            confirmText="Delete"
            onCancel={() => setRemove(undefined)}
            onConfirm={() => execute({type: 'remove', account: remove})}
          >
            {remove.label}
          </ConfirmPopup>
        )}
        {pinInput}
        {scanInput}
      </View>
    );
  },
);
