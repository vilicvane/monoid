import {App} from '@capacitor/app';
import {reaction} from 'mobx';
import {useEffect, useRef, useState} from 'react';

import {isOperationCancelled} from '../../@lib/operation-cancelled.js';
import type {MonoidPINSession} from '../../@services/index.js';

import {
  type MonoidScanPrompt,
  type MonoidScanPromptCallback,
  MonoidScanRedirectError,
} from './monoid-scan-prompt.js';

type CardOperation = {
  signal: AbortSignal;
  active: () => boolean;
  getPINs: () => ReturnType<MonoidPINSession['getPINs']>;
  scan: MonoidScanPrompt;
};

/** Own one operation through PIN unlock, scans and the page's final cleanup. */
export function useCardOperation({
  active,
  pinSession,
  scan,
  onLeave,
  onBackground,
}: {
  active: () => boolean;
  pinSession: MonoidPINSession;
  scan: MonoidScanPrompt;
  onLeave?: () => void;
  /** Opt into the page's background/visibility handling, preserving PIN unlock. */
  onBackground?: () => void;
}): {
  busy: boolean;
  running: () => boolean;
  abort: () => void;
  run: (callback: (operation: CardOperation) => Promise<void>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const operation = useRef<
    {controller: AbortController; scanning: boolean} | undefined
  >(undefined);
  const mounted = useRef(true);
  const handlers = useRef({onLeave, onBackground});
  handlers.current = {onLeave, onBackground};
  const watchBackground = !!onBackground;

  useEffect(() => {
    mounted.current = true;
    const dispose = reaction(active, value => {
      if (value) return;
      operation.current?.controller.abort();
      pinSession.clear();
      handlers.current.onLeave?.();
    });
    const background = (): void => {
      // Biometric unlock can deactivate the app before NFC starts.
      if (operation.current?.scanning) operation.current.controller.abort();
      handlers.current.onBackground?.();
    };
    const visibility = (): void => {
      if (document.hidden) background();
    };
    const listener = watchBackground
      ? App.addListener('appStateChange', ({isActive}) => {
          if (!isActive) background();
        })
      : undefined;
    if (watchBackground)
      document.addEventListener('visibilitychange', visibility);

    return () => {
      mounted.current = false;
      operation.current?.controller.abort();
      pinSession.clear();
      dispose();
      if (watchBackground)
        document.removeEventListener('visibilitychange', visibility);
      void listener?.then(handle => handle.remove());
    };
  }, [active, pinSession, watchBackground]);

  async function run(
    callback: (operation: CardOperation) => Promise<void>,
  ): Promise<void> {
    if (operation.current || !mounted.current || !active()) return;
    const task = {controller: new AbortController(), scanning: false};
    operation.current = task;
    setBusy(true);
    const {signal} = task.controller;
    const isActive = (): boolean =>
      !signal.aborted && mounted.current && active();
    const checkActive = (): void => {
      signal.throwIfAborted();
      if (!isActive()) throw new MonoidScanRedirectError();
    };
    let pins: ReturnType<MonoidPINSession['getPINs']> | undefined;
    const getPINs = async (): ReturnType<MonoidPINSession['getPINs']> => {
      checkActive();
      try {
        pins ??= pinSession.getPINs(signal);
        const result = await pins;
        checkActive();
        return result;
      } catch (error) {
        pinSession.clear();
        throw error;
      }
    };
    const runScan: MonoidScanPrompt = async (
      content,
      process,
      validate,
      scanSignal,
      authentication,
    ) => {
      // Lazy preload lets pages start independent work (OTP Authority warm-up)
      // before unlock, or read these same PINs before a manual input prompt.
      await getPINs();
      const combined = scanSignal
        ? AbortSignal.any([signal, scanSignal])
        : signal;
      combined.throwIfAborted();
      task.scanning = true;
      const guard =
        (callback: MonoidScanPromptCallback): MonoidScanPromptCallback =>
        (applet, setState, hello, scanSignal) => {
          checkActive();
          const callbackSignal = AbortSignal.any([combined, scanSignal]);
          callbackSignal.throwIfAborted();
          return callback(applet, setState, hello, callbackSignal);
        };

      await scan(
        content,
        guard(process),
        hello => {
          checkActive();
          combined.throwIfAborted();
          validate?.(hello);
        },
        combined,
        authentication && {
          ...authentication,
          prepare: guard(authentication.prepare),
        },
      );
      checkActive();
    };

    try {
      await callback({signal, active: isActive, getPINs, scan: runScan});
    } catch (error) {
      if (!isOperationCancelled(error, signal)) throw error;
    } finally {
      operation.current = undefined;
      if (mounted.current) setBusy(false);
    }
  }

  return {
    busy,
    running: () => !!operation.current,
    abort: () => operation.current?.controller.abort(),
    run,
  };
}
