import {type ReactNode, useEffect, useRef} from 'react';

import {type MonoidIdHex, MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import {
  type MonoidAppletHello,
  MonoidCardError,
  MonoidWrongCardError,
  initializeMonoidCard,
} from '../../../../@lib/monoid/index.js';
import {isCredentialRequestCancelled} from '../../../../@services/index.js';
import {uint8ArrayToHex} from '../../../../@utils/index.js';
import {
  MonoidScanStatePromptContentHighlight,
  useMonoidScanPrompt,
} from '../../../@monoid/monoid-scan-prompt.js';
import {
  PINKind,
  getPINInputPlaceholder,
} from '../../../@monoid/pin-input-placeholder.js';
import {useToast} from '../../../@ui/toast.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';

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
    hello.pins.safe !== false &&
    hello.pins.safe !== 0
  );
}

export function CardSetupPIN({
  hello,
  onFinished,
}: {
  hello: MonoidAppletHello;
  onFinished: (initialized: boolean, latestHello?: MonoidAppletHello) => void;
}): ReactNode {
  const {errorService, monoidCredentialsStore} = useEntrances();
  const toast = useToast();
  const [input, showInput] = useInputModal();
  const [scanInput, scan] = useMonoidScanPrompt({
    ensureSetup: false,
    auth: false,
    retryOnError: false,
  });
  const finish = useRef(onFinished);
  finish.current = onFinished;

  useEffect(() => {
    const operation = new AbortController();
    const {signal} = operation;
    let disposed = false;
    let pin: MonoidPIN | undefined;
    let writing: Promise<void> | undefined;
    let initialized = false;
    let latestHello: MonoidAppletHello | undefined;
    let accessPINId: MonoidIdHex | undefined;
    let accessPINAuthenticated = false;
    let scanCompleted = false;

    const readPIN = async (): Promise<MonoidPIN | undefined> => {
      let description: ReactNode =
        hello.pins.access === false ? (
          <>
            Will be used as initial <PINKind kind="Access" /> PIN
          </>
        ) : (
          <>
            <PINKind kind="Access" /> PIN stays the same
          </>
        );

      for (;;) {
        signal.throwIfAborted();
        const value = await waitForOperation(
          showInput({
            type: 'password',
            ...getPINInputPlaceholder(
              'Safe',
              hello.pins.safe === false ? 'Set' : 'Enter existing',
            ),
            description,
            center: true,
            maxLength: 16,
          }),
          signal,
        );
        if (value === undefined || MonoidPIN.is(value)) return value;
        description = 'Use 6 to 16 ASCII characters';
      }
    };

    const run = async (): Promise<void> => {
      try {
        if (isInitialized(hello)) {
          latestHello = hello;
          initialized = true;
          return;
        }
        if (hello.pins.safe === 0)
          throw new MonoidCardError('Safe PIN blocked');
        if (hello.pins.access === 0)
          throw new MonoidCardError('Access PIN blocked');

        pin = await readPIN();
        if (pin === undefined) return;
        signal.throwIfAborted();

        try {
          await waitForOperation(
            scan(
              <>
                Scan card{' '}
                <MonoidScanStatePromptContentHighlight>
                  {uint8ArrayToHex(hello.id)}
                </MonoidScanStatePromptContentHighlight>
              </>,
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
                      hello.pins.safe === false &&
                      current.pins.safe !== false
                    ) {
                      throw new MonoidCardError(
                        'Safe PIN already set, enter existing PIN',
                      );
                    }

                    setState(
                      current.pins.safe === false
                        ? 'Setting Safe PIN, hold tight...'
                        : 'Setting Access PIN, hold tight...',
                    );
                    const result = await initializeMonoidCard(
                      applet,
                      current,
                      pin!,
                      signal,
                    );
                    latestHello = result;
                    initialized = true;
                    signal.throwIfAborted();

                    if (current.pins.access === false) {
                      accessPINId = uint8ArrayToHex(result.id);
                      setState('Authenticating, hold tight...');
                      await applet.authenticate({pin: pin!});
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
                if (
                  uint8ArrayToHex(current.id) !== uint8ArrayToHex(hello.id) ||
                  uint8ArrayToHex(current.publicKey) !==
                    uint8ArrayToHex(hello.publicKey)
                ) {
                  throw new MonoidWrongCardError(uint8ArrayToHex(hello.id));
                }
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
                await monoidCredentialsStore.setPIN(accessPINId, pin, signal);
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
        if (
          !disposed &&
          !signal.aborted &&
          !isCredentialRequestCancelled(error)
        ) {
          errorService.catch(Promise.reject(error));
        }
      } finally {
        pin = undefined;
        if (!disposed) finish.current(initialized, latestHello);
      }
    };

    void run();
    return () => {
      disposed = true;
      operation.abort();
    };
  }, [hello, showInput, scan, toast, errorService, monoidCredentialsStore]);

  return (
    <>
      {input}
      {scanInput}
    </>
  );
}
