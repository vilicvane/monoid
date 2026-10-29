// Serialized into a classic inline script: keep every dependency inside this function.
export function installHmrReconnect(window, endpoint, initialSequence) {
  const NativeWebSocket = window.WebSocket;
  const {document} = window;
  const limit = 64;
  if (
    typeof NativeWebSocket !== 'function' ||
    !window.fetch ||
    !window.EventTarget ||
    !window.CloseEvent ||
    !window.MessageEvent ||
    !window.AbortController
  ) {
    return;
  }

  function wrap(url, protocols) {
    const events = new window.EventTarget();
    let socket;
    let baseline;
    let opened = false;
    let checking = true;
    let recovering = false;
    let finished = false;
    let closing = false;
    let unloading = false;
    let lastClose;
    let retryTimer;
    let deadlineTimer;
    let visibleSince;
    let remaining = 60_000;
    let delay = 250;
    const outgoing = [];
    const incoming = [];

    function clearRecovery() {
      window.clearTimeout(retryTimer);
      window.clearTimeout(deadlineTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      visibleSince = undefined;
    }

    function finish(event) {
      if (finished) return;
      finished = true;
      clearRecovery();
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
      outgoing.length = incoming.length = 0;
      socket.close();
      if (event) events.dispatchEvent(new window.CloseEvent('close', event));
    }

    function fallback() {
      window.console.info('[monoid hmr] reconnect-reload (Vite fallback)');
      finish(lastClose);
    }

    function reload() {
      if (finished) return;
      window.console.info('[monoid hmr] reconnect-reload');
      finish();
      if (!unloading) window.location.reload();
    }

    function onUnload() {
      unloading = true;
      if (recovering) finish(lastClose);
    }

    function schedule(wait = 0) {
      window.clearTimeout(retryTimer);
      if (document.visibilityState === 'visible') {
        retryTimer = window.setTimeout(connect, wait);
      }
    }

    function onVisibility() {
      if (visibleSince !== undefined) {
        remaining -= window.performance.now() - visibleSince;
      }
      visibleSince = undefined;
      window.clearTimeout(deadlineTimer);
      window.clearTimeout(retryTimer);
      if (document.visibilityState === 'visible') {
        visibleSince = window.performance.now();
        deadlineTimer = window.setTimeout(fallback, Math.max(0, remaining));
        if (socket.readyState === NativeWebSocket.CLOSED) schedule();
      }
    }

    async function readSequence() {
      const controller = new window.AbortController();
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const response = await window.fetch(endpoint, {
              cache: 'no-store',
              signal: controller.signal,
            });
            if (!response.ok) throw new Error('Sequence request failed');
            const value = await response.json();
            if (
              typeof value?.instance !== 'string' ||
              !value.instance ||
              !Number.isSafeInteger(value.sequence) ||
              value.sequence < 0
            ) {
              throw new Error('Invalid sequence');
            }
            return value;
          })(),
          new Promise((resolve, reject) => {
            timer = window.setTimeout(() => {
              reject(new Error('Sequence request timed out'));
              controller.abort();
            }, 5000);
          }),
        ]);
      } finally {
        window.clearTimeout(timer);
      }
    }

    function sameSequence(a, b) {
      return a.instance === b.instance && a.sequence === b.sequence;
    }

    async function onOpen(current) {
      try {
        if (current.protocol !== 'vite-hmr')
          throw new Error('Unexpected protocol');
        const sequence = await readSequence();
        if (
          finished ||
          socket !== current ||
          current.readyState !== current.OPEN
        ) {
          return;
        }
        if (!sameSequence(sequence, baseline ?? initialSequence)) {
          reload();
          return;
        }
        baseline = sequence;
      } catch {
        if (
          finished ||
          socket !== current ||
          current.readyState !== current.OPEN
        ) {
          return;
        }
        if (recovering) {
          reload();
          return;
        }
        // No trustworthy initial snapshot: let Vite handle the next disconnect.
        baseline = undefined;
      }
      checking = false;
      if (recovering) {
        clearRecovery();
        recovering = false;
        remaining = 60_000;
        delay = 250;
        window.console.info('[monoid hmr] reconnect-kept');
      }
      if (!opened) {
        opened = true;
        events.dispatchEvent(new window.Event('open'));
      }
      for (const data of outgoing.splice(0)) socket.send(data);
      for (const event of incoming.splice(0)) events.dispatchEvent(event);
    }

    function connect() {
      if (finished) return;
      checking = true;
      incoming.length = 0;
      try {
        const current = new NativeWebSocket(url, protocols);
        socket = current;
        current.addEventListener('open', () => void onOpen(current));
        current.addEventListener('message', event => {
          if (finished || socket !== current) return;
          const message = new window.MessageEvent('message', {
            data: event.data,
            origin: event.origin,
          });
          if (checking) {
            if (incoming.length === limit) reload();
            else incoming.push(message);
          } else {
            events.dispatchEvent(message);
          }
        });
        current.addEventListener('error', () => {
          if (!finished && socket === current && !recovering) {
            events.dispatchEvent(new window.Event('error'));
          }
        });
        current.addEventListener('close', event => {
          if (finished || socket !== current) return;
          if (event.wasClean || closing || unloading || !opened || !baseline) {
            finish(event);
            return;
          }
          lastClose = event;
          if (!recovering) {
            recovering = true;
            document.addEventListener('visibilitychange', onVisibility);
            onVisibility();
          } else {
            schedule(delay);
            delay = Math.min(delay * 2, 5000);
          }
        });
      } catch (error) {
        if (!recovering) throw error;
        fallback();
      }
    }

    // Vite 7.0.6 uses EventTarget methods, send/close, readyState/OPEN and url.
    // Delegate other WebSocket properties to the current native socket.
    const facade = new Proxy(events, {
      get(target, key) {
        if (key === 'readyState') {
          if (finished) return NativeWebSocket.CLOSED;
          return checking || recovering
            ? NativeWebSocket.CONNECTING
            : socket.readyState;
        }
        if (key === 'send') {
          return data => {
            if (!finished && (recovering || checking)) {
              if (outgoing.length === limit) reload();
              else outgoing.push(data);
            } else {
              socket.send(data);
            }
          };
        }
        if (key === 'close') {
          return (code, reason) => {
            closing = true;
            if (socket.readyState === NativeWebSocket.CLOSED) {
              finish({wasClean: true, code: code ?? 1000, reason});
            } else {
              socket.close(code, reason);
            }
          };
        }
        const owner = key in target ? target : socket;
        const value = Reflect.get(owner, key, owner);
        return typeof value === 'function' ? value.bind(owner) : value;
      },
      set(target, key, value) {
        return Reflect.set(socket, key, value, socket);
      },
    });
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    connect();
    return facade;
  }

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const [url, protocols] = args;
      if (
        protocols === 'vite-hmr' ||
        (Array.isArray(protocols) &&
          protocols.length === 1 &&
          protocols[0] === 'vite-hmr')
      ) {
        return wrap(url, protocols);
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
}
