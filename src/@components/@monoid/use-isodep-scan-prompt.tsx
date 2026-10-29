import {Capacitor} from '@capacitor/core';
import type {ReactNode} from 'react';
import {useCallback, useLayoutEffect, useRef} from 'react';

import {useEntrances} from '../../@entrances.js';
import {IsoDepScanError, standbyIsoDep} from '../../@lib/isodep.js';
import {MonoidCardError} from '../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../@lib/operation-cancelled.js';

type ScanCallback = (
  sessionId: string,
  setStateContent: (content: ReactNode) => void,
  signal: AbortSignal,
) => Promise<void>;

type ScanResult = {success: true} | {error: unknown};

const cancelled = (): Error =>
  Object.assign(new Error('Card scanning was cancelled.'), {code: 'CANCELLED'});

/** A raw card operation with the shared scan presentation and no automatic retry. */
export function useIsoDepScanPrompt(): (
  initialContent: ReactNode,
  callback: ScanCallback,
) => Promise<void> {
  const {monoidScanPromptPresenter: presenter, errorService} = useEntrances();
  const mounted = useRef(true);
  const active = useRef<{cancel: () => void} | undefined>(undefined);

  useLayoutEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      active.current?.cancel();
    };
  }, []);

  return useCallback(
    (initialContent, callback) => {
      if (!mounted.current) {
        return Promise.reject(cancelled());
      }

      if (active.current) {
        return Promise.reject(
          new Error('A card operation is already running.'),
        );
      }

      return new Promise<void>((resolve, reject) => {
        const owner = Symbol();
        const controller = new AbortController();
        let content = initialContent;
        let scanning = false;
        let sessionId: string | undefined;
        let failed = false;
        let finishing = false;
        let result: ScanResult | undefined;
        let callbackFinished = Promise.resolve();

        const finish = (completed: ScanResult): void => {
          if (finishing) {
            return;
          }

          finishing = true;

          void (async () => {
            // Cleanup failures take priority, but every exit still waits for both.
            const [stopped, hidden] = await Promise.allSettled([
              Promise.resolve().then(() => stop()),
              presenter.hide(owner, 'success' in completed ? '' : undefined),
              callbackFinished,
            ]);

            if (active.current === operation) {
              active.current = undefined;
            }

            if (stopped.status === 'rejected') {
              reject(stopped.reason);
            } else if (hidden.status === 'rejected') {
              reject(hidden.reason);
            } else if (!mounted.current || !hidden.value) {
              reject(cancelled());
            } else if ('error' in completed) {
              reject(completed.error);
            } else {
              resolve();
            }
          })();
        };

        const operation = {
          cancel: () => {
            if (finishing) {
              return;
            }

            const error = cancelled();
            controller.abort(error);
            finish({error});
          },
        };
        active.current = operation;

        const show = (): void => {
          if (!mounted.current || finishing) {
            return;
          }

          presenter.show(owner, {
            content,
            scanning,
            sessionId,
            error: failed,
            onDismiss: operation.cancel,
          });
        };

        show();

        const stop = standbyIsoDep(
          async sessionId => {
            if (!mounted.current || finishing || result) {
              return;
            }

            const pending = callback(
              sessionId,
              nextContent => {
                if (
                  !mounted.current ||
                  finishing ||
                  controller.signal.aborted
                ) {
                  return;
                }

                content = nextContent;
                show();
              },
              controller.signal,
            );
            callbackFinished = pending.then(
              () => {},
              () => {},
            );

            await pending;
            controller.signal.throwIfAborted();
            result = {success: true};
            content = '';
            show();
          },
          error => {
            if (finishing) {
              return;
            }

            const tagLost =
              error !== null &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'TAG_LOST';
            result = {error: tagLost ? cancelled() : error};
            controller.abort(result.error);
          },
          () => {
            if (result) {
              finish(result);
            }
          },
          (connected, nativeSessionId) => {
            sessionId =
              connected && !finishing && !result ? nativeSessionId : undefined;
            if (!result) {
              scanning = connected;
            }
            show();
          },
          () => {
            // Core NFC covers the WebView. Return the error after closing its sheet.
            if (Capacitor.getPlatform() === 'ios') {
              if (finishing || !result) return {};
              if ('success' in result) return {message: ''};

              return result.error instanceof IsoDepScanError ||
                isOperationCancelled(result.error)
                ? {}
                : {errorMessage: 'Card operation failed.'};
            }

            if (
              finishing ||
              !result ||
              !('error' in result) ||
              result.error instanceof IsoDepScanError ||
              isOperationCancelled(result.error)
            ) {
              return {};
            }

            scanning = false;
            failed = true;
            content =
              result.error instanceof Error
                ? result.error.message
                : String(result.error);
            show();
            if (result.error instanceof MonoidCardError) {
              errorService.markPresented(result.error);
            }
            return {waitForRemoval: true};
          },
        );
      });
    },
    [presenter, errorService],
  );
}
