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
      if (!(index in state.values)) state.values[index] = initial;
      return [
        state.values[index],
        value => {
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
  const promise = new Promise(done => {
    resolve = done;
  });
  return {promise, resolve};
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
    values: [],
    refs: [],
    effects: [],
    errors: [],
    connections: [],
    routes: [],
    rejected: [],
    view: {$leaving: false, $match: {$exact: {$active: true}}},
  };
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
    assert.equal(state.values[0], 'paused');
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
  assert.equal(state.values[0], 'scanning');
  assert.deepEqual(native.stops, []);
  assert.deepEqual(state.errors, []);

  codes.callback({scanId, values: ['unrelated', WALLET_CONNECT_URI]});
  codes.callback({scanId, values: [WALLET_CONNECT_URI]});
  ended.callback({scanId, reason: 'error', message: 'Late camera error'});
  await setImmediate();
  assert.equal(state.values[0], 'completing');
  assert.deepEqual(native.stops, []);
  state.cover();
  await setImmediate();
  assert.equal(state.values[0], 'scanned');
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
    assert.equal(state.values[0], 'scanning');
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
  assert.equal(state.values[0], 'scanned');
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
  assert.equal(state.values[0], 'completing');

  state.cleanup();
  state.cover();
  await setImmediate();
  assert.deepEqual(native.stops, [scanId]);
  assert.equal(state.values[0], 'completing');
  assert.deepEqual(state.errors, []);
});

test('the loading state lasts until the native first frame is ready', async () => {
  const ready = deferred();
  resetScanner({startScan: () => ready.promise});
  const state = mount(await loadView());
  await setImmediate();
  assert.equal(state.values[0], 'starting');

  ready.resolve();
  await setImmediate();
  assert.equal(state.values[0], 'scanning');
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

test('header keywords wait for the preview transition, then an error is centered without a retry button', async () => {
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
  assert.equal(instructions().props.inert, true);

  state.find('qr-scan-preview').props.onSettled('scanning');
  state.rerender();
  assert.equal(state.find('qr-scan-instructions').props.active, true);
  assert.equal(instructions().props['aria-hidden'], true);
  assert.equal(instructions().props.inert, true);

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

  assert.equal(instructions().props.$centered, true);
  assert.equal(state.find('button'), undefined);
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
  assert.equal(state.values[0], 'scanned');
  assert.deepEqual(state.errors, [error]);
  state.cleanup();
  await setImmediate();
});

async function scanAndFinishFeedback(state, native) {
  native.listeners
    .find(listener => listener.name === 'codesScanned')
    .callback({
      scanId: native.starts[0].scanId,
      values: ['https://example.com', WALLET_CONNECT_URI],
    });
  state.cover();
  await setImmediate();
  state.rerender();
  assert.equal(state.connections.length, 0);
  state.find('qr-scan-preview').props.onSettled('scanned');
  state.rerender();
}

test('pairs after success feedback and passes only the proposal id to the confirmation route', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  await setImmediate();
  await scanAndFinishFeedback(state, native);

  assert.equal(state.connections.length, 1);
  assert.equal(state.connections[0].uri, WALLET_CONNECT_URI);
  assert.equal(state.find('p').props.children, 'Waiting for site…');
  assert.equal(state.find('button'), undefined);
  state.connections[0].resolve({id: 42});
  await setImmediate();
  assert.deepEqual(state.routes, [{id: 42}]);
  state.cleanup();
  await setImmediate();
  assert.deepEqual(state.rejected, []);
});

test('leaving cancels pairing and rejects a proposal delivered at the handoff boundary', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  await setImmediate();
  await scanAndFinishFeedback(state, native);

  state.rerender({leaving: true, active: false});
  assert.equal(state.connections[0].signal.aborted, true);
  state.connections[0].resolve({id: 42});
  await setImmediate();
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.rejected, [42]);

  state.rerender({leaving: false, active: true});
  await setImmediate();
  assert.equal(state.connections.length, 1);
  assert.equal(state.values[0], 'scanning');
  state.cleanup();
  await setImmediate();
});

test('a pairing failure displays the shared error and permits a new Scan view', async () => {
  const native = resetScanner();
  const state = mount(await loadView());
  const failure = new Error('Relay unavailable');
  state.entrances.walletKitService.connect = async () => {
    throw failure;
  };
  await setImmediate();
  await scanAndFinishFeedback(state, native);
  await setImmediate();
  state.rerender();

  assert.equal(state.values[0], 'error');
  assert.deepEqual(state.errors, [failure]);
  assert.deepEqual(state.routes, []);
  assert.equal(state.find('button'), undefined);
  state.cleanup();
  const retry = mount(await loadView());
  await setImmediate();
  assert.equal(native.starts.length, 2);
  assert.equal(retry.values[0], 'scanning');
  retry.cleanup();
  await setImmediate();
});
