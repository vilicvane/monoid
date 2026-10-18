import {X as x} from 'lucide-react';
import type {ReactNode} from 'react';
import {useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {styled} from 'styled-components';

import type {MonoidIdHex} from '../../@atomics.js';
import {MonoidPIN} from '../../@atomics.js';
import {useEntrances} from '../../@entrances.js';
import {AppletNotFoundError} from '../../@lib/applet.js';
import {CBORAppletError} from '../../@lib/cbor-applet.js';
import {IsoDepScanError} from '../../@lib/isodep.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidAppletHelloWithSafe,
  MonoidAppletInvalidPINError,
  MonoidCardError,
  MonoidWrongCardError,
} from '../../@lib/monoid/index.js';
import {renderIcon} from '../../@lib/render-icon.js';
import {
  type MonoidPINs,
  isCredentialRequestCancelled,
} from '../../@services/index.js';
import {uint8ArrayToHex} from '../../@utils/index.js';
import {useToast} from '../@ui/toast.js';
import {useInputModal} from '../@ui/use-input-modal.js';

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
  auth?: 'access' | false;
  retryOnError?: boolean;
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
  auth = false,
  retryOnError = false,
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
      ]
    >();

  const [state, setState] = useState<
    'hidden' | 'ready' | 'scanning' | 'waiting' | 'error'
  >('hidden');

  const [stateContent, setStateContent] = useState<ReactNode>();
  const [owner] = useState(() => Symbol());

  useLayoutEffect(() => {
    if (appletCallbackAndPromise && state !== 'hidden') {
      monoidScanPromptPresenter.show(owner, {
        scanning: state === 'scanning',
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
    ] = appletCallbackAndPromise;

    let retryStateContent = initialStateContent;
    let enteredPIN: {id: MonoidIdHex; pin: MonoidPIN} | undefined;
    let update:
      | {type: 'set' | 'remove'; id: MonoidIdHex; pin: MonoidPIN}
      | undefined;
    let result:
      | {type: 'success'}
      | {type: 'input'; id: MonoidIdHex; message?: string}
      | {type: 'redirect'; navigate: () => void}
      | {type: 'uninitialized'}
      | {type: 'error'; error: unknown; retry: boolean}
      | undefined;
    let finishing = false;
    let settled = false;
    let disposed = false;
    const credentialsRequest = new AbortController();
    let pins: Partial<Record<MonoidIdHex, MonoidPIN>> = {};
    let unlockedPINs: MonoidPINs | undefined;
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

    const promptPIN = (id: MonoidIdHex, errorMessage?: string): void => {
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
        placeholder: 'Enter Access PIN',
        center: true,
      }).then(value => {
        if (disposed) {
          return;
        }

        if (MonoidPIN.is(value)) {
          enteredPIN = {id, pin: value};
          setStateContent(retryStateContent);
          startScan();
        } else if (value !== undefined) {
          promptPIN(id, 'Incorrect PIN format, expected 6 to 16 characters.');
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
        monoidScanPromptPresenter.hide(owner),
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
            await monoidCredentialsStore.setPIN(
              id,
              pin,
              credentialsRequest.signal,
              unlockedPINs,
            );
          } else {
            await monoidCredentialsStore.removePIN(
              id,
              pin,
              credentialsRequest.signal,
            );
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
        promptPIN(completed.id, completed.message);
      } else if (completed.type === 'success') {
        settled = true;
        resolve();
        setAppletCallbackAndPromise(undefined);
      } else if (completed.type === 'redirect') {
        fail(new MonoidScanRedirectError());
        completed.navigate();
      } else if (completed.type === 'uninitialized') {
        fail(cancelled());
        toast({
          message: 'Initialize card from Safe',
          color: 'warning',
          position: 'top',
          waitForKeyboard: false,
        });
      } else if (completed.retry) {
        if (!(completed.error instanceof MonoidCardError)) {
          errorService.catch(Promise.reject(completed.error));
        }
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

      stop = monoidApplet.standby(
        async applet => {
          if (disposed || finishing || result) {
            return;
          }

          setStateContent('Greeting to monoid...');

          const hello = (
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

          if (ensureSetup && hello.pin === false) {
            if (!safe) {
              result = {type: 'uninitialized'};
              return;
            }

            result = {
              type: 'redirect',
              navigate: () => {
                router.safe
                  .setupCard({
                    id,
                    pin: hello.pin !== false,
                    safe: {
                      id: uint8ArrayToHex(safe.id),
                      pin: safe.pin !== false,
                      unlocked: safe.unlocked,
                    },
                  })
                  .$push();
              },
            };

            return;
          }

          if (auth === 'access') {
            const entered = enteredPIN?.id === id ? enteredPIN.pin : undefined;

            enteredPIN = undefined;

            const pin = entered ?? pins[id];

            if (disposed) {
              return;
            }

            if (pin === undefined) {
              result = {type: 'input', id};

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
                  update = {type: 'remove', id, pin};
                }

                result = {
                  type: 'input',
                  id,
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
              update = {type: 'set', id, pin: entered};
            }
          }

          if (disposed) {
            return;
          }

          await appletCallback(
            applet,
            setStateContent,
            hello,
            credentialsRequest.signal,
          );

          if (disposed) {
            return;
          }

          result = {type: 'success'};
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
              return;
            }
            result = includeSafe
              ? {
                  type: 'redirect',
                  navigate: () => router.safe.installApplet.$replace(),
                }
              : {type: 'uninitialized'};
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
              !tagLost &&
              !(error instanceof IsoDepScanError) &&
              !isCredentialRequestCancelled(error),
          };
        },
        () => {
          void finish().catch(fail);
        },
        connected => {
          if (!disposed && !finishing && !result) {
            setState(connected ? 'scanning' : 'ready');
          }
        },
        () => {
          if (
            disposed ||
            !result ||
            result.type === 'success' ||
            result.type === 'input' ||
            (result.type === 'error' &&
              (result.error instanceof IsoDepScanError ||
                isCredentialRequestCancelled(result.error)))
          ) {
            return false;
          }

          const failed =
            result.type === 'error' || result.type === 'uninitialized';

          setState(failed ? 'error' : 'waiting');

          if (result.type === 'redirect') {
            setStateContent('Remove card to continue setup');
          } else if (result.type === 'uninitialized') {
            setStateContent('Initialize card from Safe');
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
          }

          return true;
        },
      );
    };

    const start = async (): Promise<void> => {
      if (auth === 'access') {
        const saved = await monoidCredentialsStore.getPINs(
          credentialsRequest.signal,
        );

        if (disposed) {
          return;
        }

        unlockedPINs = saved;
        pins = {...saved};
      }

      startScan();
    };

    void start().catch(fail);

    return () => {
      disposed = true;
      credentialsRequest.abort();
      pins = {};
      unlockedPINs = undefined;
      enteredPIN = undefined;
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
    monoidScanPromptPresenter,
    owner,
    errorService,
    includeSafe,
    ensureSetup,
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
      (initialStateContent, appletCallback, validateCard) =>
        new Promise((resolve, reject) => {
          setState('hidden');
          setStateContent(initialStateContent);

          setAppletCallbackAndPromise([
            initialStateContent,
            appletCallback,
            {resolve, reject},
            validateCard,
          ]);
        }),
      [],
    ),
  ];
}
