import {App} from '@capacitor/app';
import type {PluginListenerHandle} from '@capacitor/core';

// Preserve the same queue across hot updates so old scanner cleanup still
// blocks a new page or popup from opening the camera.
export const qrScanLifecycle: {closing: Promise<void>} = import.meta.hot?.data
  .qrScanLifecycle ?? {closing: Promise.resolve()};

if (import.meta.hot) {
  import.meta.hot.data.qrScanLifecycle = qrScanLifecycle;
}
type ForegroundRequest = {
  ready: boolean;
  oncePerForeground: boolean;
  canRun: () => boolean;
  run: () => void;
};

/** Coordinates camera recovery and accepted results with foreground readiness. */
export class QrScanForeground {
  private disposed = false;
  private listener?: PluginListenerHandle;
  private appActive = false;
  private foreground = false;
  private generation = 0;
  private resumedGeneration = -1;
  private pending?: ForegroundRequest;

  constructor(private readonly onError: (error: unknown) => void) {
    document.addEventListener('visibilitychange', this.update);

    void (async () => {
      let revision = 0;
      const listener = await App.addListener('appStateChange', ({isActive}) => {
        revision++;
        this.appActive = isActive;
        this.update();
      });
      if (this.disposed) {
        await listener.remove();
        return;
      }
      this.listener = listener;

      const snapshotRevision = revision;
      const {isActive} = await App.getState();
      if (this.disposed || revision !== snapshotRevision) return;
      this.appActive = isActive;
      this.update();
    })().catch(onError);
  }

  requestResume(
    ready: Promise<void>,
    canResume: () => boolean,
    resume: () => void,
  ): () => void {
    return this.request(ready, canResume, resume, true);
  }

  waitForForeground(
    ready: Promise<void>,
    canRun: () => boolean,
    run: () => void,
  ): () => void {
    return this.request(ready, canRun, run, false);
  }

  private request(
    ready: Promise<void>,
    canRun: () => boolean,
    run: () => void,
    oncePerForeground: boolean,
  ): () => void {
    const request = {ready: false, oncePerForeground, canRun, run};
    this.pending = request;

    // Recovery and result delivery both require successful camera cleanup,
    // even when the shared closing queue absorbs its failure for other callers.
    void ready.then(
      () => {
        if (this.pending !== request) return;
        request.ready = true;
        this.update();
      },
      () => {
        if (this.pending === request) this.pending = undefined;
      },
    );

    return () => {
      if (this.pending === request) this.pending = undefined;
    };
  }

  dispose(): void {
    this.disposed = true;
    this.pending = undefined;
    document.removeEventListener('visibilitychange', this.update);
    void this.listener?.remove().catch(this.onError);
    this.listener = undefined;
  }

  private readonly update = (): void => {
    if (this.disposed) return;
    const foreground = this.appActive && !document.hidden;
    if (foreground && !this.foreground) this.generation++;
    this.foreground = foreground;

    const request = this.pending;
    if (
      !foreground ||
      !request?.ready ||
      (request.oncePerForeground &&
        this.resumedGeneration === this.generation) ||
      !request.canRun()
    )
      return;

    // Native scanEnded can arrive after the foreground notification. Permit
    // that recovery, but never loop on APP_INACTIVE with a stale active state.
    if (request.oncePerForeground) this.resumedGeneration = this.generation;
    this.pending = undefined;
    request.run();
  };
}
