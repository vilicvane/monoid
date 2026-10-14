import {App} from '@capacitor/app';
import type {PluginListenerHandle} from '@capacitor/core';
import type {IsoDepNfcError, ScanEndedEvent} from 'capacitor-isodep-nfc';
import {IsoDepNfc} from 'capacitor-isodep-nfc';

let previousScan: Promise<void> = Promise.resolve();

/** The whole scan has stopped, rather than just one card connection. */
export class IsoDepScanError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), {cause});
    this.name = new.target.name;
  }
}

export function standbyIsoDep(
  callback: (sessionId: string) => Promise<void>,
  onError: (error: unknown) => void,
  onCleanup?: () => void,
): () => void {
  let disposed = false;
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => {
    stop = resolve;
  });

  const run = async (): Promise<void> => {
    const listeners: PluginListenerHandle[] = [];
    const sessions = new Set<Promise<void>>();
    let lastSessionId: string | undefined;
    let scanId: string | undefined;
    let scanEnded: ScanEndedEvent | undefined;
    let scanFailure: unknown;
    let finishScan: (event: ScanEndedEvent) => void;
    let notifyStateChange!: () => void;
    let stateChanged: Promise<void>;

    const watchStateChange = (): void => {
      stateChanged = new Promise(resolve => {
        notifyStateChange = () => {
          watchStateChange();
          resolve();
        };
      });
    };

    watchStateChange();

    const handleSession = async (
      sessionId: string,
      operation: () => Promise<void>,
    ): Promise<void> => {
      let failure: unknown;

      try {
        await operation();
      } catch (error) {
        failure = error;
      }

      try {
        await IsoDepNfc.closeSession({sessionId});
      } catch (error) {
        scanFailure = error;
      }

      if (
        !disposed &&
        scanFailure === undefined &&
        scanEnded?.reason !== 'io-error'
      ) {
        if (failure !== undefined) {
          onError(failure);
        }

        onCleanup?.();
      }
    };

    const startSession = (
      sessionId: string,
      operation: () => Promise<void>,
    ): void => {
      lastSessionId = sessionId;

      const session = handleSession(sessionId, operation).finally(() => {
        sessions.delete(session);
      });

      sessions.add(session);
    };

    try {
      if (disposed) {
        return;
      }

      listeners.push(
        await App.addListener('appStateChange', () => notifyStateChange()),
      );
      listeners.push(
        await IsoDepNfc.addListener('statusChanged', () => notifyStateChange()),
      );
      listeners.push(
        await IsoDepNfc.addListener('sessionOpened', event => {
          if (disposed || event.scanId !== scanId) {
            return;
          }

          startSession(event.sessionId, () => callback(event.sessionId));
        }),
      );
      listeners.push(
        await IsoDepNfc.addListener('sessionEnded', event => {
          if (
            disposed ||
            event.scanId !== scanId ||
            event.sessionId === lastSessionId ||
            event.code === undefined
          ) {
            return;
          }

          startSession(event.sessionId, () =>
            Promise.reject(
              new Error(`The NFC connection ended: ${event.reason}.`),
            ),
          );
        }),
      );
      listeners.push(
        await IsoDepNfc.addListener('scanEnded', event => {
          if (event.scanId === scanId) {
            scanEnded = event;
            finishScan(event);
          }
        }),
      );

      while (!disposed) {
        const changed = stateChanged!;
        const {isActive} = await App.getState();
        const {supported, enabled} = await IsoDepNfc.getStatus();

        if (!supported) {
          throw new Error('NFC is not available on this device.');
        }

        if (!isActive || !enabled) {
          await Promise.race([changed, stopped]);
          continue;
        }

        if (disposed) {
          break;
        }

        scanId = crypto.getRandomValues(new Uint32Array(4)).join('-');
        scanEnded = undefined;
        scanFailure = undefined;
        const ended = new Promise<ScanEndedEvent>(resolve => {
          finishScan = resolve;
        });

        try {
          await IsoDepNfc.startScan({scanId});
          await Promise.race([ended, stopped]);
        } catch (error) {
          const {code} = error as IsoDepNfcError;

          if (code !== 'APP_INACTIVE' && code !== 'NFC_DISABLED') {
            scanFailure = error;
          } else {
            await Promise.race([changed, stopped]);
          }
        }

        try {
          await IsoDepNfc.stopScan({scanId});
        } catch (error) {
          scanFailure = error;
        }

        await Promise.all(sessions);
        scanId = undefined;

        if (scanFailure !== undefined) {
          throw scanFailure;
        }

        const reason = (scanEnded as ScanEndedEvent | undefined)?.reason;

        if (
          reason !== undefined &&
          reason !== 'app-paused' &&
          reason !== 'nfc-disabled'
        ) {
          throw new Error(`NFC scanning ended: ${reason}.`);
        }
      }
    } catch (error) {
      if (!disposed) {
        onError(new IsoDepScanError(error));
        onCleanup?.();
      }
    } finally {
      await Promise.all(listeners.map(listener => listener.remove()));
    }
  };

  previousScan = previousScan.then(run).catch(console.error);

  return () => {
    disposed = true;
    stop();
  };
}
