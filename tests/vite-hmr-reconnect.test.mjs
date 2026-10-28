import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

import {installHmrReconnect} from '../scripts/vite-hmr-reconnect-client.mjs';
import {viteHmrReconnect} from '../scripts/vite-hmr-reconnect.mjs';

const initial = {instance: 'server-1', sequence: 10};
const endpoint = '/__monoid/hmr-sequence';
const hmrUrl = 'ws://localhost:5173/?token=original-token';

class CloseEvent extends Event {
  constructor(type, {wasClean = false, code = 1006, reason = ''} = {}) {
    super(type);
    Object.assign(this, {wasClean, code, reason});
  }
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function clientHarness(install = installHmrReconnect) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const sockets = [];
  const requests = [];
  const logs = [];
  let reloads = 0;
  let response = () => ({...initial});
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
  });

  class WebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = WebSocket.CONNECTING;
    protocol = '';
    binaryType = 'blob';
    sent = [];

    constructor(url, protocols) {
      super();
      this.url = new URL(url).href;
      this.protocols = protocols;
      sockets.push(this);
    }

    open() {
      this.readyState = WebSocket.OPEN;
      this.protocol = Array.isArray(this.protocols)
        ? this.protocols[0]
        : (this.protocols ?? '');
      this.dispatchEvent(new Event('open'));
    }

    message(data) {
      this.dispatchEvent(new MessageEvent('message', {data}));
    }

    drop(options) {
      this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent('close', options));
    }

    close(code = 1000, reason = '') {
      if (this.readyState !== WebSocket.CLOSED) {
        this.drop({wasClean: true, code, reason});
      }
    }

    send(data) {
      assert.equal(this.readyState, WebSocket.OPEN);
      this.sent.push(data);
    }
  }
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    WebSocket.prototype[key] = WebSocket[key];
  }

  const window = Object.assign(new EventTarget(), {
    WebSocket,
    EventTarget,
    Event,
    CloseEvent,
    MessageEvent,
    AbortController,
    document,
    console: {info: line => logs.push(line)},
    location: {reload: () => reloads++},
    performance: {now: () => now},
    fetch: async (url, options) => {
      requests.push({url, ...options});
      return {ok: true, json: response};
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, {at: now + delay, callback});
      return id;
    },
    clearTimeout: id => timers.delete(id),
  });
  install(window, endpoint, initial);

  return {
    window,
    sockets,
    requests,
    logs,
    get reloads() {
      return reloads;
    },
    respond: value => {
      response = typeof value === 'function' ? value : () => value;
    },
    visible(visible) {
      document.visibilityState = visible ? 'visible' : 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    async tick(ms = 0) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.callback();
        await flush();
      }
      now = end;
      await flush();
    },
    async connect() {
      const socket = new window.WebSocket(hmrUrl, 'vite-hmr');
      sockets.at(-1).open();
      await flush();
      return socket;
    },
  };
}

test('reconnect retains the socket, listeners, messages and URL/protocol', async () => {
  const state = clientHarness();
  const socket = await state.connect();
  let closes = 0;
  let opens = 0;
  const messages = [];
  const removed = () => assert.fail('Removed listener ran');
  socket.addEventListener('message', removed);
  socket.removeEventListener('message', removed);
  socket.addEventListener('message', event => messages.push(event.data));
  socket.addEventListener('close', () => closes++);
  socket.addEventListener('open', () => opens++);
  assert.equal(socket.readyState, socket.OPEN);
  assert.equal(socket.OPEN, state.window.WebSocket.OPEN);
  socket.send('{"type":"ping"}');
  state.sockets[0].drop();
  socket.send('{"type":"custom","event":"queued"}');
  await state.tick();
  assert.equal(socket.readyState, socket.CONNECTING);
  assert.equal(state.sockets[1].url, hmrUrl);
  assert.equal(state.sockets[1].protocols, 'vite-hmr');
  state.sockets[1].open();
  state.sockets[1].message('{"type":"connected"}');
  assert.deepEqual(messages, []);
  await flush();
  state.sockets[1].message('{"type":"update","updates":[]}');
  state.sockets[0].message('old socket');
  assert.deepEqual(messages, [
    '{"type":"connected"}',
    '{"type":"update","updates":[]}',
  ]);
  assert.deepEqual(state.sockets[1].sent, [
    '{"type":"custom","event":"queued"}',
  ]);
  assert.equal(socket.url, hmrUrl);
  assert.equal(socket.protocol, 'vite-hmr');
  socket.binaryType = 'arraybuffer';
  assert.equal(state.sockets[1].binaryType, 'arraybuffer');
  assert.equal(socket.readyState, socket.OPEN);
  assert.equal(closes, 0);
  assert.equal(opens, 0);
  assert.equal(state.reloads, 0);
  assert.deepEqual(state.logs, ['[monoid hmr] reconnect-kept']);
  assert.ok(
    state.requests.every(r => r.url === endpoint && r.cache === 'no-store'),
  );

  // Recovering again uses the same facade and resumes its retained listeners.
  state.sockets[1].drop();
  await state.tick();
  state.sockets[2].open();
  await flush();
  assert.equal(socket.readyState, socket.OPEN);
  assert.equal(state.reloads, 0);
});

for (const [name, response] of [
  ['changed sequence', {...initial, sequence: 11}],
  ['server restart', {...initial, instance: 'server-2'}],
  ['malformed sequence', {...initial, sequence: '10'}],
  ['endpoint failure', () => Promise.reject(new Error('Offline'))],
]) {
  test(`reconnect reloads on ${name}`, async () => {
    const state = clientHarness();
    const socket = await state.connect();
    let closes = 0;
    socket.addEventListener('close', () => closes++);
    state.sockets[0].drop();
    await state.tick();
    state.respond(response);
    state.sockets[1].open();
    state.sockets[1].message('must not reach Vite');
    await flush();
    assert.equal(state.reloads, 1);
    assert.equal(socket.readyState, socket.CLOSED);
    assert.equal(closes, 0);
    assert.deepEqual(state.logs, ['[monoid hmr] reconnect-reload']);
  });
}

test('HTTP errors and hanging sequence requests reload on reconnect', async () => {
  for (const hang of [false, true]) {
    const state = clientHarness();
    await state.connect();
    state.sockets[0].drop();
    await state.tick();
    if (hang) state.respond(() => new Promise(() => {}));
    else state.window.fetch = async () => ({ok: false});
    state.sockets[1].open();
    await state.tick(5000);
    assert.equal(state.reloads, 1);
  }
});

test('a stale HTML snapshot reloads; a failed initial check leaves Vite in control', async () => {
  const stale = clientHarness();
  stale.respond({...initial, sequence: 11});
  await stale.connect();
  assert.equal(stale.reloads, 1);

  const state = clientHarness();
  state.respond(() => Promise.reject(new Error('Offline')));
  const socket = await state.connect();
  let closes = 0;
  socket.addEventListener('close', () => closes++);
  state.sockets[0].drop();
  await state.tick();
  assert.equal(closes, 1);
  assert.equal(state.sockets.length, 1);
  assert.equal(state.reloads, 0);
});

test('non-HMR sockets, vite-ping and constructor constants are untouched', () => {
  const state = clientHarness();
  for (const protocol of [
    undefined,
    'chat',
    'vite-ping',
    ['chat', 'vite-hmr'],
  ]) {
    const socket = new state.window.WebSocket(hmrUrl, protocol);
    assert.equal(socket, state.sockets.at(-1));
    assert.equal(socket.protocols, protocol);
  }
  assert.equal(state.window.WebSocket.OPEN, 1);
  assert.deepEqual(state.requests, []);
});

test('reconnect waits for visibility and applies backoff', async () => {
  const state = clientHarness();
  await state.connect();
  state.visible(false);
  state.sockets[0].drop();
  await state.tick(120_000);
  assert.equal(state.sockets.length, 1);
  state.visible(true);
  await state.tick();
  assert.equal(state.sockets.length, 2);
  state.sockets[1].drop();
  await state.tick(249);
  assert.equal(state.sockets.length, 2);
  await state.tick(1);
  assert.equal(state.sockets.length, 3);
  state.sockets[2].drop();
  await state.tick(499);
  assert.equal(state.sockets.length, 3);
  await state.tick(1);
  state.sockets[3].open();
  await flush();
  assert.equal(state.reloads, 0);
  assert.deepEqual(state.logs, ['[monoid hmr] reconnect-kept']);
});

test('60 seconds of visible failure forwards close for Vite fallback', async () => {
  const state = clientHarness();
  const socket = await state.connect();
  const closes = [];
  socket.addEventListener('close', event => closes.push(event));
  state.sockets[0].drop({code: 1006, reason: 'Lost'});
  await state.tick(30_000);
  state.visible(false);
  await state.tick(600_000);
  assert.equal(closes.length, 0);
  state.visible(true);
  await state.tick(29_999);
  assert.equal(closes.length, 0);
  await state.tick(1);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].wasClean, false);
  assert.equal(closes[0].code, 1006);
  assert.equal(closes[0].reason, 'Lost');
  assert.equal(socket.readyState, socket.CLOSED);
  assert.equal(state.reloads, 0);
  assert.deepEqual(state.logs, [
    '[monoid hmr] reconnect-reload (Vite fallback)',
  ]);
});

test('clean close, explicit close, initial failure and unloading pass through', async () => {
  for (const mode of [
    'clean',
    'explicit',
    'initial',
    'beforeunload',
    'pagehide',
  ]) {
    const state = clientHarness();
    const socket =
      mode === 'initial'
        ? new state.window.WebSocket(hmrUrl, 'vite-hmr')
        : await state.connect();
    let closes = 0;
    socket.addEventListener('close', () => closes++);
    if (mode === 'explicit') socket.close();
    else {
      if (mode === 'beforeunload' || mode === 'pagehide') {
        state.window.dispatchEvent(new Event(mode));
      }
      state.sockets[0].drop({wasClean: mode === 'clean'});
    }
    await state.tick(60_000);
    assert.equal(closes, 1, mode);
    assert.equal(state.sockets.length, 1, mode);
    assert.equal(state.reloads, 0, mode);
  }
});

test('late checks from a dead socket cannot confirm a new connection', async () => {
  const state = clientHarness();
  await state.connect();
  state.sockets[0].drop();
  await state.tick();
  let resolve;
  state.respond(() => new Promise(done => (resolve = done)));
  state.sockets[1].open();
  await flush();
  state.sockets[1].drop();
  await state.tick(250);
  resolve({...initial, sequence: 11});
  await flush();
  assert.equal(state.reloads, 0);
  state.respond(initial);
  state.sockets[2].open();
  await flush();
  assert.deepEqual(state.logs, ['[monoid hmr] reconnect-kept']);
});

function serverHarness() {
  const middlewares = [];
  const watcher = new EventEmitter();
  const graph = {invalidateModule() {}, invalidateAll() {}};
  const clientGraph = {invalidateModule() {}, invalidateAll() {}};
  const sends = [];
  const server = {
    config: {base: '/', logger: {warn: message => assert.fail(message)}},
    watcher,
    ws: {
      send(...args) {
        assert.equal(this, server.ws);
        sends.push(args);
        return 'sent';
      },
    },
    moduleGraph: graph,
    environments: {client: {moduleGraph: clientGraph}},
    middlewares: {use: middleware => middlewares.push(middleware)},
  };
  const plugin = viteHmrReconnect();
  plugin.configureServer(server);
  function request(url = endpoint, method = 'GET') {
    const headers = {};
    let result;
    let next = false;
    middlewares[0](
      {url, method},
      {
        setHeader: (key, value) => (headers[key] = value),
        end: body => (result = JSON.parse(body)),
      },
      () => (next = true),
    );
    return {result, headers, next};
  }
  return {server, plugin, request, sends};
}

test('server sequence covers watcher changes, broadcasts and graph invalidation', () => {
  const {server, plugin, request, sends} = serverHarness();
  assert.equal(plugin.apply, 'serve');
  const start = request().result;
  assert.equal(start.sequence, 0);
  assert.ok(start.instance);
  let expected = 0;
  for (const event of ['add', 'change', 'unlink']) {
    server.watcher.emit(event, '/file.ts');
    assert.equal(request().result.sequence, ++expected);
  }
  for (const type of ['full-reload', 'update', 'prune', 'custom', 'error']) {
    assert.equal(server.ws.send({type}), 'sent');
    assert.equal(request().result.sequence, ++expected);
  }
  server.ws.send('custom-event', {data: 1});
  assert.deepEqual(sends.at(-1), ['custom-event', {data: 1}]);
  assert.equal(request().result.sequence, ++expected);
  for (const graph of [
    server.moduleGraph,
    server.environments.client.moduleGraph,
  ]) {
    graph.invalidateModule({});
    assert.equal(request().result.sequence, ++expected);
    graph.invalidateAll();
    assert.equal(request().result.sequence, ++expected);
  }
  server.ws.send({type: 'ping'});
  server.ws.send({type: 'connected'});
  assert.equal(request().result.sequence, expected);
  assert.equal(request().result.instance, start.instance);
  assert.notEqual(serverHarness().request().result.instance, start.instance);
  plugin.closeBundle();
  server.watcher.emit('change', '/later.ts');
  server.ws.send({type: 'full-reload'});
  server.moduleGraph.invalidateAll();
  assert.equal(request().result.sequence, expected);
});

test('sequence endpoint is uncached, precise, GET-only and respects base', () => {
  const {request} = serverHarness();
  assert.equal(request().headers['Cache-Control'], 'no-store');
  assert.equal(request().headers['Content-Type'], 'application/json');
  assert.equal(request(`${endpoint}?check=1`).result.sequence, 0);
  for (const url of ['/', `${endpoint}/extra`]) {
    assert.equal(request(url).next, true);
  }
  assert.equal(request(endpoint, 'POST').next, true);
  const {server} = serverHarness();
  server.config.base = '/nested/';
  const plugin = viteHmrReconnect();
  plugin.configureServer(server);
  assert.ok(
    plugin.transformIndexHtml
      .handler()[0]
      .children.includes('/nested/__monoid/'),
  );
  plugin.closeBundle();
});

test('injected classic script has no external dependencies', async () => {
  const {plugin, request} = serverHarness();
  const [tag] = plugin.transformIndexHtml.handler();
  assert.equal(tag.injectTo, 'head-prepend');
  assert.equal(tag.tag, 'script');
  assert.equal(tag.attrs?.type, undefined);
  const snapshot = request().result;
  const state = clientHarness(window => {
    vm.runInNewContext(tag.children, {window});
  });
  state.respond(snapshot);
  const socket = await state.connect();
  assert.equal(socket.readyState, socket.OPEN);
  assert.equal(state.reloads, 0);
  plugin.closeBundle();
});

test('the installed Vite client still matches the documented socket contract', async () => {
  const client = await readFile(
    new URL('../node_modules/vite/dist/client/client.mjs', import.meta.url),
    'utf8',
  );
  assert.match(client, /new WebSocket\([^\n]+, "vite-hmr"\)/);
  assert.match(client, /socket\.readyState === socket\.OPEN/);
  assert.match(client, /socket\.send\(JSON\.stringify\(\{ type: "ping" \}\)\)/);
  assert.match(client, /event: "vite:ws:disconnect"/);
  assert.match(
    client,
    /await waitForSuccessfulPing\(url\.href\);\s*location\.reload\(\)/,
  );
});
