import {App} from '@capacitor/app';
import {Capacitor} from '@capacitor/core';

const listeners = new Set<() => void>();
let androidStopped = false;
let watching: Document | undefined;

export function isAppHidden(): boolean {
  return (
    androidStopped ||
    (typeof document !== 'undefined' && document.visibilityState === 'hidden')
  );
}

export function watchAppHidden(listener: () => void): () => void {
  listeners.add(listener);
  watchVisibility();
  return () => {
    listeners.delete(listener);
    watchVisibility();
  };
}

function notify(): void {
  for (const listener of listeners) listener();
  watchVisibility();
}

function visibility(): void {
  if (document.visibilityState === 'visible') androidStopped = false;
  notify();
}

function watchVisibility(): void {
  // Keep observing a stopped Android app until resume, even after all holders clear.
  const needed = listeners.size > 0 || androidStopped;
  if (!needed && watching) {
    watching.removeEventListener('visibilitychange', visibility);
    watching = undefined;
  }
  if (needed && !watching && typeof document !== 'undefined') {
    watching = document;
    watching.addEventListener('visibilitychange', visibility);
  }
}

// Android emits this from onStop; iOS inactivity includes biometric/NFC overlays.
if (Capacitor.getPlatform() === 'android') {
  void App.addListener('appStateChange', ({isActive}) => {
    androidStopped = !isActive;
    notify();
  });
}
