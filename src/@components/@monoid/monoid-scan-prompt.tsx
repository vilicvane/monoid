import x from 'lucide-static/icons/x.svg';
import type {ReactNode} from 'react';
import {useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {styled} from 'styled-components';

import type {MonoidIdHex} from '../../@atomics.js';
import {MonoidPIN} from '../../@atomics.js';
import {useEntrances} from '../../@entrances.js';
import {AppletNotFoundError} from '../../@lib/applet.js';
import {CBORAppletError} from '../../@lib/cbor-applet.js';
import {IsoDepScanError} from '../../@lib/isodep.js';
import type {MonoidApplet} from '../../@lib/monoid/index.js';
import {MonoidAppletInvalidPINError} from '../../@lib/monoid/index.js';
import {isCredentialRequestCancelled} from '../../@services/index.js';
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
}: {
  children: string;
  current: number;
  total: number;
}): ReactNode {
  return (
    <>
      {children}, hold tight...
      {total > 1 && (
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
  ensureSetup?: boolean;
  auth?: 'access' | false;
  retryOnError?: boolean;
};

/** The scan ended quietly because another page will handle the card. */
export class MonoidScanRedirectError extends Error {
  readonly code = 'CANCELLED';

  constructor() {
    super('Card scanning was redirected.');
    this.name = new.target.name;
  }
}

export function useMonoidScanPrompt({
  ensureSetup = true,
  auth = false,
  retryOnError = false,
}: MonoidScanPromptOptions = {}): [
  ReactNode,
  (
    initialStateContent: ReactNode,
    appletCallback: (
      applet: MonoidApplet,
      setStateContent: MonoidScanPromptSetStateContentCallback,
      hello: Awaited<ReturnType<MonoidApplet['hello']>>,
    ) => Promise<void>,
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
        (
          applet: MonoidApplet,
          setStateContent: MonoidScanPromptSetStateContentCallback,
          hello: Awaited<ReturnType<MonoidApplet['hello']>>,
        ) => Promise<void>,
        {resolve: () => void; reject: (error: unknown) => void},
      ]
    >();

  const [state, setState] = useState<'hidden' | 'ready' | 'scanning'>('hidden');

  const [stateContent, setStateContent] = useState<ReactNode>();
  const [owner] = useState(() => Symbol());

  useLayoutEffect(() => {
    if (appletCallbackAndPromise && state !== 'hidden') {
      monoidScanPromptPresenter.show(owner, {
        scanning: state === 'scanning',
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

    const [initialStateContent, appletCallback, {resolve, reject}] =
      appletCallbackAndPromise;

    let retryStateContent = initialStateContent;
    let enteredPIN: {id: MonoidIdHex; pin: MonoidPIN} | undefined;
    let update:
      | {type: 'set' | 'remove'; id: MonoidIdHex; pin: MonoidPIN}
      | undefined;
    let result:
      | {type: 'success'}
      | {type: 'input'; id: MonoidIdHex; message?: string}
      | {type: 'redirect'; navigate: () => void}
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

    const promptPIN = (id: MonoidIdHex, errorMessage?: string): void => {
      if (disposed) {
        return;
      }

      if (errorMessage) {
        toast({
          message: errorMessage,
          color: 'danger',
          icon: x,
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

      stop = monoidApplet.standby(
        async applet => {
          if (disposed || finishing || result) {
            return;
          }

          setStateContent('Greeting to monoid...');

          const hello = await applet.hello({});

          if (disposed) {
            return;
          }

          const id = uint8ArrayToHex(hello.id);

          retryStateContent = (
            <>
              Scan card{' '}
              <MonoidScanStatePromptContentHighlight>
                {uint8ArrayToHex(hello.safe.id)}
              </MonoidScanStatePromptContentHighlight>{' '}
              again
            </>
          );

          if (ensureSetup && hello.pin === false) {
            result = {
              type: 'redirect',
              navigate: () => {
                router.safe
                  .setupCard({
                    id,
                    pin: hello.pin !== false,
                    safe: {
                      id: uint8ArrayToHex(hello.safe.id),
                      pin: hello.safe.pin !== false,
                      unlocked: hello.safe.unlocked,
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
                MonoidAppletInvalidPINError.is(error.source) &&
                error.source.tries > 0
              ) {
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

          await appletCallback(applet, setStateContent, hello);

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
            result = {
              type: 'redirect',
              navigate: () => router.safe.installApplet.$replace(),
            };
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
          if (!disposed && !finishing) {
            setState(connected ? 'scanning' : 'ready');
          }
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
      (initialStateContent, appletCallback) =>
        new Promise((resolve, reject) => {
          setState('hidden');
          setStateContent(initialStateContent);

          setAppletCallbackAndPromise([
            initialStateContent,
            appletCallback,
            {resolve, reject},
          ]);
        }),
      [],
    ),
  ];
}
