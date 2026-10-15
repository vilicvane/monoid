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
  onConnectionChange?: (connected: boolean) => void,
): () => Promise<void> {
  let disposed = false;
  let connectedSessionId: string | undefined;
  const setConnectedSession = (sessionId: string | undefined): void => {
    const wasConnected = connectedSessionId !== undefined;
    connectedSessionId = sessionId;
    const connected = sessionId !== undefined;

    if (connected !== wasConnected) {
      onConnectionChange?.(connected);
    }
  };
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => {
    stop = resolve;
  });

  const run = async (): Promise<void> => {
    const listeners: PluginListenerHandle[] = [];
    const sessions = new Set<Promise<void>>();
    const knownSessionIds = new Set<string>();
    let scanId: string | undefined;
    let scanEnded: ScanEndedEvent | undefined;
    let scanFailure: unknown;
    let cleanupFailure: {error: unknown} | undefined;
    let reportedFailure = false;
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
        cleanupFailure ??= {error};
        stop();
      } finally {
        if (connectedSessionId === sessionId) {
          setConnectedSession(undefined);
        }
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
      knownSessionIds.add(sessionId);

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
          if (
            disposed ||
            event.scanId !== scanId ||
            scanEnded ||
            knownSessionIds.has(event.sessionId)
          ) {
            return;
          }

          setConnectedSession(event.sessionId);
          startSession(event.sessionId, () => callback(event.sessionId));
        }),
      );
      listeners.push(
        await IsoDepNfc.addListener('sessionEnded', event => {
          if (disposed || event.scanId !== scanId || scanEnded) {
            return;
          }

          if (event.sessionId === connectedSessionId) {
            setConnectedSession(undefined);
          }

          if (
            knownSessionIds.has(event.sessionId) ||
            event.code === undefined
          ) {
            return;
          }

          startSession(event.sessionId, () =>
            Promise.reject(
              Object.assign(
                new Error(`The NFC connection ended: ${event.reason}.`),
                {code: event.code},
              ),
            ),
          );
        }),
      );
      listeners.push(
        await IsoDepNfc.addListener('scanEnded', event => {
          if (event.scanId === scanId) {
            scanEnded = event;
            setConnectedSession(undefined);
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
        knownSessionIds.clear();
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
          cleanupFailure ??= {error};
        }

        await Promise.all(sessions);
        scanId = undefined;

        if (cleanupFailure) {
          throw cleanupFailure.error;
        }

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
        reportedFailure = true;
        onError(new IsoDepScanError(error));
        onCleanup?.();
      }
    } finally {
      setConnectedSession(undefined);
      const removals = await Promise.allSettled(
        listeners.map(async listener => listener.remove()),
      );

      for (const removal of removals) {
        if (removal.status === 'rejected') {
          cleanupFailure ??= {error: removal.reason};
        }
      }
    }

    if (cleanupFailure) {
      if (!disposed && !reportedFailure) {
        onError(new IsoDepScanError(cleanupFailure.error));
        onCleanup?.();
      }

      throw cleanupFailure.error;
    }
  };

  const finished = previousScan.then(run);
  previousScan = finished.catch(() => {});

  return () => {
    disposed = true;
    setConnectedSession(undefined);
    stop();

    // A cancelled queued scan still waits its turn before completing cleanup.
    return finished;
  };
}
