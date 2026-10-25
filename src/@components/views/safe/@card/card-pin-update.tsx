import {reaction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {type MonoidIdHex, MonoidPIN} from '../../../../@atomics.js';
import {useEntrances} from '../../../../@entrances.js';
import {assertSameCard} from '../../../../@lib/monoid/index.js';
import {isOperationCancelled} from '../../../../@lib/operation-cancelled.js';
import type {Router} from '../../../../@routes.js';
import {type MonoidPINSession} from '../../../../@services/index.js';
import {useMonoidScanPrompt} from '../../../@monoid/monoid-scan-prompt.js';
import {getPINInputPlaceholder} from '../../../@monoid/pin-input-placeholder.js';
import {useToast} from '../../../@ui/toast.js';
import {useInputModal} from '../../../@ui/use-input-modal.js';
import {useViewActive} from '../../../@view/index.js';
import {type CardPINKind, updateCardPIN} from '../card-pin-update.js';
import type {ScannedCardData} from '../common.js';

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

export const CardPINUpdate = observer(
  ({
    card,
    kind,
    pinSession,
    view,
    onFinished,
  }: {
    card: ScannedCardData;
    kind: CardPINKind;
    pinSession: MonoidPINSession;
    view: RouteComponentProps<Router['safe']['card']>['view'];
    onFinished: () => void;
  }): ReactNode => {
    const {errorService} = useEntrances();
    const isViewActive = useViewActive(view);
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
      let currentPIN: MonoidPIN | undefined;
      let newPIN: MonoidPIN | undefined;
      let confirmation: string | undefined;
      let writing: Promise<void> | undefined;
      let updatedCardId: MonoidIdHex | undefined;
      const active = (): boolean => !disposed && isViewActive();
      const stopWatching = reaction(
        () => !isViewActive(),
        leaving => {
          if (leaving) operation.abort();
        },
        {fireImmediately: true},
      );

      const prompt = async (
        pinKind: CardPINKind,
        prefix: string,
        description?: string,
      ): Promise<string | undefined> => {
        if (signal.aborted) return;
        return new Promise(resolve => {
          const cancel = (): void => resolve(undefined);
          signal.addEventListener('abort', cancel, {once: true});
          void showInput({
            type: 'password',
            ...getPINInputPlaceholder(pinKind, prefix),
            description,
            center: true,
            maxLength: 16,
          }).then(value => {
            signal.removeEventListener('abort', cancel);
            resolve(signal.aborted ? undefined : value);
          });
        });
      };

      const readPIN = async (
        pinKind: CardPINKind,
        prefix: string,
      ): Promise<MonoidPIN | undefined> => {
        let description: string | undefined;
        for (;;) {
          const value = await prompt(pinKind, prefix, description);
          if (value === undefined || MonoidPIN.is(value)) return value;
          description = 'Use 6 to 16 ASCII characters';
        }
      };

      const run = async (): Promise<void> => {
        try {
          if (kind === 'Access') {
            try {
              await waitForOperation(pinSession.getPINs(signal), signal);
            } catch (error) {
              pinSession.clear();
              throw error;
            }
            signal.throwIfAborted();
          }
          currentPIN = await readPIN('Secret', 'Enter current');
          if (currentPIN === undefined) return;
          newPIN = await readPIN(kind, 'Enter new');
          if (newPIN === undefined) return;
          let description: string | undefined;
          do {
            confirmation = await prompt(kind, 'Confirm new', description);
            if (confirmation === undefined) return;
            description = 'PINs do not match';
          } while (confirmation !== newPIN);
          confirmation = undefined;
          if (signal.aborted) return;

          try {
            await waitForOperation(
              scan(
                `Scan card to update ${kind} PIN`,
                async (applet, setState, hello, scanSignal) => {
                  const cancel = (): void => operation.abort();
                  scanSignal.addEventListener('abort', cancel, {once: true});
                  if (scanSignal.aborted) cancel();
                  try {
                    setState(`Updating ${kind} PIN, hold tight...`);
                    writing = (async () => {
                      updatedCardId = await updateCardPIN(
                        applet,
                        hello,
                        card,
                        kind,
                        currentPIN!,
                        newPIN!,
                        signal,
                      );
                      if (kind === 'Access' && active()) {
                        pinSession.rememberPIN(updatedCardId, newPIN!);
                      }
                    })();
                    await writing;
                  } finally {
                    scanSignal.removeEventListener('abort', cancel);
                  }
                },
                hello => assertSameCard(hello, card),
              ),
              signal,
            );
          } finally {
            // The scan can close before the last APDU returns.
            await writing?.catch(() => {});
            if (updatedCardId) {
              let saved = true;
              if (kind === 'Access') {
                try {
                  signal.throwIfAborted();
                  await pinSession.setPIN(updatedCardId, newPIN, signal);
                } catch {
                  saved = false;
                  if (active())
                    toast({
                      message:
                        'Access PIN updated, but not saved on this device',
                      color: 'warning',
                    });
                }
              }
              if (active() && saved) toast({message: `${kind} PIN updated`});
            }
          }
        } catch (error) {
          if (active() && !isOperationCancelled(error, signal))
            errorService.catch(Promise.reject(error));
        } finally {
          currentPIN = undefined;
          newPIN = undefined;
          confirmation = undefined;
          stopWatching();
          if (!disposed) finish.current();
        }
      };
      void run();
      return () => {
        disposed = true;
        operation.abort();
        stopWatching();
      };
    }, [
      card,
      kind,
      pinSession,
      isViewActive,
      showInput,
      scan,
      toast,
      errorService,
    ]);

    return isViewActive() ? (
      <>
        {input}
        {scanInput}
      </>
    ) : null;
  },
);
