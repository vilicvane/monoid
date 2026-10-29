/** Advance wall time independently of timers to model a suspended WebView. */
export function pinClock(t) {
  const originalDocument = globalThis.document;
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const listeners = new Set();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  document.addEventListener = (type, listener) => {
    listeners.add(listener);
    add(type, listener);
  };
  document.removeEventListener = (type, listener) => {
    listeners.delete(listener);
    remove(type, listener);
  };
  globalThis.document = document;
  t.after(() => {
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  let now = 1000;
  let nextTimer = 0;
  const timers = new Map();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    timers.set(++nextTimer, {callback, at: now + delay});
    return nextTimer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => timers.delete(timer));
  return {
    timers,
    listeners,
    elapse(milliseconds) {
      now += milliseconds;
    },
    tick(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    visibility(value) {
      document.visibilityState = value;
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}
