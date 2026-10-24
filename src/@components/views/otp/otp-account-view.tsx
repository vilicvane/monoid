import {App} from '@capacitor/app';
import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {keyframes, styled} from 'styled-components';
import {UnmountAnimationClone} from 'unmount-animation-clone';

import {useEntrances} from '../../../@entrances.js';
import {MonoidCardError} from '../../../@lib/monoid/index.js';
import {
  OTPAuthorityWarmup,
  getDefaultOTPAuthorityUrl,
} from '../../../@lib/otp-authority.js';
import {assertOTPAccounts} from '../../../@lib/otp-card.js';
import {
  type OTPBatch,
  OTP_AID,
  type PreparedOTP,
  calculatePreparedOTP,
  currentOTPCode,
  otpCodeState,
  prepareOTP,
} from '../../../@lib/otp.js';
import type {Router} from '../../../@routes.js';
import {isCredentialRequestCancelled} from '../../../@services/index.js';
import {hexToUint8Array} from '../../../@utils/index.js';
import {fadeInAnimationCSS, popOutAnimationCSS} from '../../@animations.js';
import {
  MonoidScanRedirectError,
  useMonoidScanPrompt,
} from '../../@monoid/monoid-scan-prompt.js';
import {Button, Buttons} from '../../@ui/button.js';
import {CopyButton} from '../../@ui/copy-button.js';
import {WhiteTag} from '../../@ui/tag.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTags,
  ViewHeaderTitle,
  ViewPlaceholder,
  useViewActive,
  viewHeaderTagCSS,
} from '../../@view/index.js';

import {splitOTPAccountLabel} from './otp-account-label.js';

const AccountHeader = styled(ViewHeader)`
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
`;
const AccountTitle = styled(ViewHeaderTitle)`
  grid-column: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
const Provider = styled(WhiteTag)`
  ${viewHeaderTagCSS}
  display: block;
  align-content: center;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 20px;
`;
const CodeStage = styled.div`
  flex: 1;
  min-height: 200px;
  display: grid;
  place-items: center;
  padding-bottom: 32px;
`;
const CodeArea = styled.div`
  grid-area: 1 / 1;
  width: 100%;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  &.unmount {
    ${popOutAnimationCSS}
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    &.unmount {
      animation-duration: 0s;
    }
  }
`;
const EmptyState = styled(ViewPlaceholder)`
  grid-area: 1 / 1;
  ${fadeInAnimationCSS}
  animation-delay: 200ms;
  animation-fill-mode: both;

  @media (prefers-reduced-motion: reduce) {
    animation-duration: 0s;
    animation-delay: 0s;
  }
`;
const Code = styled(CopyButton)`
  color: var(--ion-color-dark);
  font-size: clamp(40px, 13vw, 56px);
  font-variant-numeric: tabular-nums;
  letter-spacing: 2px;
  transition: color 150ms ease-out;

  &[data-copied='true'] {
    color: var(--ion-color-safe);
  }
`;
const Windows = styled.div`
  display: flex;
  align-items: center;
`;
const countdownExit = keyframes`
  from { width: 48px; opacity: 1; transform: scale(1); }
  to { width: 0; opacity: 0; transform: scale(0.5); }
`;
const CountdownSlot = styled.div`
  width: 48px;
  flex-shrink: 0;
  display: grid;
  place-items: center;

  &.unmount {
    ${popOutAnimationCSS}
    animation-name: ${countdownExit};
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    &.unmount {
      animation-duration: 0s;
    }
  }
`;
const Countdown = styled.div<{$pending: boolean; $ending: boolean}>`
  position: relative;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  color: ${props =>
    props.$pending
      ? 'color-mix(in srgb, var(--ion-color-medium) 40%, var(--ion-background-color, white))'
      : props.$ending
        ? 'var(--color-text-warning)'
        : 'var(--ion-color-primary)'};
  font-size: 14px;
  font-variant-numeric: proportional-nums;
  transition: color 150ms ease-out;

  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
    fill: none;
    stroke: currentColor;
    stroke-width: 6;
  }
`;
const CountdownValue = styled.span`
  line-height: 1;
  transform: translateY(1px);
`;

export const OTPAccountView = observer(
  ({view}: RouteComponentProps<Router['otp']['account']>): ReactNode => {
    const {otpStore, monoidCredentialsStore, errorService} = useEntrances();
    const active = useViewActive(view);
    const [index] = useState(() => view.index);
    const account = otpStore.accounts.find(account => account.index === index);
    const [batch, setBatch] = useState<OTPBatch>();
    const [clock, setClock] = useState(() => performance.now());
    const [busy, setBusy] = useState(false);
    const [pinSession] = useState(() =>
      monoidCredentialsStore.createPINSession(),
    );
    const [scanInput, scan] = useMonoidScanPrompt({
      auth: 'access',
      ensureSetup: false,
      pinSession,
    });
    const controller = useRef<AbortController | undefined>(undefined);
    const scanning = useRef(false);
    const mounted = useRef(true);
    const started = useRef(false);
    const animateExit = useRef(true);

    const prepareExit = (clone: HTMLElement): void => {
      clone.inert = true;
      clone.setAttribute('aria-hidden', 'true');
      if (!animateExit.current || !active() || document.hidden) clone.remove();
    };

    useEffect(() => {
      mounted.current = true;
      const clear = (): void => {
        animateExit.current = false;
        controller.current?.abort();
        pinSession.clear();
        setBatch(undefined);
      };
      const dispose = reaction(active, value => {
        if (!value) clear();
      });
      const background = (): void => {
        animateExit.current = false;
        // The biometric prompt can deactivate the app before NFC starts.
        if (scanning.current) controller.current?.abort();
        setBatch(undefined);
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
        clear();
        dispose();
        document.removeEventListener('visibilitychange', visibility);
        void listener.then(handle => handle.remove());
      };
    }, [active, pinSession]);

    useEffect(() => {
      let disposed = false;
      const dispose = reaction(
        active,
        value => {
          if (!value) return;
          queueMicrotask(() => {
            if (disposed || started.current || !active() || !account) return;
            started.current = true;
            errorService.catch(run());
          });
        },
        {fireImmediately: true},
      );
      return () => {
        disposed = true;
        dispose();
      };
      // `run` is recreated each render; `started` keeps this to one start per mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, account]);

    useEffect(() => {
      if (!batch) return;
      const tick = (): void => {
        const now = performance.now();
        setClock(now);
        if (batch.items.every(item => otpCodeState(batch, item, now).exhausted))
          setBatch(undefined);
      };
      tick();
      const timer = setInterval(tick, 100);
      return () => clearInterval(timer);
    }, [batch]);

    async function run(): Promise<void> {
      if (!account || controller.current || !active()) return;
      const task = new AbortController();
      controller.current = task;
      setBusy(true);
      const warmup = new OTPAuthorityWarmup(task.signal);
      warmup.start(otpStore.authorityHint ?? getDefaultOTPAuthorityUrl());
      let prepared: PreparedOTP | undefined;
      try {
        try {
          await pinSession.getPINs(task.signal);
        } catch (error) {
          pinSession.clear();
          throw error;
        }
        task.signal.throwIfAborted();
        if (!active()) return;
        scanning.current = true;
        await scan(
          'Scan a card',
          async (applet, setState, _hello, scanSignal) => {
            const signal = AbortSignal.any([task.signal, scanSignal]);
            setState('Getting codes, hold tight...');
            await assertOTPAccounts(applet, [account], signal);
            const value = await calculatePreparedOTP(prepared!, applet, signal);
            signal.throwIfAborted();
            if (active() && mounted.current && !document.hidden) {
              animateExit.current = true;
              setClock(performance.now());
              setBatch(value);
            }
          },
          hello => {
            task.signal.throwIfAborted();
            if (!active()) throw new MonoidScanRedirectError();
            if (hello.pins.access === false || hello.pins.secret === false)
              throw new MonoidCardError('Set up card PINs first');
            if (hello.pins.access === 0)
              throw new MonoidCardError('Access PIN blocked');
            otpStore.authorityHint = hello.authority;
            warmup.start(hello.authority);
          },
          task.signal,
          {
            aid: OTP_AID,
            prepare: async (applet, setState, hello, scanSignal) => {
              const signal = AbortSignal.any([task.signal, scanSignal]);
              prepared = await prepareOTP(
                applet,
                [hexToUint8Array(account.index)],
                hello.authority,
                signal,
                stage =>
                  setState(
                    stage === 'time'
                      ? 'Getting time, hold tight...'
                      : 'Preparing, hold tight...',
                  ),
              );
            },
          },
        );
      } catch (error) {
        if (
          !task.signal.aborted &&
          !isCredentialRequestCancelled(error) &&
          !(error instanceof Error && error.name === 'AbortError')
        )
          throw error;
      } finally {
        warmup.stop();
        scanning.current = false;
        if (controller.current === task) controller.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }

    const item = batch?.items.find(item => item.index === index);
    const state = batch && item ? otpCodeState(batch, item, clock) : undefined;
    const {provider, name} = splitOTPAccountLabel(account?.label ?? '');
    return (
      <View>
        <AccountHeader>
          <AccountTitle title={name}>{name || 'OTP'}</AccountTitle>
          {provider && (
            <ViewHeaderTags>
              <Provider title={provider}>{provider}</Provider>
            </ViewHeaderTags>
          )}
        </AccountHeader>
        <ViewContent
          footer={
            account && (
              <Buttons>
                <Button
                  color={state?.current ? 'neutral' : 'primary'}
                  disabled={busy}
                  onClick={() => errorService.catch(run())}
                >
                  Scan again
                </Button>
              </Buttons>
            )
          }
        >
          <CodeStage>
            {!account ? (
              <EmptyState>Account not found</EmptyState>
            ) : state?.current ? (
              <UnmountAnimationClone onUnmountClone={prepareExit}>
                <CodeArea>
                  <Code
                    label={`Copy code for ${account.label}`}
                    showIcon={false}
                    value={() =>
                      active() && !document.hidden && batch && item
                        ? currentOTPCode(batch, item)?.code
                        : undefined
                    }
                  >
                    {state.current.code.slice(0, state.current.code.length / 2)}{' '}
                    {state.current.code.slice(state.current.code.length / 2)}
                  </Code>
                  <Windows
                    role="group"
                    aria-label={`${state.prefetched + 1} code windows remaining`}
                  >
                    {Array.from({length: state.prefetched + 1}, (_, offset) => {
                      const pending = offset > 0;
                      const fraction = pending ? 1 : state.progress;
                      const remaining = pending
                        ? item!.period
                        : state.current!.remaining;
                      return (
                        <UnmountAnimationClone
                          key={
                            item!.codes.length - state.prefetched - 1 + offset
                          }
                          onUnmountClone={prepareExit}
                        >
                          <CountdownSlot>
                            <Countdown
                              $pending={pending}
                              $ending={!pending && remaining <= 10}
                              role={pending ? undefined : 'timer'}
                              aria-label={
                                pending
                                  ? `Next code, ${remaining} seconds`
                                  : `${remaining} seconds remaining`
                              }
                            >
                              <svg viewBox="0 0 84 84" aria-hidden="true">
                                <circle cx="42" cy="42" r="38" opacity="0.12" />
                                <circle
                                  cx="42"
                                  cy="42"
                                  r="38"
                                  pathLength="1"
                                  strokeDasharray={`${fraction} 1`}
                                  strokeDashoffset={fraction - 1}
                                  strokeLinecap="round"
                                />
                              </svg>
                              <CountdownValue>{remaining}</CountdownValue>
                            </Countdown>
                          </CountdownSlot>
                        </UnmountAnimationClone>
                      );
                    })}
                  </Windows>
                </CodeArea>
              </UnmountAnimationClone>
            ) : (
              <EmptyState>Scan a card to get codes</EmptyState>
            )}
          </CodeStage>
        </ViewContent>
        {scanInput}
      </View>
    );
  },
);
