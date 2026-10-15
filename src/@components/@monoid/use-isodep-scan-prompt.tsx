import type {ReactNode} from 'react';
import {useCallback, useLayoutEffect, useRef} from 'react';

import {useEntrances} from '../../@entrances.js';
import {standbyIsoDep} from '../../@lib/isodep.js';

type ScanCallback = (
  sessionId: string,
  setStateContent: (content: ReactNode) => void,
) => Promise<void>;

type ScanResult = {success: true} | {error: unknown};

const cancelled = (): Error =>
  Object.assign(new Error('Card scanning was cancelled.'), {code: 'CANCELLED'});

/** A raw card operation with the shared scan presentation and no automatic retry. */
export function useIsoDepScanPrompt(): (
  initialContent: ReactNode,
  callback: ScanCallback,
) => Promise<void> {
  const {monoidScanPromptPresenter: presenter} = useEntrances();
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
        let content = initialContent;
        let scanning = false;
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
              presenter.hide(owner),
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

        const operation = {cancel: () => finish({error: cancelled()})};
        active.current = operation;

        const show = (): void => {
          if (!mounted.current || finishing) {
            return;
          }

          presenter.show(owner, {
            content,
            scanning,
            onDismiss: operation.cancel,
          });
        };

        show();

        const stop = standbyIsoDep(
          async sessionId => {
            if (!mounted.current || finishing || result) {
              return;
            }

            const pending = callback(sessionId, nextContent => {
              if (!mounted.current || finishing) {
                return;
              }

              content = nextContent;
              show();
            });
            callbackFinished = pending.then(
              () => {},
              () => {},
            );

            await pending;
            result = {success: true};
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
          },
          () => {
            if (result) {
              finish(result);
            }
          },
          connected => {
            scanning = connected;
            show();
          },
        );
      });
    },
    [presenter],
  );
}
