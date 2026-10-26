import {Capacitor} from '@capacitor/core';
import {X as x} from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';
import {styled} from 'styled-components';

import {type MonoidIdHex, MonoidPIN} from '../../@atomics.js';
import {useEntrances} from '../../@entrances.js';
import {AppletNotFoundError} from '../../@lib/applet.js';
import {CBORAppletError} from '../../@lib/cbor-applet.js';
import {readCardInformation} from '../../@lib/global-platform/card-information.js';
import {IsoDepScanError} from '../../@lib/isodep.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidAppletInvalidPINError,
  MonoidCardError,
  MonoidWrongCardError,
  assertCardPINsNotBlocked,
  assertSameCardWithBundle,
  initializeMonoidCard,
  readBackupCardIdentity,
} from '../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../@lib/operation-cancelled.js';
import {renderIcon} from '../../@lib/render-icon.js';
import {type MonoidPINSession} from '../../@services/index.js';
import {uint8ArrayToHex} from '../../@utils/index.js';
import {useToast} from '../@ui/toast.js';
import {useInputModal} from '../@ui/use-input-modal.js';

import {getPINInputPlaceholder} from './pin-input-placeholder.js';
import {type CardSetupPINs, requestCardPINs} from './request-card-pins.js';

export const MonoidScanStatePromptContentHighlight = styled.span`
  color: white;
`;

export function scanCardPrompt(id: string, action?: string): ReactNode {
  return (
    <>
      Scan card{' '}
      <MonoidScanStatePromptContentHighlight>
        {id}
      </MonoidScanStatePromptContentHighlight>
      {action && ` ${action}`}
    </>
  );
}

export function MonoidScanStatePromptProgress({
  children,
  current,
  total,
}: {
  children: string;
  current: number;
  total: number;
}): ReactNode {
  const showCount = total > 1;

  return (
    <>
      {children}
      {showCount ? '...' : ', hold tight...'}
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

export type MonoidScanPromptOptions = {
  allowSetup?: boolean;
  ensureSetup?: boolean;
  allowInstallRedirect?: boolean;
  auth?: 'access' | false;
  retryOnError?: boolean;
  pinSession?: MonoidPINSession;
};

export type MonoidScanPromptCallback = (
  applet: MonoidApplet,
  setStateContent: MonoidScanPromptSetStateContentCallback,
  hello: MonoidAppletHello,
  signal: AbortSignal,
) => Promise<void | {message: string}>;

export type MonoidScanPromptValidateCard = (hello: MonoidAppletHello) => void;

export type MonoidScanAuthentication = {
  aid?: Uint8Array;
  prepare: MonoidScanPromptCallback;
};

export type MonoidScanPrompt = (
  initialStateContent: ReactNode,
  appletCallback: MonoidScanPromptCallback,
  validateCard?: MonoidScanPromptValidateCard,
  signal?: AbortSignal,
  authentication?: MonoidScanAuthentication,
) => Promise<void>;

type PINRequest =
  | {type: 'access'; id: MonoidIdHex}
  | {type: 'setup'; hello: MonoidAppletHello};

/** The scan ended quietly because another page will handle the card. */
export class MonoidScanRedirectError extends Error {
  readonly code = 'CANCELLED';

  constructor() {
    super('Card scanning was redirected.');
    this.name = new.target.name;
  }
}

export function useMonoidScanPrompt({
  allowSetup = false,
  ensureSetup = true,
  allowInstallRedirect = false,
  auth = false,
  retryOnError = false,
  pinSession,
}: MonoidScanPromptOptions = {}): [ReactNode, MonoidScanPrompt] {
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
        MonoidScanPromptCallback,
        {resolve: () => void; reject: (error: unknown) => void},
        MonoidScanPromptValidateCard | undefined,
        MonoidPINSession,
        AbortSignal | undefined,
        MonoidScanAuthentication | undefined,
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
      operationSignal,
      authentication,
    ] = appletCallbackAndPromise;

    let retryStateContent = initialStateContent;
    let enteredPIN: {id: MonoidIdHex; pin: MonoidPIN} | undefined;
    let setupPIN: {hello: MonoidAppletHello; pins: CardSetupPINs} | undefined;
    let update:
      | {type: 'set' | 'remove'; id: MonoidIdHex; pin: MonoidPIN}
      | undefined;
    let result:
      | {type: 'success'; message?: string}
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
    let stopping: Promise<void> | undefined;

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

      void (async () => {
        if (request.type === 'setup') {
          const saved = await scanPINSession.getPINs(credentialsRequest.signal);
          const setup = await requestCardPINs(
            showPINInput,
            {
              secretSet: request.hello.pins.secret !== false,
              accessSet: request.hello.pins.access !== false,
              savedAccessPIN: saved[uint8ArrayToHex(request.hello.id)],
            },
            credentialsRequest.signal,
          );
          if (disposed) return;
          if (!setup) {
            fail(cancelled());
            return;
          }
          setupPIN = {hello: request.hello, pins: setup};
        } else {
          const value = await showPINInput(
            {
              type: 'password',
              ...getPINInputPlaceholder('Access'),
              center: true,
              maxLength: 16,
            },
            credentialsRequest.signal,
          );
          if (disposed) return;
          if (value === undefined) {
            fail(cancelled());
            return;
          }
          if (!MonoidPIN.is(value)) {
            promptPIN(
              request,
              'Incorrect PIN format, expected 6 to 16 characters.',
            );
            return;
          }
          enteredPIN = {id: request.id, pin: value};
        }
        setStateContent(retryStateContent);
        startScan();
      })().catch(fail);
    };

    const finish = async (): Promise<void> => {
      if (disposed || finishing || !result) {
        return;
      }

      finishing = true;
      const completed = result;
      result = undefined;
      const stopped = (stopping = stop?.());
      stop = undefined;
      setState('hidden');

      // Both the native scan and the actual card/backdrop exit animations must finish.
      const [, hidden] = await Promise.all([
        stopped,
        monoidScanPromptPresenter.hide(
          owner,
          completed.type === 'success' ? (completed.message ?? '') : undefined,
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
      stopping = undefined;

      stop = monoidApplet.standby(
        async applet => {
          if (disposed || finishing || result) {
            return;
          }

          setStateContent('Greeting to monoid, hold tight...');

          let hello = await applet.hello({});

          if (disposed) {
            return;
          }

          // Verify the intended card before sending any credentials or redirecting.
          validateCard?.(hello);

          const id = uint8ArrayToHex(hello.id);

          // A setup PIN belongs to the exact Identity seen before input.
          if (setupPIN)
            assertSameCardWithBundle(
              hello,
              readBackupCardIdentity(setupPIN.hello),
            );

          const setup = setupPIN;
          setupPIN = undefined;

          retryStateContent = scanCardPrompt(id, 'again');

          let initializedAccessPIN = false;

          if (
            ensureSetup &&
            (hello.pins.access === false || hello.pins.secret === false)
          ) {
            if (!allowSetup) {
              result = {type: 'uninitialized'};
              return;
            }

            try {
              assertCardPINsNotBlocked(hello);
            } catch (error) {
              result = {type: 'error', error, retry: false};
              return;
            }

            const setupHello = hello;

            // Re-prompt if another operation set the Secret PIN since input.
            if (
              !setup ||
              (setup.hello.pins.secret === false && hello.pins.secret !== false)
            ) {
              result = {
                type: 'input',
                request: {type: 'setup', hello: setupHello},
              };
              return;
            }

            setStateContent(
              hello.pins.secret === false
                ? 'Setting Secret PIN, hold tight...'
                : 'Setting Access PIN, hold tight...',
            );

            const needsAccessPIN = hello.pins.access === false;

            try {
              hello = await initializeMonoidCard(
                applet,
                setupHello,
                setup.pins.secret,
                credentialsRequest.signal,
                setup.pins.access,
              );
            } catch (error) {
              if (disposed) return;

              if (
                error instanceof CBORAppletError &&
                MonoidAppletInvalidPINError.is(error.source)
              ) {
                if (error.source.tries === 0) {
                  result = {
                    type: 'error',
                    error: new MonoidCardError('Secret PIN blocked', {
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
                      pins: {...setupHello.pins, secret: error.source.tries},
                    },
                  },
                  message: `Incorrect Secret PIN, tries remaining: ${error.source.tries}`,
                };
                return;
              }

              throw error;
            }

            if (disposed) return;

            // Authenticate and save the Access PIN selected for this setup.
            if (needsAccessPIN) {
              enteredPIN = {id, pin: setup.pins.access!};
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

            // Prepare on this connection before authenticating. Clients may
            // also request an applet-specific single-use permission.
            if (authentication) {
              await authentication.prepare(
                applet,
                content => {
                  if (!disposed) setStateContent(content);
                },
                hello,
                credentialsRequest.signal,
              );
              credentialsRequest.signal.throwIfAborted();
              await applet.useSession(applet);
            }

            setStateContent('Authenticating, hold tight...');

            try {
              await applet.authenticate({
                pin,
                ...(authentication?.aid && {aid: authentication.aid}),
              });
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

          const completion = await appletCallback(
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

          result = {type: 'success', message: completion?.message};
          setStateContent(completion?.message ?? '');
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
                error: new MonoidCardError('Monoid not installed', {
                  cause: error,
                }),
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
              !isOperationCancelled(error),
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
            if (disposed || finishing || !result) return {};
            if (result.type === 'success') {
              return {message: result.message ?? ''};
            }

            // A rejected PIN still has a healthy NFC connection. End the sheet
            // as a failure before asking for another PIN, rather than checking it off.
            if (result.type === 'input' && result.message) {
              return {errorMessage: result.message};
            }

            if (result.type === 'uninitialized') {
              return {errorMessage: 'Initialize card from Safe'};
            }

            if (
              result.type === 'error' &&
              !(result.error instanceof IsoDepScanError) &&
              !isOperationCancelled(result.error)
            ) {
              const {error} = result;
              let errorMessage = 'Card operation failed.';

              if (error instanceof MonoidCardError) {
                errorMessage = error.message;
              } else if (
                error instanceof CBORAppletError &&
                MonoidAppletInvalidPINError.is(error.source)
              ) {
                errorMessage =
                  error.source.tries === 0
                    ? 'PIN blocked'
                    : `Incorrect PIN, tries remaining: ${error.source.tries}`;
              }

              return {errorMessage};
            }

            return {};
          }

          if (!disposed && !finishing && result?.type === 'success') {
            if (!result.message) return {};
            setState('ready');
            return {waitForRemoval: true};
          }

          if (
            disposed ||
            !result ||
            result.type === 'success' ||
            result.type === 'input' ||
            result.type === 'redirect' ||
            (result.type === 'error' &&
              (result.error instanceof IsoDepScanError ||
                isOperationCancelled(result.error)))
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

              setStateContent('Reading card information, hold tight...');
              const cardInformation = await readCardInformation(
                sessionId,
                credentialsRequest.signal,
              );

              if (disposed || finishing) return;

              result = {
                type: 'redirect',
                navigate: () =>
                  router
                    .cardApplets({cardInformation, returnTo: 'safe'})
                    .$replace(),
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

    const dispose = (): Promise<void> | undefined => {
      disposed = true;
      credentialsRequest.abort();
      pins = {};
      enteredPIN = undefined;
      setupPIN = undefined;
      update = undefined;
      result = undefined;
      const stopped = stop?.();
      stopping = stopped ?? stopping;
      stop = undefined;
      return stopped;
    };

    const abort = (): void => {
      if (disposed || settled) return;
      // `stopping` below observes the native stop promise.
      void dispose();
      setState('hidden');
      // Cancellation also waits for an in-flight native callback and the overlay.
      // The existing finish path may already own the native stop promise.
      void Promise.allSettled([
        stopping,
        monoidScanPromptPresenter.hide(owner),
      ]).then(results => {
        for (const result of results) {
          if (result.status === 'rejected')
            errorService.catch(Promise.reject(result.reason));
        }
        settled = true;
        reject(cancelled());
        setAppletCallbackAndPromise(undefined);
      });
    };

    operationSignal?.addEventListener('abort', abort, {once: true});
    if (operationSignal?.aborted) abort();
    else void start().catch(fail);

    return () => {
      operationSignal?.removeEventListener('abort', abort);
      if (disposed) return;
      const stopped = dispose();
      void stopped?.catch(error => errorService.catch(Promise.reject(error)));

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
    allowSetup,
    ensureSetup,
    allowInstallRedirect,
    auth,
    retryOnError,
    router,
    appletCallbackAndPromise,
    showPINInput,
    toast,
  ]);

  return [
    pinInput,
    useCallback(
      async (
        initialStateContent,
        appletCallback,
        validateCard,
        signal,
        authentication,
      ) => {
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
              signal,
              authentication,
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
