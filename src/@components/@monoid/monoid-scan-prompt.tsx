import {Capacitor} from '@capacitor/core';
import {X as x} from 'lucide-react';
import type {ReactNode} from 'react';
import {useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {styled} from 'styled-components';

import type {MonoidIdHex} from '../../@atomics.js';
import {MonoidPIN} from '../../@atomics.js';
import {useEntrances} from '../../@entrances.js';
import {AppletNotFoundError} from '../../@lib/applet.js';
import {CBORAppletError} from '../../@lib/cbor-applet.js';
import {readCardInformation} from '../../@lib/global-platform/card-information.js';
import {IsoDepScanError} from '../../@lib/isodep.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidAppletHelloWithSafe,
  MonoidAppletInvalidPINError,
  MonoidCardError,
  MonoidWrongCardError,
  initializeMonoidCard,
} from '../../@lib/monoid/index.js';
import {renderIcon} from '../../@lib/render-icon.js';
import {
  type MonoidPINSession,
  isCredentialRequestCancelled,
} from '../../@services/index.js';
import {uint8ArrayToHex} from '../../@utils/index.js';
import {useToast} from '../@ui/toast.js';
import {useInputModal} from '../@ui/use-input-modal.js';

import {getPINInputPlaceholder} from './pin-input-placeholder.js';

export const MonoidScanStatePromptContentHighlight = styled.span`
  color: white;
`;

export function MonoidScanStatePromptProgress({
  children,
  current,
  total,
  showCount = total > 1,
}: {
  children: string;
  current: number;
  total: number;
  showCount?: boolean;
}): ReactNode {
  return (
    <>
      {children}, hold tight...
      {showCount && (
        <>
          <br />
          <MonoidScanStatePromptContentHighlight>
            {current}
          </MonoidScanStatePromptContentHighlight>
          /{total}
        </>
      )}
    </>
  );
}

export type MonoidScanPromptSetStateContentCallback = (
  content: ReactNode,
) => void;

export type MonoidScanPromptOptions<TSafe extends boolean = boolean> = {
  safe?: TSafe;
  ensureSetup?: boolean;
  allowInstallRedirect?: boolean;
  auth?: 'access' | false;
  retryOnError?: boolean;
  pinSession?: MonoidPINSession;
};

type MonoidScanPromptHello<TSafe extends boolean> = TSafe extends true
  ? MonoidAppletHelloWithSafe
  : MonoidAppletHello;

type MonoidScanPromptCallback<TSafe extends boolean> = (
  applet: MonoidApplet,
  setStateContent: MonoidScanPromptSetStateContentCallback,
  hello: MonoidScanPromptHello<TSafe>,
  signal: AbortSignal,
) => Promise<void>;

type MonoidScanPromptValidateCard<TSafe extends boolean> = (
  hello: MonoidScanPromptHello<TSafe>,
) => void;

type PINRequest =
  | {type: 'access'; id: MonoidIdHex}
  | {type: 'setup'; hello: MonoidAppletHelloWithSafe};

/** The scan ended quietly because another page will handle the card. */
export class MonoidScanRedirectError extends Error {
  readonly code = 'CANCELLED';

  constructor() {
    super('Card scanning was redirected.');
    this.name = new.target.name;
  }
}

export function useMonoidScanPrompt<TSafe extends boolean = false>({
  safe: includeSafe,
  ensureSetup = true,
  allowInstallRedirect = false,
  auth = false,
  retryOnError = false,
  pinSession,
}: MonoidScanPromptOptions<TSafe> = {}): [
  ReactNode,
  (
    initialStateContent: ReactNode,
    appletCallback: MonoidScanPromptCallback<TSafe>,
    validateCard?: MonoidScanPromptValidateCard<TSafe>,
  ) => Promise<void>,
] {
  const {
    router,
    monoidApplet,
    monoidCredentialsStore,
    monoidScanPromptPresenter,
    errorService,
  } = useEntrances();

  const toast = useToast();

  const [pinInput, showPINInput] = useInputModal();

  const [appletCallbackAndPromise, setAppletCallbackAndPromise] =
    useState<
      [
        ReactNode,
        MonoidScanPromptCallback<TSafe>,
        {resolve: () => void; reject: (error: unknown) => void},
        MonoidScanPromptValidateCard<TSafe> | undefined,
        MonoidPINSession,
      ]
    >();

  const [state, setState] = useState<'hidden' | 'ready' | 'scanning' | 'error'>(
    'hidden',
  );

  const [stateContent, setStateContent] = useState<ReactNode>();
  const [sessionId, setSessionId] = useState<string>();
  const [owner] = useState(() => Symbol());

  useLayoutEffect(() => {
    if (appletCallbackAndPromise && state !== 'hidden') {
      monoidScanPromptPresenter.show(owner, {
        scanning: state === 'scanning',
        sessionId,
        error: state === 'error',
        content: stateContent,
        onDismiss: () => setAppletCallbackAndPromise(undefined),
      });
    } else {
      void monoidScanPromptPresenter.hide(owner);
    }
  }, [
    monoidScanPromptPresenter,
    owner,
    appletCallbackAndPromise,
    state,
    stateContent,
    sessionId,
  ]);

  useLayoutEffect(
    () => () => {
      void monoidScanPromptPresenter.hide(owner);
    },
    [monoidScanPromptPresenter, owner],
  );

  useEffect(() => {
    if (!appletCallbackAndPromise) {
      return;
    }

    const [
      initialStateContent,
      appletCallback,
      {resolve, reject},
      validateCard,
      scanPINSession,
    ] = appletCallbackAndPromise;

    let retryStateContent = initialStateContent;
    let enteredPIN: {id: MonoidIdHex; pin: MonoidPIN} | undefined;
    let setupPIN:
      | {hello: MonoidAppletHelloWithSafe; pin: MonoidPIN}
      | undefined;
    let update:
      | {type: 'set' | 'remove'; id: MonoidIdHex; pin: MonoidPIN}
      | undefined;
    let result:
      | {type: 'success'}
      | {type: 'input'; request: PINRequest; message?: string}
      | {type: 'redirect'; navigate: () => void}
      | {type: 'uninitialized'; presented?: boolean}
      | {type: 'error'; error: unknown; retry: boolean}
      | undefined;
    let finishing = false;
    let settled = false;
    let disposed = false;
    const credentialsRequest = new AbortController();
    let pins: Partial<Record<MonoidIdHex, MonoidPIN>> = {};
    let stop: (() => Promise<void>) | undefined;

    const cancelled = (): Error =>
      Object.assign(new Error('Card scanning was cancelled.'), {
        code: 'CANCELLED',
      });

    const fail = (error: unknown): void => {
      if (disposed) {
        return;
      }

      settled = true;
      reject(error);
      setState('hidden');
      setAppletCallbackAndPromise(undefined);
    };

    const promptPIN = (request: PINRequest, errorMessage?: string): void => {
      if (disposed) {
        return;
      }

      if (errorMessage) {
        toast({
          message: errorMessage,
          color: 'danger',
          icon: renderIcon(x),
          position: 'top',
          waitForKeyboard: false,
        });
      }

      void showPINInput({
        type: 'password',
        ...(request.type === 'setup'
          ? getPINInputPlaceholder(
              'Safe',
              request.hello.safe.pin === false ? 'Set' : 'Enter existing',
            )
          : getPINInputPlaceholder('Access')),
        description:
          request.type === 'setup'
            ? request.hello.pin === false
              ? 'Will be used as initial Access PIN'
              : 'Access PIN stays the same'
            : undefined,
        center: true,
        maxLength: 16,
      }).then(value => {
        if (disposed) {
          return;
        }

        if (MonoidPIN.is(value)) {
          if (request.type === 'setup') {
            setupPIN = {hello: request.hello, pin: value};
          } else {
            enteredPIN = {id: request.id, pin: value};
          }
          setStateContent(retryStateContent);
          startScan();
        } else if (value !== undefined) {
          promptPIN(
            request,
            'Incorrect PIN format, expected 6 to 16 characters.',
          );
        } else {
          fail(cancelled());
        }
      });
    };

    const finish = async (): Promise<void> => {
      if (disposed || finishing || !result) {
        return;
      }

      finishing = true;
      const completed = result;
      result = undefined;
      const stopped = stop?.();
      stop = undefined;
      setState('hidden');

      // Both the native scan and the actual card/backdrop exit animations must finish.
      const [, hidden] = await Promise.all([
        stopped,
        monoidScanPromptPresenter.hide(
          owner,
          completed.type === 'success' ? '' : undefined,
        ),
      ]);

      if (disposed) {
        return;
      }

      if (!hidden) {
        fail(cancelled());
        return;
      }

      const pendingUpdate = update;
      update = undefined;

      if (pendingUpdate) {
        try {
          const {type, id, pin} = pendingUpdate;

          if (type === 'set') {
            await scanPINSession.setPIN(id, pin, credentialsRequest.signal);
          } else {
            await scanPINSession.removePIN(id, pin, credentialsRequest.signal);
          }
        } catch {
          if (!disposed) {
            toast({
              message:
                pendingUpdate.type === 'set'
                  ? 'Access PIN was not saved on this device.'
                  : 'The saved Access PIN could not be removed.',
              color: 'warning',
              position: 'top',
              waitForKeyboard: false,
            });
          }
        }
      }

      if (disposed) {
        return;
      }

      finishing = false;

      if (completed.type === 'input') {
        promptPIN(completed.request, completed.message);
      } else if (completed.type === 'success') {
        settled = true;
        resolve();
        setAppletCallbackAndPromise(undefined);
      } else if (completed.type === 'redirect') {
        fail(new MonoidScanRedirectError());
        completed.navigate();
      } else if (completed.type === 'uninitialized') {
        fail(cancelled());
        if (!completed.presented) {
          toast({
            message: 'Initialize card from Safe',
            color: 'warning',
            position: 'top',
            waitForKeyboard: false,
          });
        }
      } else if (completed.retry) {
        errorService.catch(Promise.reject(completed.error));
        setStateContent(retryStateContent);
        startScan();
      } else {
        fail(completed.error);
      }
    };

    const startScan = (): void => {
      if (disposed) {
        return;
      }

      setState('ready');
      setSessionId(undefined);

      stop = monoidApplet.standby(
        async applet => {
          if (disposed || finishing || result) {
            return;
          }

          setStateContent('Greeting to monoid...');

          let hello = (
            includeSafe
              ? MonoidAppletHelloWithSafe.satisfies(
                  await applet.hello({safe: true}),
                )
              : await applet.hello({})
          ) as MonoidScanPromptHello<TSafe>;

          if (disposed) {
            return;
          }

          // Verify the intended card before sending any credentials or redirecting.
          validateCard?.(hello);

          const id = uint8ArrayToHex(hello.id);
          const safe = includeSafe ? hello.safe : undefined;

          // A setup PIN belongs to the exact applet and Safe seen before input.
          if (
            setupPIN &&
            (id !== uint8ArrayToHex(setupPIN.hello.id) ||
              !safe ||
              uint8ArrayToHex(safe.publicKey) !==
                uint8ArrayToHex(setupPIN.hello.safe.publicKey))
          ) {
            throw new MonoidWrongCardError(
              uint8ArrayToHex(setupPIN.hello.safe.id),
            );
          }

          const setup = setupPIN;
          setupPIN = undefined;

          retryStateContent = safe ? (
            <>
              Scan card{' '}
              <MonoidScanStatePromptContentHighlight>
                {uint8ArrayToHex(safe.id)}
              </MonoidScanStatePromptContentHighlight>{' '}
              again
            </>
          ) : (
            'Scan card again'
          );

          let initializedAccessPIN = false;

          if (
            ensureSetup &&
            (hello.pin === false ||
              (safe && (safe.pin === false || !safe.unlocked)))
          ) {
            if (!safe) {
              result = {type: 'uninitialized'};
              return;
            }

            if (safe.pin === 0 || hello.pin === 0) {
              result = {
                type: 'error',
                error: new MonoidCardError(
                  safe.pin === 0 ? 'Safe PIN blocked' : 'Access PIN blocked',
                ),
                retry: false,
              };
              return;
            }

            const setupHello = MonoidAppletHelloWithSafe.satisfies(hello);

            // Re-prompt if another operation initialized the Safe since input.
            if (
              !setup ||
              (setup.hello.safe.pin === false && safe.pin !== false)
            ) {
              result = {
                type: 'input',
                request: {type: 'setup', hello: setupHello},
              };
              return;
            }

            setStateContent(
              safe.pin === false ? 'Setting Safe PIN...' : 'Unlocking safe...',
            );

            const needsAccessPIN = hello.pin === false;

            try {
              hello = (await initializeMonoidCard(
                applet,
                setupHello,
                setup.pin,
                credentialsRequest.signal,
              )) as MonoidScanPromptHello<TSafe>;
            } catch (error) {
              if (disposed) return;

              if (
                error instanceof CBORAppletError &&
                MonoidAppletInvalidPINError.is(error.source)
              ) {
                if (error.source.tries === 0) {
                  result = {
                    type: 'error',
                    error: new MonoidCardError('Safe PIN blocked', {
                      cause: error,
                    }),
                    retry: false,
                  };
                  return;
                }

                result = {
                  type: 'input',
                  request: {
                    type: 'setup',
                    hello: {
                      ...setupHello,
                      safe: {...safe, pin: error.source.tries},
                    },
                  },
                  message: `Incorrect Safe PIN, tries remaining: ${error.source.tries}`,
                };
                return;
              }

              throw error;
            }

            if (disposed) return;

            // Only an unset Access PIN inherits the Safe PIN during setup.
            if (needsAccessPIN) {
              enteredPIN = {id, pin: setup.pin};
              initializedAccessPIN = true;
            }
          }

          if (auth === 'access' || initializedAccessPIN) {
            const entered = enteredPIN?.id === id ? enteredPIN.pin : undefined;

            enteredPIN = undefined;

            const pin = entered ?? pins[id];

            if (disposed) {
              return;
            }

            if (pin === undefined) {
              result = {type: 'input', request: {type: 'access', id}};

              return;
            }

            setStateContent('Authenticating...');

            try {
              await applet.authenticate({pin});
            } catch (error) {
              if (disposed) {
                return;
              }

              if (
                error instanceof CBORAppletError &&
                MonoidAppletInvalidPINError.is(error.source)
              ) {
                if (error.source.tries === 0) {
                  throw new MonoidCardError('Access PIN blocked', {
                    cause: error,
                  });
                }

                if (entered === undefined) {
                  delete pins[id];
                  scanPINSession.forgetPIN(id, pin);
                  update = {type: 'remove', id, pin};
                }

                result = {
                  type: 'input',
                  request: {type: 'access', id},
                  message: `Incorrect PIN, tries remaining: ${error.source.tries}`,
                };

                return;
              }

              throw error;
            }

            if (disposed) {
              return;
            }

            if (entered !== undefined) {
              pins[id] = entered;
              scanPINSession.rememberPIN(id, entered);
            }

            if (
              entered !== undefined ||
              scanPINSession.hasUnsavedPIN(id, pin)
            ) {
              update = {type: 'set', id, pin};
            }
          }

          if (disposed) {
            return;
          }

          await appletCallback(
            applet,
            content => {
              if (
                !disposed &&
                !finishing &&
                !credentialsRequest.signal.aborted
              ) {
                setStateContent(content);
              }
            },
            hello,
            credentialsRequest.signal,
          );

          if (disposed) {
            return;
          }

          result = {type: 'success'};
          setStateContent('');
        },
        error => {
          if (disposed) {
            return;
          }

          if (error instanceof AppletNotFoundError) {
            update = undefined;
            if (!ensureSetup) {
              result = {
                type: 'error',
                error: new MonoidCardError('Monoid not installed'),
                retry: false,
              };
            } else {
              result = {type: 'uninitialized'};
            }
            return;
          }

          const tagLost =
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'TAG_LOST';

          if (error instanceof IsoDepScanError || tagLost) {
            update = undefined;
          }

          result = {
            type: 'error',
            error: tagLost ? cancelled() : error,
            retry:
              retryOnError &&
              // Leave the NFC sheet closed so the user can read the error.
              Capacitor.getPlatform() !== 'ios' &&
              !tagLost &&
              !(error instanceof IsoDepScanError) &&
              !isCredentialRequestCancelled(error),
          };
        },
        () => {
          void finish().catch(fail);
        },
        (connected, nativeSessionId) => {
          if (disposed) return;
          setSessionId(
            connected && !finishing && !result ? nativeSessionId : undefined,
          );
          if (!finishing && !result) {
            setState(connected ? 'scanning' : 'ready');
          }
        },
        () => {
          // Core NFC covers the WebView. Close its sheet before presenting errors.
          if (Capacitor.getPlatform() === 'ios') {
            return !disposed && !finishing && result?.type === 'success'
              ? {message: ''}
              : {};
          }

          if (
            disposed ||
            !result ||
            result.type === 'success' ||
            result.type === 'input' ||
            result.type === 'redirect' ||
            (result.type === 'error' &&
              (result.error instanceof IsoDepScanError ||
                isCredentialRequestCancelled(result.error)))
          ) {
            return {};
          }

          setState('error');

          if (result.type === 'uninitialized') {
            setStateContent('Initialize card from Safe');
            result.presented = true;
          } else {
            setStateContent(
              result.error instanceof MonoidWrongCardError ? (
                <>
                  Wrong card, scan{' '}
                  <MonoidScanStatePromptContentHighlight>
                    {result.error.expectedId}
                  </MonoidScanStatePromptContentHighlight>
                </>
              ) : result.error instanceof Error ? (
                result.error.message
              ) : (
                String(result.error)
              ),
            );
            result.error = errorService.markPresented(result.error);
          }

          return {waitForRemoval: true};
        },
        allowInstallRedirect
          ? async sessionId => {
              if (disposed || finishing || result) return;

              setStateContent('Reading card information...');
              const cardInformation = await readCardInformation(
                sessionId,
                credentialsRequest.signal,
              );

              if (disposed || finishing) return;

              result = {
                type: 'redirect',
                navigate: () =>
                  router.safe.setupCard({cardInformation}).$replace(),
              };
            }
          : undefined,
      );
    };

    const start = async (): Promise<void> => {
      if (auth === 'access') {
        const saved = await scanPINSession.getPINs(credentialsRequest.signal);

        if (disposed) {
          return;
        }

        pins = {...saved};
      }

      startScan();
    };

    void start().catch(fail);

    return () => {
      disposed = true;
      credentialsRequest.abort();
      pins = {};
      enteredPIN = undefined;
      setupPIN = undefined;
      update = undefined;
      result = undefined;
      void stop?.().catch(error => errorService.catch(Promise.reject(error)));

      if (!settled) {
        reject(cancelled());
      }
    };
  }, [
    monoidApplet,
    monoidCredentialsStore,
    pinSession,
    monoidScanPromptPresenter,
    owner,
    errorService,
    includeSafe,
    ensureSetup,
    allowInstallRedirect,
    auth,
    retryOnError,
    router.safe,
    appletCallbackAndPromise,
    showPINInput,
    toast,
  ]);

  return [
    pinInput,
    useCallback(
      async (initialStateContent, appletCallback, validateCard) => {
        let completed = false;
        try {
          // A borrowed page session survives scan cleanup; a temporary one spans the
          // complete scan, including PIN retries, exit animation, and deferred save.
          await using temporarySession = pinSession
            ? undefined
            : monoidCredentialsStore.createPINSession();
          const scanPINSession = pinSession ?? temporarySession!;

          await new Promise<void>((resolve, reject) => {
            setState('hidden');
            setStateContent(initialStateContent);

            setAppletCallbackAndPromise([
              initialStateContent,
              appletCallback,
              {resolve, reject},
              validateCard,
              scanPINSession,
            ]);
          });
          completed = true;
        } catch (error) {
          if (!completed) throw error;
          // Closing storage access cannot undo an already completed card operation.
          errorService.catch(Promise.reject(error));
        }
      },
      [monoidCredentialsStore, pinSession, errorService],
    ),
  ];
}
