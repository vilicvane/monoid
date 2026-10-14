import x from 'lucide-static/icons/x.svg';
import type {ReactNode} from 'react';
import {useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {styled} from 'styled-components';

import type {MonoidIdHex} from '../../@atomics.js';
import {MonoidPIN} from '../../@atomics.js';
import {useEntrances} from '../../@entrances.js';
import {CBORAppletError} from '../../@lib/cbor-applet.js';
import type {MonoidApplet} from '../../@lib/monoid/index.js';
import {MonoidAppletInvalidPINError} from '../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../@utils/index.js';
import {useToast} from '../@ui/toast.js';
import {useInputModal} from '../@ui/use-input-modal.js';

export const MonoidScanStatePromptContentHighlight = styled.span`
  color: white;
`;

export type MonoidScanPromptSetStateContentCallback = (
  content: ReactNode,
) => void;

export type MonoidScanPromptOptions = {
  ensureSetup?: boolean;
  auth?: 'access' | false;
  retryOnError?: boolean;
};

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
      monoidScanPromptPresenter.hide(owner);
    }
  }, [
    monoidScanPromptPresenter,
    owner,
    appletCallbackAndPromise,
    state,
    stateContent,
  ]);

  useLayoutEffect(
    () => () => monoidScanPromptPresenter.hide(owner),
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
    let inputPending = false;
    let completed = false;
    let failed = false;
    let disposed = false;

    const promptPIN = (id: MonoidIdHex, errorMessage?: string): void => {
      inputPending = true;

      setState('hidden');

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
          inputPending = false;
          setStateContent(retryStateContent);
          setState('ready');
        } else if (value !== undefined) {
          promptPIN(id, 'Incorrect PIN format, expected 6 to 16 characters.');
        } else {
          setAppletCallbackAndPromise(undefined);
        }
      });
    };

    const stop = monoidApplet.standby(
      async applet => {
        if (disposed || inputPending || completed) {
          return;
        }

        setState('scanning');

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
          completed = true;

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

          return;
        }

        if (auth === 'access') {
          const entered = enteredPIN?.id === id ? enteredPIN.pin : undefined;

          enteredPIN = undefined;

          const pin = entered ?? (await monoidCredentialsStore.getPIN(id));

          if (disposed) {
            return;
          }

          if (pin === undefined) {
            promptPIN(id);

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
                await monoidCredentialsStore.removePIN(id);
              }

              if (!disposed) {
                promptPIN(
                  id,
                  `Incorrect PIN, tries remaining: ${error.source.tries}`,
                );
              }

              return;
            }

            throw error;
          }

          if (entered !== undefined && !disposed) {
            await monoidCredentialsStore.setPIN(id, entered);
          }
        }

        if (disposed) {
          return;
        }

        await appletCallback(applet, setStateContent, hello);

        if (disposed) {
          return;
        }

        completed = true;
        setState('hidden');

        resolve();
      },
      error => {
        if (disposed) {
          return;
        }

        failed = retryOnError;
        completed = !retryOnError;
        setState('hidden');

        if (retryOnError) {
          errorService.catch(Promise.reject(error));
        } else {
          reject(error);
        }
      },
      () => {
        if (disposed) {
          return;
        }

        if (completed) {
          setAppletCallbackAndPromise(undefined);
        } else if (failed && !inputPending) {
          failed = false;
          setStateContent(retryStateContent);
          setState('ready');
        }
      },
    );

    return () => {
      disposed = true;
      stop();
    };
  }, [
    monoidApplet,
    monoidCredentialsStore,
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
          setState('ready');
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
