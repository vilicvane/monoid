import {type ReactNode, useEffect, useRef} from 'react';

import type {MonoidIdHex, MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import {
  type MonoidAppletHello,
  MonoidCardError,
  assertCardPINsNotBlocked,
  assertSameCardWithBundle,
  initializeMonoidCard,
  readBackupCardIdentity,
} from '../../../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../../../@lib/operation-cancelled.js';
import {type MonoidPINSession} from '../../../../@services/index.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {
  scanCardPrompt,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {requestCardPINs} from '../../../@monoid/request-card-pins.js';
import {useToast} from '../../../@ui/toast.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';

import type {CardSecretPINSession} from './card-secret-pin-session.js';

function waitForOperation<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => reject(signal.reason);
    signal.addEventListener('abort', cancel, {once: true});
    if (signal.aborted) cancel();
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}

function isInitialized(hello: MonoidAppletHello): boolean {
  return (
    hello.pins.access !== false &&
    hello.pins.access !== 0 &&
    hello.pins.secret !== false &&
    hello.pins.secret !== 0
  );
}

export function CardSetupPIN({
  hello,
  pinSession,
  secretPINSession,
  onInitialized,
  onFinished,
}: {
  hello: MonoidAppletHello;
  pinSession?: MonoidPINSession;
  secretPINSession?: CardSecretPINSession;
  onInitialized?: (hello: MonoidAppletHello) => void;
  onFinished: (initialized: boolean, latestHello?: MonoidAppletHello) => void;
}): ReactNode {
  const {errorService, monoidCredentialsStore} = useEntrances();
  const toast = useToast();
  const [input, showInput] = useInputModal();
  const [scanInput, scan] = useMonoidScanPrompt({
    ensureSetup: false,
    auth: false,
    retryOnError: false,
    pinSession,
  });
  const finish = useRef(onFinished);
  finish.current = onFinished;
  const acknowledge = useRef(onInitialized);
  acknowledge.current = onInitialized;

  useEffect(() => {
    const operation = new AbortController();
    const signal = secretPINSession
      ? AbortSignal.any([operation.signal, secretPINSession.signal])
      : operation.signal;
    let disposed = false;
    let pin: MonoidPIN | undefined;
    let accessPIN: MonoidPIN | undefined;
    let writing: Promise<void> | undefined;
    let initialized = false;
    let latestHello: MonoidAppletHello | undefined;
    let accessPINId: MonoidIdHex | undefined;
    let accessPINAuthenticated = false;
    let scanCompleted = false;

    const run = async (): Promise<void> => {
      try {
        if (isInitialized(hello)) {
          latestHello = hello;
          initialized = true;
          return;
        }
        assertCardPINsNotBlocked(hello);

        await using temporarySession = pinSession
          ? undefined
          : monoidCredentialsStore.createPINSession();
        const setupPINSession = pinSession ?? temporarySession!;
        let savedAccessPIN: MonoidPIN | undefined;
        if (hello.pins.access === false) {
          try {
            savedAccessPIN = (
              await waitForOperation(setupPINSession.getPINs(signal), signal)
            )[uint8ArrayToHex(hello.id)];
          } catch (error) {
            setupPINSession.clear();
            throw error;
          }
          signal.throwIfAborted();
        }

        const requested = await requestCardPINs(
          showInput,
          {
            secretSet: hello.pins.secret !== false,
            accessSet: hello.pins.access !== false,
            savedAccessPIN,
          },
          signal,
        );
        if (!requested) return;
        pin = requested.secret;
        accessPIN = requested.access;
        signal.throwIfAborted();

        try {
          await waitForOperation(
            scan(
              scanCardPrompt(hello),
              async (applet, setState, current, scanSignal) => {
                const cancel = (): void => operation.abort(scanSignal.reason);
                scanSignal.addEventListener('abort', cancel, {once: true});
                if (scanSignal.aborted) cancel();

                try {
                  signal.throwIfAborted();
                  writing = (async () => {
                    if (isInitialized(current)) {
                      latestHello = current;
                      initialized = true;
                      return;
                    }

                    if (
                      hello.pins.secret === false &&
                      current.pins.secret !== false
                    ) {
                      throw new MonoidCardError(
                        'Secret PIN already set, enter existing PIN',
                      );
                    }

                    const rememberPIN = secretPINSession?.onAuthenticated(
                      readBackupCardIdentity(current),
                      pin!,
                    );

                    setState(
                      current.pins.secret === false
                        ? 'Setting Secret PIN, hold tight...'
                        : 'Setting Access PIN, hold tight...',
                    );
                    const result = await initializeMonoidCard(
                      applet,
                      current,
                      pin!,
                      signal,
                      accessPIN,
                    );
                    latestHello = result;
                    initialized = true;
                    rememberPIN?.();
                    signal.throwIfAborted();

                    if (current.pins.access === false) {
                      accessPINId = uint8ArrayToHex(result.id);
                      setState('Authenticating, hold tight...');
                      await applet.authenticate({pin: accessPIN!});
                      signal.throwIfAborted();
                      accessPINAuthenticated = true;
                    }
                  })();
                  await writing;
                } finally {
                  scanSignal.removeEventListener('abort', cancel);
                }
              },
              current => {
                signal.throwIfAborted();
                assertSameCardWithBundle(
                  current,
                  readBackupCardIdentity(hello),
                );
                latestHello = current;
              },
            ),
            signal,
          );
          scanCompleted = true;
        } finally {
          // Dismissing the scan can finish before the final card response.
          await writing?.catch(() => {});
          if (accessPINId) {
            let saved = false;
            if (scanCompleted && accessPINAuthenticated && !signal.aborted) {
              try {
                await setupPINSession.setPIN(accessPINId, accessPIN!, signal);
                saved = true;
              } catch {
                // The card setup remains valid if local credential storage fails.
              }
            }
            if (!saved && !disposed) {
              toast({
                message: 'Access PIN was not saved on this device',
                color: 'warning',
              });
            }
          }
        }
      } catch (error) {
        if (!disposed && !isOperationCancelled(error, signal)) {
          errorService.catch(Promise.reject(error));
        }
      } finally {
        pin = undefined;
        accessPIN = undefined;
        // Keep confirmed setup in its owning flow even if navigation closed the UI.
        if (initialized && latestHello) acknowledge.current?.(latestHello);
        if (!disposed) finish.current(initialized, latestHello);
      }
    };

    void run();
    return () => {
      disposed = true;
      operation.abort();
    };
  }, [
    hello,
    pinSession,
    secretPINSession,
    showInput,
    scan,
    toast,
    errorService,
    monoidCredentialsStore,
  ]);

  return (
    <>
      {input}
      {scanInput}
    </>
  );
}
