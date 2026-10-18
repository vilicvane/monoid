import assert from 'node:assert/strict';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {after, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

let rendering;
let scanner;
let moduleVersion = 0;

const WALLET_CONNECT_URI = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;

mock.module('@capacitor/core', {
  namedExports: {
    Capacitor: {
      getPlatform: () => 'android',
      isPluginAvailable: () => true,
    },
  },
});
mock.module('@capacitor/clipboard', {
  namedExports: {
    Clipboard: {
      read: async () => assert.fail('Unexpected clipboard read.'),
    },
  },
});
mock.module('capacitor-qr-scanner', {
  namedExports: {
    QrScanner: Object.fromEntries(
      [
        'checkPermissions',
        'requestPermissions',
        'addListener',
        'startScan',
        'animatePreview',
        'stopScan',
        'updatePreviewBounds',
      ].map(name => [name, (...args) => scanner[name](...args)]),
    ),
  },
});
mock.module('react', {
  namedExports: {
    useCallback: (callback, dependencies) => {
      const state = rendering;
      const index = state.callbackIndex++;
      const previous = state.callbacks[index];
      if (
        !previous ||
        dependencies.some(
          (dependency, position) =>
            !Object.is(dependency, previous.dependencies[position]),
        )
      ) {
        state.callbacks[index] = {callback, dependencies};
      }
      return state.callbacks[index].callback;
    },
    useEffect: (effect, dependencies) => {
      const state = rendering;
      const index = state.effectIndex++;
      const previous = state.effects[index];
      if (
        !previous ||
        !dependencies ||
        dependencies.some(
          (dependency, position) =>
            !Object.is(dependency, previous.dependencies?.[position]),
        )
      ) {
        state.pendingEffects.push({index, effect, dependencies});
      }
    },
    useRef: initial => {
      const state = rendering;
      const index = state.refIndex++;
      return (state.refs[index] ??= {
        current:
          initial === null
            ? {
                getBoundingClientRect: () => ({
                  x: 40,
                  y: 80,
                  width: 320,
                  height: 320,
                }),
              }
            : initial,
      });
    },
    useState: initial => {
      const state = rendering;
      const index = state.stateIndex++;
      if (initial === 'starting') state.statusIndex = index;
      if (!(index in state.values)) state.values[index] = initial;
      return [
        state.values[index],
        value => {
          if (!state.mounted) return;
          state.values[index] =
            typeof value === 'function' ? value(state.values[index]) : value;
        },
      ];
    },
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
  },
});
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('@ionic/react', {namedExports: {IonIcon: 'ion-icon'}});
const assets = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.svg')
      ? {format: 'module', source: 'export default "icon";', shortCircuit: true}
      : nextLoad(url, context);
  },
});
mock.module('styled-components', {
  namedExports: {
    createGlobalStyle: () => 'global-style',
    css: () => '',
    keyframes: () => 'animation',
    styled: Object.assign(type => () => type, {
      div: () => 'div',
      p: () => 'p',
    }),
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => rendering.entrances},
});
mock.module('../.bld/app/@components/@ui/button.js', {
  namedExports: {Button: 'button'},
});
mock.module('../.bld/app/@components/@ui/toast.js', {
  namedExports: {useToast: () => rendering.toast},
});
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {
    View: 'section',
    ViewContent: 'main',
    ViewHeader: 'header',
    ViewHeaderTitle: 'h1',
  },
});
mock.module('../.bld/app/@components/views/@scan/qr-scan-preview.js', {
  namedExports: {
    QrScanPreview: 'qr-scan-preview',
    SCAN_CIRCLE_INSET: 40,
  },
});
mock.module('../.bld/app/@components/views/@scan/qr-scan-instructions.js', {
  namedExports: {QrScanInstructions: 'qr-scan-instructions'},
});

const originalGlobals = Object.fromEntries(
  ['window', 'ResizeObserver', '__scanViewHot'].map(name => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);
globalThis.window = {
  innerWidth: 400,
  innerHeight: 800,
  matchMedia: () => ({matches: false}),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

// Keep the real compiled effect; replace only Vite's unavailable Node metadata.
const fixtureUrl = new URL(
  '../.bld/app/@components/views/scan-view.test-fixture.js',
  import.meta.url,
);
const compiled = await readFile(
  new URL('../.bld/app/@components/views/scan-view.js', import.meta.url),
  'utf8',
);
await writeFile(
  fixtureUrl,
  compiled.replaceAll('import.meta.hot', 'globalThis.__scanViewHot'),
);
after(async () => {
  assets.deregister();
  await unlink(fixtureUrl);
  for (const [name, descriptor] of Object.entries(originalGlobals)) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {promise, resolve, reject};
}

function resetScanner(overrides = {}) {
  globalThis.__scanViewHot = {data: {}};
  scanner = {
    starts: [],
    animations: [],
    stops: [],
    listeners: [],
    checkPermissions: async () => ({camera: 'granted'}),
    requestPermissions: async () => ({camera: 'granted'}),
    addListener: async (name, callback) => {
      const listener = {
        name,
        callback,
        removals: 0,
        async remove() {
          listener.removals++;
        },
      };
      scanner.listeners.push(listener);
      return listener;
    },
    async startScan(options) {
      scanner.starts.push(options);
    },
    async animatePreview(options) {
      scanner.animations.push(options);
    },
    async stopScan({scanId}) {
      scanner.stops.push(scanId);
    },
    async updatePreviewBounds() {},
    ...overrides,
  };
  return scanner;
}

async function loadView() {
  const {ScanView} = await import(
    `${fixtureUrl.href}?version=${moduleVersion++}`
  );
  return ScanView;
}

function mount(ScanView) {
  const state = {
    mounted: true,
    values: [],
    get status() {
      return this.values[this.statusIndex];
    },
    refs: [],
    callbacks: [],
    effects: [],
    errors: [],
    toasts: [],
    connections: [],
    routes: [],
    rejected: [],
    view: {$leaving: false, $match: {$exact: {$active: true}}},
  };
  state.toast = options => state.toasts.push(options);
  state.entrances = {
    router: {
      scan: {
        connection: value => ({$push: () => state.routes.push(value)}),
      },
    },
    walletKitService: {
      connect: (uri, signal) => {
        const request = deferred();
        state.connections.push({uri, signal, ...request});
        return request.promise;
      },
      reject: async id => {
        state.rejected.push(id);
      },
    },
    errorService: {
      catch: promise => promise.catch(error => state.errors.push(error)),
    },
  };
  state.rerender = ({
    leaving = state.view.$leaving,
    active = state.view.$match.$exact.$active,
  } = {}) => {
    state.view.$leaving = leaving;
    state.view.$match.$exact.$active = active;
    state.stateIndex = 0;
    state.refIndex = 0;
    state.callbackIndex = 0;
    state.effectIndex = 0;
    state.pendingEffects = [];
    rendering = state;
    state.tree = ScanView({view: state.view});
    for (const {index, effect, dependencies} of state.pendingEffects) {
      state.effects[index]?.cleanup?.();
      state.effects[index] = {dependencies, cleanup: effect()};
    }
  };
  state.find = selector => {
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (
        typeof selector === 'function' ? selector(node) : node.type === selector
      )
        return node;
      for (const child of [node.props?.children].flat()) {
        const found = visit(child);
        if (found) return found;
      }
    };
    return visit(state.tree);
  };
  state.cover = () => state.find('qr-scan-preview').props.onCovered();
  state.cleanup = () => {
    state.mounted = false;
    for (const {cleanup} of state.effects.splice(0)) cleanup?.();
  };
  state.rerender();
  return state;
}

test('consecutive hot updates wait for the original camera to stop, including an intermediate page that never started', async () => {
  const closing = deferred();
  const native = resetScanner({
    stopScan: ({scanId}) => {
      native.stops.push(scanId);
      return scanId === native.starts[0].scanId
        ? closing.promise
        : Promise.resolve();
    },
  });
  const first = mount(await loadView());
  await setImmediate();
  assert.equal(native.starts.length, 1);

  // Vite evaluates the replacement before React cleans up the old effect.
  const SecondView = await loadView();
  first.cleanup();
  const second = mount(SecondView);
  await setImmediate();
  assert.equal(native.starts.length, 1);

  const ThirdView = await loadView();
  second.cleanup();
  const third = mount(ThirdView);
  await setImmediate();
  assert.equal(native.starts.length, 1);

  closing.resolve();
  await setImmediate();
  assert.equal(native.starts.length, 2);
  assert.notEqual(native.starts[0].scanId, native.starts[1].scanId);
  assert.deepEqual([first.errors, second.errors, third.errors], [[], [], []]);
  third.cleanup();
  await setImmediate();
});

test('leaving while camera permission is requested never starts a camera or registers listeners', async () => {
  const permissions = deferred();
  let requests = 0;
  const native = resetScanner({
    checkPermissions: async () => ({camera: 'prompt'}),
    requestPermissions: () => {
      requests++;
      return permissions.promise;
    },
  });
  const state = mount(await loadView());
  await setImmediate();
  assert.equal(requests, 1);

  state.cleanup();
  permissions.resolve({camera: 'granted'});
  await setImmediate();
  assert.deepEqual(native.starts, []);
  assert.deepEqual(native.listeners, []);
  assert.equal(native.stops.length, 1);
  assert.deepEqual(state.errors, []);
});

test('a listener registered after cleanup is removed without starting the camera', async () => {
  const registration = deferred();
  let registrations = 0;
  let removals = 0;
  const native = resetScanner({
    addListener: () => {
      registrations++;
      return registration.promise;
    },
  });
  const state = mount(await loadView());
  await setImmediate();
  assert.equal(registrations, 1);

  state.cleanup();
  registration.resolve({
    async remove() {
      removals++;
    },
  });
  await setImmediate();
  assert.equal(removals, 1);
  assert.equal(registrations, 1);
  assert.deepEqual(native.starts, []);
  assert.deepEqual(state.errors, []);
});

for (const code of ['CANCELLED', 'APP_INACTIVE']) {
  test(`${code} during startup pauses scanning without an error notification`, async () => {
    const native = resetScanner({
      startScan: async () => {
        throw Object.assign(new Error(code), {code});
      },
    });
    const state = mount(await loadView());
    await setImmediate();
    assert.equal(state.status, 'paused');
    assert.deepEqual(state.errors, []);
    assert.equal(native.stops.length, 1);

    state.cleanup();
    await setImmediate();
    assert.equal(native.stops.length, 1);
  });
}

test('the first QR result covers the camera before stopping and ignores repeated or stale results', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  await setImmediate();
  const {scanId} = native.starts[0];
  const codes = native.listeners.find(
    listener => listener.name === 'codesScanned',
  );
  const ended = native.listeners.find(
    listener => listener.name === 'scanEnded',
  );

  codes.callback({scanId: 'stale', values: ['ignored']});
  codes.callback({scanId, values: []});
  codes.callback({
    scanId,
    values: ['https://example.com', 'plain text', 'wc:invalid', 'FIDO:/123'],
  });
  assert.equal(state.status, 'scanning');
  assert.deepEqual(native.stops, []);
  assert.deepEqual(state.errors, []);

  codes.callback({scanId, values: ['unrelated', WALLET_CONNECT_URI]});
  codes.callback({scanId, values: [WALLET_CONNECT_URI]});
  ended.callback({scanId, reason: 'error', message: 'Late camera error'});
  await setImmediate();
  assert.equal(state.status, 'completing');
  assert.deepEqual(native.stops, []);
  state.cover();
  await setImmediate();
  assert.equal(state.status, 'scanned');
  assert.deepEqual(native.stops, [scanId]);
  assert.deepEqual(state.errors, []);

  state.cleanup();
  await setImmediate();
  assert.deepEqual(native.stops, [scanId]);
  assert.ok(native.listeners.every(listener => listener.removals === 1));
});

test('leaving keeps the camera and scanning presentation until unmount, while ignoring QR results', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  await setImmediate();
  state.rerender();
  const {scanId} = native.starts[0];
  const codes = native.listeners.find(
    listener => listener.name === 'codesScanned',
  );

  for (const active of [true, false]) {
    state.rerender({leaving: true, active});
    codes.callback({scanId, values: [WALLET_CONNECT_URI]});
    await setImmediate();
    assert.equal(state.find('qr-scan-preview').props.phase, 'scanning');
    assert.ok(state.find('global-style'));
    assert.equal(state.status, 'scanning');
    assert.deepEqual(native.stops, []);
    assert.equal(native.starts.length, 1);
    assert.ok(native.listeners.every(listener => listener.removals === 0));
  }

  state.cleanup();
  await setImmediate();
  assert.deepEqual(native.stops, [scanId]);
  assert.ok(native.listeners.every(listener => listener.removals === 1));
  assert.deepEqual(state.errors, []);
});

test('returning before the leaving transition finishes reuses the camera and accepts its next result', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  await setImmediate();
  state.rerender();
  const {scanId} = native.starts[0];
  const codes = native.listeners.find(
    listener => listener.name === 'codesScanned',
  );

  state.rerender({leaving: true, active: false});
  codes.callback({scanId, values: [WALLET_CONNECT_URI]});
  state.rerender({leaving: false, active: true});
  await setImmediate();
  assert.equal(state.find('qr-scan-preview').props.phase, 'scanning');
  assert.equal(native.starts.length, 1);
  assert.deepEqual(native.stops, []);
  assert.ok(native.listeners.every(listener => listener.removals === 0));

  codes.callback({scanId, values: [WALLET_CONNECT_URI]});
  state.rerender();
  assert.equal(state.find('qr-scan-preview').props.phase, 'completing');
  state.cover();
  await setImmediate();
  assert.equal(state.status, 'scanned');
  assert.deepEqual(native.stops, [scanId]);

  state.cleanup();
  await setImmediate();
  assert.deepEqual(native.stops, [scanId]);
  assert.deepEqual(state.errors, []);
});

test('leaving during completion preserves the success animation until its cover hides the camera', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  await setImmediate();
  const {scanId} = native.starts[0];
  native.listeners
    .find(listener => listener.name === 'codesScanned')
    .callback({scanId, values: [WALLET_CONNECT_URI]});
  state.rerender({leaving: true, active: false});
  assert.equal(state.find('qr-scan-preview').props.phase, 'completing');
  assert.deepEqual(native.stops, []);

  state.cover();
  await setImmediate();
  state.rerender();
  assert.equal(state.find('qr-scan-preview').props.phase, 'scanned');
  assert.deepEqual(native.stops, [scanId]);
  assert.equal(native.starts.length, 1);

  state.cleanup();
  await setImmediate();
  assert.deepEqual(native.stops, [scanId]);
  assert.deepEqual(state.errors, []);
});

test('unmounting during the success animation stops immediately and ignores its late completion', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  await setImmediate();
  const {scanId} = native.starts[0];
  native.listeners
    .find(listener => listener.name === 'codesScanned')
    .callback({
      scanId,
      values: [WALLET_CONNECT_URI],
    });
  assert.equal(state.status, 'completing');

  state.cleanup();
  state.cover();
  await setImmediate();
  assert.deepEqual(native.stops, [scanId]);
  assert.equal(state.status, 'completing');
  assert.deepEqual(state.errors, []);
});

test('the loading state lasts until the native first frame is ready', async () => {
  const ready = deferred();
  resetScanner({startScan: () => ready.promise});
  const state = mount(await loadView());
  await setImmediate();
  assert.equal(state.status, 'starting');

  ready.resolve();
  await setImmediate();
  assert.equal(state.status, 'scanning');
  state.cleanup();
  await setImmediate();
});

test('native reveal waits for the camera frame and the aperture, and cannot run after cleanup', async () => {
  const ready = deferred();
  const native = resetScanner({
    async startScan(options) {
      native.starts.push(options);
      await ready.promise;
    },
  });
  const state = mount(await loadView());
  const reveal = duration =>
    state.find('qr-scan-preview').props.onReveal(duration);
  await setImmediate();
  assert.equal(await reveal(480), false);
  assert.deepEqual(native.animations, []);

  ready.resolve();
  await setImmediate();
  state.rerender();
  assert.deepEqual(native.animations, []);
  assert.equal(await reveal(480), true);
  assert.deepEqual(native.animations, [
    {
      scanId: native.starts[0].scanId,
      fromScale: 0.5,
      toScale: 1,
      duration: 480,
      easing: [0.22, 1, 0.36, 1],
    },
  ]);

  state.cleanup();
  assert.equal(await reveal(480), false);
  await setImmediate();
  assert.equal(native.animations.length, 1);
  assert.deepEqual(state.errors, []);
});

test('header keywords wait for the preview transition, then an error appears without a retry button', async () => {
  const ready = deferred();
  const native = resetScanner({
    async startScan(options) {
      native.starts.push(options);
      await ready.promise;
    },
  });
  const state = mount(await loadView());
  const instructions = () =>
    state.find(node => node.props?.['aria-live'] === 'polite');
  await setImmediate();
  assert.equal(instructions().props['aria-hidden'], true);
  assert.equal(state.find('qr-scan-instructions').props.active, false);

  ready.resolve();
  await setImmediate();
  state.rerender();
  assert.equal(state.find('qr-scan-preview').props.phase, 'scanning');
  assert.equal(instructions().props['aria-hidden'], true);
  assert.equal(instructions().props.$visible, false);

  state.find('qr-scan-preview').props.onSettled('scanning');
  state.rerender();
  assert.equal(state.find('qr-scan-instructions').props.active, true);
  assert.equal(instructions().props['aria-hidden'], true);
  assert.equal(instructions().props.$visible, false);

  native.listeners
    .find(listener => listener.name === 'scanEnded')
    .callback({
      scanId: native.starts[0].scanId,
      reason: 'error',
      message: 'Camera disconnected',
    });
  state.rerender();
  assert.equal(state.find('qr-scan-preview').props.phase, 'idle');
  assert.equal(state.find('qr-scan-instructions').props.active, false);
  assert.equal(instructions().props['aria-hidden'], true);

  state.find('qr-scan-preview').props.onSettled('idle');
  state.rerender();
  assert.equal(instructions().props['aria-hidden'], false);
  assert.match(state.find('p').props.children, /could not scan/i);

  assert.equal(instructions().props.$visible, true);
  assert.equal(state.find('button').props.children, 'Clipboard');
  assert.equal(
    state.find(
      node =>
        node.type === 'button' && /retry|scan again/i.test(node.props.children),
    ),
    undefined,
  );
  await setImmediate();
  assert.equal(state.errors[0].message, 'Camera disconnected');
  assert.equal(state.errors.length, 1);

  state.cleanup();
  await setImmediate();
});

test('a stop failure reports the error without trapping the result in its animation', async () => {
  const error = new Error('Could not close the camera');
  const native = resetScanner({stopScan: async () => Promise.reject(error)});
  const state = mount(await loadView());
  await setImmediate();
  native.listeners
    .find(listener => listener.name === 'codesScanned')
    .callback({
      scanId: native.starts[0].scanId,
      values: [WALLET_CONNECT_URI],
    });
  state.cover();
  await setImmediate();
  assert.equal(state.status, 'scanned');
  assert.deepEqual(state.errors, [error]);
  state.cleanup();
  await setImmediate();
});

async function scanAndStartPairing(state, native) {
  native.listeners
    .find(listener => listener.name === 'codesScanned')
    .callback({
      scanId: native.starts[0].scanId,
      values: ['https://example.com', WALLET_CONNECT_URI],
    });
  state.rerender();
  await setImmediate();
  assert.equal(state.status, 'completing');
  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].uri, WALLET_CONNECT_URI);
  assert.deepEqual(native.stops, []);
}

async function finishPreview(state) {
  state.cover();
  await setImmediate();
  state.rerender();
  state.find('qr-scan-preview').props.onSettled('scanned');
  state.rerender();
  await setImmediate();
  state.rerender();
}

test('pairing starts during camera contraction and a slow proposal routes after the preview finishes without waiting text', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  await setImmediate();
  await scanAndStartPairing(state, native);
  await finishPreview(state);

  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].signal.aborted, false);
  assert.equal(state.status, 'scanned');
  assert.deepEqual(state.routes, []);
  assert.equal(state.find('p').props.children, false);
  assert.equal(state.find('p').props['aria-hidden'], true);
  assert.equal(state.find('button').props.children, 'Clipboard');
  assert.equal(state.find('button').props.disabled, true);
  assert.equal(
    state.find(node => node.props?.inert !== undefined).props.inert,
    true,
  );
  state.connections[0].resolve({id: 42});
  await setImmediate();
  state.rerender();
  assert.deepEqual(state.routes, [{id: 42}]);

  state.rerender({active: false});
  state.rerender({active: true});
  await setImmediate();
  state.rerender();
  await setImmediate();
  state.rerender();
  assert.equal(state.status, 'scanning');
  assert.equal(native.starts.length, 2);
  assert.deepEqual(state.routes, [{id: 42}]);
  state.cleanup();
  await setImmediate();
  assert.deepEqual(state.rejected, []);
});

test('a fast proposal waits for camera cover, native shutdown and the final animation before routing', async () => {
  const closing = deferred();
  const native = resetScanner({
    stopScan: ({scanId}) => {
      native.stops.push(scanId);
      return closing.promise;
    },
  });
  const state = mount(await loadView());
  await setImmediate();
  await scanAndStartPairing(state, native);

  state.connections[0].resolve({id: 42});
  await setImmediate();
  state.rerender();
  assert.deepEqual(state.routes, []);
  assert.deepEqual(native.stops, []);

  state.cover();
  await setImmediate();
  state.rerender();
  assert.deepEqual(native.stops, [native.starts[0].scanId]);
  assert.equal(state.find('qr-scan-preview').props.phase, 'completing');
  assert.deepEqual(state.routes, []);

  closing.resolve();
  await setImmediate();
  state.rerender();
  assert.equal(state.find('qr-scan-preview').props.phase, 'scanned');
  assert.deepEqual(state.routes, []);

  state.find('qr-scan-preview').props.onSettled('scanned');
  state.rerender();
  assert.deepEqual(state.routes, [{id: 42}]);
  assert.equal(state.connections.length, 1);
  state.cleanup();
  await setImmediate();
  assert.deepEqual(state.rejected, []);
});

test('leaving cancels pairing without rejecting a late proposal or routing on return', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  await setImmediate();
  await scanAndStartPairing(state, native);
  await finishPreview(state);

  state.rerender({leaving: true, active: false});
  assert.equal(state.connections[0].signal.aborted, true);
  state.connections[0].resolve({id: 42});
  await setImmediate();
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.rejected, []);

  state.rerender({leaving: false, active: true});
  await setImmediate();
  assert.equal(state.connections.length, 1);
  assert.equal(state.status, 'scanning');
  assert.deepEqual(state.routes, []);
  state.cleanup();
  await setImmediate();
});

for (const departure of ['leave', 'unmount']) {
  test(`${departure} during contraction dismisses a received proposal without rejecting or routing it`, async () => {
    const native = resetScanner();
    const state = mount(await loadView());
    await setImmediate();
    await scanAndStartPairing(state, native);
    state.connections[0].resolve({id: 42});
    await setImmediate();
    state.rerender();
    assert.deepEqual(state.routes, []);
    assert.deepEqual(state.rejected, []);

    if (departure === 'leave') {
      state.rerender({leaving: true, active: false});
    } else {
      state.cleanup();
    }
    await setImmediate();
    assert.equal(state.connections[0].signal.aborted, true);
    assert.deepEqual(state.rejected, []);
    assert.deepEqual(state.routes, []);

    state.cover();
    await setImmediate();
    if (departure === 'leave') state.cleanup();
    await setImmediate();
    assert.deepEqual(state.rejected, []);
    assert.deepEqual(state.routes, []);
    assert.deepEqual(native.stops, [native.starts[0].scanId]);
  });
}

test('a proposal dismissed during contraction cannot reach confirmation after a quick return', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  await setImmediate();
  await scanAndStartPairing(state, native);
  state.connections[0].resolve({id: 42});
  await setImmediate();
  state.rerender();

  state.rerender({leaving: true, active: false});
  state.rerender({leaving: false, active: true});
  state.rerender();
  await setImmediate();
  state.rerender();
  assert.deepEqual(state.rejected, []);
  assert.deepEqual(state.routes, []);
  assert.equal(state.status, 'scanning');
  assert.equal(native.starts.length, 2);
  assert.equal(state.connections.length, 1);

  state.cleanup();
  await setImmediate();
});

test('an early pairing failure waits for camera shutdown and animation before showing the shared error', async () => {
  const closing = deferred();
  const native = resetScanner({
    stopScan: ({scanId}) => {
      native.stops.push(scanId);
      return closing.promise;
    },
  });
  const state = mount(await loadView());
  await setImmediate();
  await scanAndStartPairing(state, native);
  const failure = new Error('Relay unavailable');
  state.connections[0].reject(failure);
  await setImmediate();
  state.rerender();
  assert.equal(state.status, 'completing');
  assert.deepEqual(state.errors, []);
  assert.deepEqual(native.stops, []);

  state.cover();
  await setImmediate();
  state.rerender();
  assert.equal(state.status, 'completing');
  assert.deepEqual(state.errors, []);
  closing.resolve();
  await setImmediate();
  state.rerender();
  assert.equal(state.status, 'scanned');
  assert.deepEqual(state.errors, []);

  state.find('qr-scan-preview').props.onSettled('scanned');
  state.rerender();
  await setImmediate();
  state.rerender();
  assert.equal(state.status, 'error');
  assert.deepEqual(state.errors, [failure]);
  assert.deepEqual(state.routes, []);
  assert.deepEqual(native.stops, [native.starts[0].scanId]);
  state.cleanup();
  await setImmediate();
});

test('a late pairing failure displays the shared error and permits a new Scan view', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  const failure = new Error('Relay unavailable');
  await setImmediate();
  await scanAndStartPairing(state, native);
  await finishPreview(state);
  state.connections[0].reject(failure);
  await setImmediate();
  state.rerender();
  await setImmediate();
  state.rerender();

  assert.equal(state.status, 'error');
  assert.deepEqual(state.errors, [failure]);
  assert.deepEqual(state.routes, []);
  assert.equal(state.find('button').props.children, 'Clipboard');
  assert.equal(
    state.find(
      node =>
        node.type === 'button' && /retry|scan again/i.test(node.props.children),
    ),
    undefined,
  );
  state.cleanup();
  const retry = mount(await loadView());
  await setImmediate();
  assert.equal(native.starts.length, 2);
  assert.equal(retry.status, 'scanning');
  retry.cleanup();
  await setImmediate();
});
