import type {ReactNode} from 'react';
import {useEffect, useRef} from 'react';

import type {MonoidIdHex} from '../../@atomics.js';
import {MonoidPIN} from '../../@atomics.js';
import {useEntrances} from '../../@entrances.js';
import {CBORAppletError} from '../../@lib/cbor-applet.js';
import type {createMonoidApplet} from '../../@lib/monoid/index.js';
import {MonoidAppletInvalidPINError} from '../../@lib/monoid/index.js';
import {uint8ArrayToHex} from '../../@utils/index.js';
import {useInputModal} from '../@ui/use-input-modal.js';

export type MonoidAppletOptions = {
  auth: 'access' | 'safe' | false;
};

export function useMonoidApplet(
  {auth}: MonoidAppletOptions,
  callback: (
    applet: ReturnType<typeof createMonoidApplet>,
    hello: Awaited<ReturnType<typeof applet.hello>>,
  ) => Promise<void>,
  onError: (error: unknown) => void,
): ReactNode {
  const {router, monoidApplet, monoidCredentialsStore} = useEntrances();

  const [pinInput, showPINInput] = useInputModal();

  const enteredPINRef = useRef<{id: MonoidIdHex; pin: MonoidPIN}>(undefined);

  useEffect(
    () =>
      monoidApplet.standby(
        async applet => {
          const hello = await applet.hello({});

          const id = uint8ArrayToHex(hello.id);

          if (hello.pin === false) {
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

          if (auth === 'safe') {
            // TODO: prompt for safe PIN and authenticate
            throw new Error('Safe PIN not implemented');
          } else if (auth === 'access') {
            const promptPIN = (placeholder: string): void => {
              void showPINInput({
                type: 'password',
                placeholder,
                center: true,
              }).then(value => {
                if (MonoidPIN.is(value)) {
                  enteredPINRef.current = {id, pin: value};
                } else if (value !== undefined) {
                  promptPIN('PIN must be 6 to 16 characters');
                }
              });
            };

            const enteredPIN =
              enteredPINRef.current?.id === id
                ? enteredPINRef.current.pin
                : undefined;

            enteredPINRef.current = undefined;

            const pin = enteredPIN ?? (await monoidCredentialsStore.getPIN(id));

            if (pin === undefined) {
              promptPIN('Enter Access PIN');

              return;
            }

            try {
              await applet.authenticate({pin});
            } catch (error) {
              if (
                error instanceof CBORAppletError &&
                MonoidAppletInvalidPINError.is(error.source) &&
                error.source.tries > 0
              ) {
                if (enteredPIN === undefined) {
                  await monoidCredentialsStore.removePIN(id);
                }

                promptPIN(
                  `Incorrect PIN, tries remaining: ${error.source.tries}`,
                );

                return;
              }

              throw error;
            }

            if (enteredPIN !== undefined) {
              await monoidCredentialsStore.setPIN(id, enteredPIN);
            }
          }

          await callback(applet, hello);
        },
        error => {
          onError(error);
        },
      ),
    [
      auth,
      callback,
      monoidApplet,
      monoidCredentialsStore,
      onError,
      router.safe,
      showPINInput,
    ],
  );

  return pinInput;
}
