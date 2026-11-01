import {randomUUID} from 'node:crypto';

import {version} from 'vite';

import {installHmrReconnect} from './vite-hmr-reconnect-client.mjs';

/** @returns {import('vite').Plugin} */
export function viteHmrReconnect() {
  // Intentional dependency on Vite 7.3.7 client internals (client.mjs):
  // vite-hmr transport -> close -> vite:ws:disconnect -> vite-ping -> reload.
  // The transport retains one socket and sends JSON pings AND custom messages.
  // Recheck that contract before enabling another version. Otherwise use Vite.
  // https://github.com/vitejs/vite/issues/5675
  const supported = version === '7.3.7';
  let snapshot;
  let endpoint;
  const disposers = [];

  return {
    name: 'monoid-hmr-reconnect',
    apply: 'serve',
    configureServer(server) {
      const graphs = new Set([
        server.moduleGraph,
        server.environments?.client?.moduleGraph,
      ]);
      if (
        !supported ||
        typeof server.ws?.send !== 'function' ||
        [...graphs].some(
          graph =>
            typeof graph?.invalidateModule !== 'function' ||
            typeof graph?.invalidateAll !== 'function',
        )
      ) {
        server.config.logger.warn(
          `[monoid hmr] unverified Vite ${version} APIs; using Vite reconnect`,
        );
        return;
      }
      snapshot = {instance: randomUUID(), sequence: 0};
      endpoint = `${server.config.base}__monoid/hmr-sequence`;
      const advance = () => snapshot.sequence++;
      for (const event of ['add', 'change', 'unlink']) {
        server.watcher.on(event, advance);
        disposers.push(() => server.watcher.off(event, advance));
      }

      // Decorate public APIs, preserving arguments/receivers/return values.
      // Vite exposes no event for outgoing reloads or explicit invalidation.
      function observe(target, name, before) {
        const original = target[name];
        const wrapped = function (...args) {
          before(...args);
          return original.apply(this, args);
        };
        target[name] = wrapped;
        disposers.push(() => {
          if (target[name] === wrapped) target[name] = original;
        });
      }
      observe(server.ws, 'send', payload => {
        // Include custom/error messages: a disconnected client can miss those too.
        if (payload?.type !== 'ping' && payload?.type !== 'connected')
          advance();
      });
      for (const graph of graphs) {
        observe(graph, 'invalidateModule', advance);
        observe(graph, 'invalidateAll', advance);
      }

      server.middlewares.use((request, response, next) => {
        if (
          request.method !== 'GET' ||
          request.url?.split('?')[0] !== endpoint
        ) {
          next();
          return;
        }
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(snapshot));
      });
    },
    transformIndexHtml: {
      // Run after Vite's injection, then prepend ahead of /@vite/client.
      order: 'post',
      handler() {
        if (!supported || !snapshot) return;
        return [
          {
            tag: 'script',
            injectTo: 'head-prepend',
            children: `(${installHmrReconnect.toString()})(window, ${JSON.stringify(endpoint)}, ${JSON.stringify(snapshot)});`,
          },
        ];
      },
    },
    closeBundle() {
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}
