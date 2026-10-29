import {App} from '@capacitor/app';
import type {PluginListenerHandle} from '@capacitor/core';

// Preserve the same queue across hot updates so old scanner cleanup still
// blocks a new page or popup from opening the camera.
export const qrScanLifecycle: {closing: Promise<void>} = import.meta.hot?.data
  .qrScanLifecycle ?? {closing: Promise.resolve()};

if (import.meta.hot) {
  import.meta.hot.data.qrScanLifecycle = qrScanLifecycle;
}
type ResumeRequest = {
  ready: boolean;
  canResume: () => boolean;
  resume: () => void;
};

/** Coordinates fresh camera attempts after a native scan is paused. */
export class QrScanForeground {
  private disposed = false;
  private listener?: PluginListenerHandle;
  private appActive = false;
  private foreground = false;
  private generation = 0;
  private resumedGeneration = -1;
  private pending?: ResumeRequest;

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
    const request = {ready: false, canResume, resume};
    this.pending = request;

    // A fresh scan must wait for this camera's actual cleanup, even when the
    // shared closing queue has absorbed its failure for other callers.
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
      this.resumedGeneration === this.generation ||
      !request.canResume()
    )
      return;

    // Native scanEnded can arrive after the foreground notification. Permit
    // that recovery, but never loop on APP_INACTIVE with a stale active state.
    this.resumedGeneration = this.generation;
    this.pending = undefined;
    request.resume();
  };
}
