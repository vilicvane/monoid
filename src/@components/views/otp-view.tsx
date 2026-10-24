import {App} from '@capacitor/app';
import {Ellipsis as ellipsis, Trash2 as trash} from 'lucide-react';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {MonoidPIN} from '../../@atomics.js';
import {useEntrances} from '../../@entrances.js';
import {
  MonoidCardError,
  MonoidWrongCardError,
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
import {isCredentialRequestCancelled} from '../../@services/index.js';
import type {OTPAccount, OTPCard} from '../../@services/otp-store.js';
import {uint8ArrayToHex} from '../../@utils/index.js';
import {
  ExpandableKeyGroup,
  KeyGroupItem,
  keyGroupReveal,
} from '../@key/expandable-key-group.js';
import {KeyList, KeyListItemContent} from '../@key/key-list.js';
import {KeyDerivationBadge, KeyTags} from '../@key/key-tags.js';
import {
  MonoidScanRedirectError,
  MonoidScanStatePromptContentHighlight,
  useMonoidScanPrompt,
} from '../@monoid/monoid-scan-prompt.js';
import {getPINInputPlaceholder} from '../@monoid/pin-input-placeholder.js';
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
function groupAccounts(accounts: readonly OTPAccount[]) {
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
    const {router, otpStore, monoidCredentialsStore, cardStore, errorService} =
      useEntrances();
    const active = useViewActive(view);
    const [requestedCard] = useState(() => view.card);
    const [card, setCard] = useState<OTPCard>();
    const [busy, setBusy] = useState(false);
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
    const controller = useRef<AbortController | undefined>(undefined);
    const scanning = useRef(false);
    const mounted = useRef(true);
    const groups = groupAccounts(otpStore.accounts);

    useEffect(() => {
      mounted.current = true;
      const clear = (): void => {
        controller.current?.abort();
        pinSession.clear();
        setPopup(undefined);
        setURI(undefined);
        setRemove(undefined);
        setCard(undefined);
      };
      const dispose = reaction(active, value => {
        if (!value) clear();
      });
      const background = (): void => {
        // Biometric unlock can briefly deactivate the app before NFC begins.
        // Cancelling that authorization here would prevent the one-tap flow.
        if (scanning.current) controller.current?.abort();
        setPopup(undefined);
        setURI(undefined);
        setRemove(undefined);
        if (!controller.current) pinSession.clear();
      };
      const visibility = (): void => {
        if (document.hidden) background();
      };
      document.addEventListener('visibilitychange', visibility);
      const listener = App.addListener('appStateChange', ({isActive}) => {
        if (!isActive) background();
      });
      return () => {
        mounted.current = false;
        controller.current?.abort();
        pinSession.clear();
        dispose();
        document.removeEventListener('visibilitychange', visibility);
        void listener.then(handle => handle.remove());
      };
    }, [active, pinSession]);

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
      expected?: Pick<OTPCard, 'id' | 'publicKey'>,
    ): Promise<void> {
      if (controller.current || !active()) return;
      const task = new AbortController();
      controller.current = task;
      setBusy(true);
      setPopup(undefined);
      setURI(undefined);
      setOpenRow(undefined);
      setRemove(undefined);
      let installed = true;
      try {
        let pins;
        try {
          pins = await pinSession.getPINs(task.signal);
        } catch (error) {
          pinSession.clear();
          throw error;
        }
        task.signal.throwIfAborted();
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
                  maxLength: 16,
                  description,
                },
                task.signal,
              );
              if (value === undefined) return;
              task.signal.throwIfAborted();
              if (MonoidPIN.is(value)) {
                pinSession.rememberPIN(expected.id, value);
                break;
              }
              description = 'Use 6 to 16 ASCII characters';
            }
          }
        }
        task.signal.throwIfAborted();
        if (!active()) return;
        scanning.current = true;
        await scan(
          expected ? (
            <>
              Scan card{' '}
              <MonoidScanStatePromptContentHighlight>
                {expected.id}
              </MonoidScanStatePromptContentHighlight>
            </>
          ) : (
            'Scan a card'
          ),
          async (applet, setState, hello, scanSignal) => {
            const signal = AbortSignal.any([task.signal, scanSignal]);
            const identity = {
              id: uint8ArrayToHex(hello.id),
              publicKey: uint8ArrayToHex(hello.publicKey),
            };
            const changed = (): void => cardStore.forget(identity);
            signal.throwIfAborted();
            let accounts: OTPAccount[] | undefined;
            if (operation.type === 'add') {
              setState('Adding account, hold tight...');
              accounts = await addOTPAccount(
                applet,
                operation.account,
                signal,
                changed,
              );
            } else if (operation.type === 'remove') {
              setState('Removing account, hold tight...');
              accounts = await removeOTPAccount(
                applet,
                operation.account,
                signal,
                changed,
                installed,
              );
            } else if (operation.type === 'authorize') {
              setState('Enabling OTP, hold tight...');
              accounts = await authorizeOTPAccounts(applet, signal);
            }
            let next: OTPCard;
            if (accounts) {
              // Successful writes and the fresh grant are authoritative for this tap.
              next = {...identity, accounts, installed, authorized: installed};
            } else {
              setState('Reading accounts, hold tight...');
              next = await readOTPCard(applet, hello, signal);
            }
            signal.throwIfAborted();
            await otpStore.save(next.accounts);
            if (active() && mounted.current) {
              setCard(next);
            }
          },
          hello => {
            task.signal.throwIfAborted();
            if (!active()) throw new MonoidScanRedirectError();
            if (
              expected &&
              (uint8ArrayToHex(hello.id) !== expected.id ||
                uint8ArrayToHex(hello.publicKey) !== expected.publicKey)
            )
              throw new MonoidWrongCardError(expected.id);
            if (hello.pins.access === false || hello.pins.secret === false) {
              throw new MonoidCardError('Set up card PINs first');
            }
            if (hello.pins.access === 0)
              throw new MonoidCardError('Access PIN blocked');
            otpStore.authorityHint = hello.authority;
          },
          task.signal,
          operation.type === 'add' || operation.type === 'remove'
            ? {
                prepare: async (applet, setState, _hello, scanSignal) => {
                  const signal = AbortSignal.any([task.signal, scanSignal]);
                  setState('Checking OTP, hold tight...');
                  installed = await isOTPInstalled(applet, signal);
                  if (operation.type === 'add' && !installed)
                    throw new MonoidCardError(
                      'OTP is not installed on this card',
                    );
                },
              }
            : undefined,
        );
      } catch (error) {
        if (
          !task.signal.aborted &&
          !isCredentialRequestCancelled(error) &&
          !(error instanceof Error && error.name === 'AbortError')
        ) {
          throw error;
        }
      } finally {
        if (operation.type === 'add') operation.account.secret.fill(0);
        scanning.current = false;
        if (controller.current === task) controller.current = undefined;
        if (mounted.current) setBusy(false);
      }
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
                              disabled={busy}
                              onClick={errorService.catch(async () => {
                                await otpStore.forget(account.index);
                                setOpenRow(undefined);
                              })}
                            >
                              <SwipeActionIcon>
                                <AppIcon icon={trash} />
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
                                <AppIcon icon={trash} />
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
