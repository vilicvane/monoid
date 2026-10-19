import assert from 'node:assert/strict';
import {after, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

let rendering;
let native;
let application;

mock.module('@capacitor/core', {
  namedExports: {
    Capacitor: {
      getPlatform: () => 'ios',
      isPluginAvailable: () => true,
    },
  },
});
mock.module('@capacitor/app', {
  namedExports: {
    App: {
      getState: async () => ({isActive: application.active}),
      addListener: async (name, callback) => {
        assert.equal(name, 'appStateChange');
        const listener = {
          callback,
          removals: 0,
          async remove() {
            listener.removals++;
          },
        };
        application.listeners.push(listener);
        return listener;
      },
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
      ].map(name => [name, (...args) => native[name](...args)]),
    ),
  },
});
mock.module('react', {
  namedExports: {
    useLayoutEffect: (effect, dependencies) => {
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
        current: initial === null ? state.elements.shift() : initial,
      });
    },
    useState: initial => {
      const state = rendering;
      const index = state.stateIndex++;
      if (initial === 'starting') state.statusIndex = index;
      if (!(index in state.values)) {
        state.values[index] =
          typeof initial === 'function' ? initial() : initial;
      }
      return [
        state.values[index],
        value => {
          if (!state.mounted) return;
          const next =
            typeof value === 'function' ? value(state.values[index]) : value;
          if (!Object.is(next, state.values[index])) {
            state.values[index] = next;
            state.dirty = true;
          }
        },
      ];
    },
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    Fragment: 'fragment',
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
  },
});
mock.module('react-dom', {
  namedExports: {createPortal: children => children},
});
mock.module('styled-components', {
  namedExports: {
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
mock.module('../.bld/app/@components/@ui/centered-popup.js', {
  namedExports: {CenteredPopup: 'popup'},
});
mock.module('../.bld/app/@components/@ui/qr-scan-preview.js', {
  namedExports: {QrScanPreview: 'qr-scan-preview'},
});

const {QrScanPopup} = await import(
  '../.bld/app/@components/@ui/qr-scan-popup.js'
);
const {qrScanLifecycle} = await import('../.bld/app/@lib/qr-scanner.js');
const originalGlobals = Object.fromEntries(
  [
    'document',
    'window',
    'HTMLElement',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
after(() => {
  for (const [name, descriptor] of Object.entries(originalGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
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

class Element {
  parentElement = null;
  children = [];
  style = {
    values: new Map(),
    getPropertyValue(name) {
      return this.values.get(name) ?? '';
    },
    getPropertyPriority() {
      return '';
    },
    setProperty(name, value) {
      this.values.set(name, value);
    },
    removeProperty(name) {
      this.values.delete(name);
    },
  };

  append(...children) {
    for (const child of children) child.parentElement = this;
    this.children.push(...children);
  }

  contains(element) {
    return (
      this === element || this.children.some(child => child.contains(element))
    );
  }

  getBoundingClientRect() {
    return {x: 40, y: 80, left: 40, top: 80, width: 300, height: 300};
  }

  getAnimations() {
    return [];
  }
}

function fixture(t, overrides = {}) {
  const body = new Element();
  const content = new Element();
  const popup = new Element();
  const backdrop = new Element();
  const dialog = new Element();
  const preview = new Element();
  const screen = new Element();
  body.append(content, popup);
  popup.append(backdrop, screen, dialog);
  dialog.append(preview);
  body.style.setProperty('background-color', 'black');
  const visibilityListeners = new Set();
  const frames = new Map();
  let frameId = 0;
  Object.assign(globalThis, {
    HTMLElement: Element,
    window: {innerWidth: 400, innerHeight: 800},
    document: {
      body,
      hidden: false,
      addEventListener(name, callback) {
        assert.equal(name, 'visibilitychange');
        visibilityListeners.add(callback);
      },
      removeEventListener(name, callback) {
        assert.equal(name, 'visibilitychange');
        visibilityListeners.delete(callback);
      },
    },
    requestAnimationFrame(callback) {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
  });
  application = {active: true, listeners: []};
  native = {
    starts: [],
    stops: [],
    animations: [],
    listeners: [],
    permissionRequests: 0,
    checkPermissions: async () => ({camera: 'granted'}),
    async requestPermissions() {
      native.permissionRequests++;
      return {camera: 'granted'};
    },
    async addListener(name, callback) {
      const listener = {
        name,
        callback,
        removals: 0,
        async remove() {
          listener.removals++;
        },
      };
      native.listeners.push(listener);
      return listener;
    },
    async startScan(options) {
      native.starts.push(options);
    },
    async stopScan({scanId}) {
      native.stops.push(scanId);
    },
    async animatePreview(options) {
      native.animations.push(options);
    },
    async updatePreviewBounds() {},
    ...overrides,
  };
  qrScanLifecycle.closing = Promise.resolve();
  const state = {
    mounted: true,
    dirty: false,
    values: [],
    refs: [],
    effects: [],
    elements: [preview, screen],
    errors: [],
    scans: [],
    dismissals: 0,
    get status() {
      return this.values[this.statusIndex];
    },
    entrances: {
      portals: {popup, popupBackdrop: {element: backdrop}},
      errorService: {
        catch: promise => promise.catch(error => state.errors.push(error)),
      },
    },
    render() {
      state.dirty = false;
      state.stateIndex = 0;
      state.refIndex = 0;
      state.effectIndex = 0;
      state.pendingEffects = [];
      rendering = state;
      state.tree = QrScanPopup({
        onScan: value => state.scans.push(value),
        onDismiss: () => state.dismissals++,
      });
      for (const {index, effect, dependencies} of state.pendingEffects) {
        state.effects[index]?.cleanup?.();
        state.effects[index] = {dependencies, cleanup: effect()};
      }
    },
    async flush() {
      await setImmediate();
      while (state.mounted && state.dirty) {
        state.render();
        await setImmediate();
      }
    },
    find(selector) {
      const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (
          typeof selector === 'function'
            ? selector(node)
            : node.type === selector
        )
          return node;
        for (const child of [node.props?.children].flat()) {
          const found = visit(child);
          if (found) return found;
        }
      };
      return visit(state.tree);
    },
    appActive(active) {
      application.active = active;
      for (const listener of application.listeners) {
        if (!listener.removals) listener.callback({isActive: active});
      }
    },
    hidden(hidden) {
      document.hidden = hidden;
      for (const listener of [...visibilityListeners]) listener();
    },
    nativeEvent(name, event) {
      for (const listener of native.listeners) {
        if (listener.name === name && !listener.removals)
          listener.callback(event);
      }
    },
    dismiss() {
      state.find('popup').props.onDismiss();
    },
    cover() {
      state.find('qr-scan-preview').props.onCovered();
    },
    cleanup() {
      if (!state.mounted) return;
      state.mounted = false;
      for (const {cleanup} of state.effects) cleanup?.();
    },
  };
  state.render();
  t.after(async () => {
    state.cleanup();
    await setImmediate();
  });
  return {
    state,
    native,
    application,
    body,
    content,
    frames,
    visibilityListeners,
  };
}

test('outside/back dismissal remains available without a Cancel button or processing spinner', async t => {
  const {state, native, body, content} = fixture(t);
  await state.flush();
  assert.equal(state.status, 'scanning');
  assert.equal(
    state.find(
      node => node.type === 'button' && node.props.children === 'Cancel',
    ),
    undefined,
  );
  assert.equal(
    state.find('qr-scan-preview').props.showProcessingSpinner,
    false,
  );
  assert.equal(content.style.getPropertyValue('visibility'), 'hidden');

  state.find('qr-scan-preview').props.onSettled('scanning');
  await state.flush();
  assert.ok(
    state.find(node => node.props['aria-label'] === 'Camera preview active'),
  );
  state.dismiss();
  await state.flush();
  assert.equal(state.status, 'completing');
  assert.equal(
    state.find('qr-scan-preview').props.showProcessingSpinner,
    false,
  );
  assert.equal(state.dismissals, 0);
  assert.equal(native.stops.length, 0);

  state.cover();
  await state.flush();
  assert.equal(state.dismissals, 1);
  assert.equal(native.stops.length, 1);
  assert.equal(content.style.getPropertyValue('visibility'), '');
  assert.equal(body.style.getPropertyValue('background-color'), 'black');
  state.appActive(false);
  state.appActive(true);
  await state.flush();
  assert.equal(native.starts.length, 1);
  assert.deepEqual(state.scans, []);
});

test('foreground recovery waits for camera cleanup and creates only one fresh scan', async t => {
  const stopped = deferred();
  const {state, native, content} = fixture(t, {
    stopScan: ({scanId}) => {
      native.stops.push(scanId);
      return native.stops.length === 1 ? stopped.promise : Promise.resolve();
    },
  });
  await state.flush();
  const firstId = native.starts[0].scanId;
  const staleCodes = native.listeners.find(
    listener => listener.name === 'codesScanned',
  );
  state.hidden(true);
  state.appActive(false);
  await state.flush();
  assert.equal(state.status, 'paused');
  state.hidden(false);
  state.appActive(true);
  state.appActive(true);
  await state.flush();
  assert.equal(native.starts.length, 1);

  stopped.resolve();
  await state.flush();
  assert.equal(native.starts.length, 2);
  assert.notEqual(native.starts[1].scanId, firstId);
  assert.equal(native.permissionRequests, 1);
  assert.equal(state.status, 'scanning');
  assert.equal(content.style.getPropertyValue('visibility'), 'hidden');
  staleCodes.callback({scanId: firstId, values: ['stale result']});
  state.nativeEvent('scanEnded', {scanId: firstId, reason: 'app-paused'});
  state.appActive(true);
  await state.flush();
  assert.equal(native.starts.length, 2);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.errors, []);
});

test('foreground recovery keeps the native popup preview at full scale after its first frame', async t => {
  const ready = deferred();
  const {state, native} = fixture(t, {
    async startScan(options) {
      native.starts.push(options);
      if (native.starts.length === 2) await ready.promise;
    },
  });
  await state.flush();
  assert.equal(state.find('qr-scan-preview').props.revealMode, 'zoom');
  await state.find('qr-scan-preview').props.onReveal(480);
  assert.equal(native.animations[0].fromScale, 0.5);
  assert.equal(native.animations[0].duration, 480);

  state.appActive(false);
  state.appActive(true);
  await state.flush();
  assert.equal(state.status, 'starting');
  assert.equal(state.find('qr-scan-preview').props.revealMode, 'fade');
  assert.equal(
    state.find('qr-scan-preview').props.showProcessingSpinner,
    false,
  );
  assert.equal(await state.find('qr-scan-preview').props.onReveal(480), false);
  assert.equal(native.animations.length, 1);

  ready.resolve();
  await state.flush();
  assert.equal(state.status, 'scanning');
  await state.find('qr-scan-preview').props.onReveal(480);
  assert.deepEqual(native.animations[1], {
    scanId: native.starts[1].scanId,
    fromScale: 1,
    toScale: 1,
    duration: 0,
    easing: [0.22, 1, 0.36, 1],
  });
  assert.deepEqual(state.errors, []);
});

test('a late native pause recovers after foreground, without retrying twice in that foreground', async t => {
  const {state, native} = fixture(t);
  await state.flush();
  state.appActive(true);
  state.nativeEvent('scanEnded', {
    scanId: native.starts[0].scanId,
    reason: 'app-paused',
  });
  await state.flush();
  assert.equal(native.starts.length, 2);

  state.nativeEvent('scanEnded', {
    scanId: native.starts[1].scanId,
    reason: 'app-paused',
  });
  state.appActive(true);
  await state.flush();
  assert.equal(native.starts.length, 2);
  state.appActive(false);
  state.appActive(true);
  await state.flush();
  assert.equal(native.starts.length, 3);
});

test('permission-sheet inactivity does not pause or restart the first camera attempt', async t => {
  const permissions = deferred();
  const {state, native, application} = fixture(t, {
    checkPermissions: async () => ({camera: 'prompt'}),
    requestPermissions: () => permissions.promise,
  });
  await state.flush();
  assert.equal(application.listeners.length, 1);
  state.appActive(false);
  state.hidden(true);
  state.hidden(false);
  state.appActive(true);
  await state.flush();
  assert.equal(native.starts.length, 0);
  assert.equal(native.stops.length, 0);

  permissions.resolve({camera: 'granted'});
  await state.flush();
  assert.equal(native.starts.length, 1);
  assert.equal(state.status, 'scanning');
  assert.equal(native.stops.length, 0);
});

for (const reason of ['stopped', 'error']) {
  test(`native ${reason} remains terminal across late pause and foreground events`, async t => {
    const {state, native} = fixture(t);
    await state.flush();
    const scanId = native.starts[0].scanId;
    state.nativeEvent('scanEnded', {
      scanId,
      reason,
      code: 'CAMERA_ERROR',
      message: 'Camera failed',
    });
    await state.flush();
    const status = reason === 'stopped' ? 'paused' : 'error';
    assert.equal(state.status, status);
    state.nativeEvent('scanEnded', {scanId, reason: 'app-paused'});
    state.appActive(false);
    state.appActive(true);
    await state.flush();
    assert.equal(state.status, status);
    assert.equal(native.starts.length, 1);
    assert.equal(native.permissionRequests, 0);
    assert.deepEqual(state.scans, []);
    assert.equal(state.errors.length, reason === 'error' ? 1 : 0);

    const retry = state.find(
      node =>
        node.type === 'button' &&
        node.props.children === (reason === 'stopped' ? 'Resume' : 'Try again'),
    );
    assert.ok(retry);
    retry.props.onClick();
    await state.flush();
    assert.equal(native.starts.length, 2);
    assert.equal(state.status, 'scanning');
  });
}

test('a native failure cancels an accepted result without a later pause overwriting the error', async t => {
  const {state, native} = fixture(t);
  await state.flush();
  const scanId = native.starts[0].scanId;
  state.nativeEvent('codesScanned', {scanId, values: ['bitcoin:recipient']});
  await state.flush();
  assert.equal(state.status, 'completing');
  state.nativeEvent('scanEnded', {
    scanId,
    reason: 'error',
    code: 'CAMERA_ERROR',
    message: 'Camera failed',
  });
  state.nativeEvent('scanEnded', {scanId, reason: 'app-paused'});
  state.appActive(false);
  state.appActive(true);
  state.cover();
  await state.flush();
  assert.equal(state.status, 'error');
  assert.equal(native.starts.length, 1);
  assert.deepEqual(state.scans, []);
  assert.equal(state.errors.length, 1);
});

test('a preview SCAN_CLOSED waits for the native pause reason before recovering', async t => {
  const update = deferred();
  let updates = 0;
  const {state, native} = fixture(t, {
    updatePreviewBounds: () =>
      ++updates === 1 ? update.promise : Promise.resolve(),
  });
  await state.flush();
  const scanId = native.starts[0].scanId;
  update.reject(
    Object.assign(new Error('Preview is closed'), {code: 'SCAN_CLOSED'}),
  );
  await state.flush();
  assert.deepEqual(state.errors, []);
  state.nativeEvent('codesScanned', {scanId, values: ['stale result']});
  state.nativeEvent('scanEnded', {scanId, reason: 'app-paused'});
  await state.flush();
  assert.equal(native.starts.length, 2);
  assert.equal(state.status, 'scanning');
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.errors, []);
});

for (const code of ['CANCELLED', 'APP_INACTIVE']) {
  test(`${code} during startup can recover when foreground readiness returns`, async t => {
    const {state, native} = fixture(t, {
      async startScan(options) {
        native.starts.push(options);
        if (native.starts.length === 1)
          throw Object.assign(new Error(code), {code});
      },
    });
    await state.flush();
    assert.equal(native.starts.length, 2);
    assert.equal(native.permissionRequests, 1);
    assert.equal(state.status, 'scanning');
    assert.deepEqual(state.errors, []);
  });
}

test('dismissal cancels pending foreground recovery while native cleanup finishes', async t => {
  const stopped = deferred();
  const {state, native} = fixture(t, {stopScan: () => stopped.promise});
  await state.flush();
  state.appActive(false);
  await state.flush();
  state.dismiss();
  state.appActive(true);
  stopped.resolve();
  await state.flush();
  assert.equal(state.dismissals, 1);
  assert.equal(native.starts.length, 1);
  assert.equal(
    state.find('qr-scan-preview').props.showProcessingSpinner,
    false,
  );
});

test('an accepted result cannot restart or reach the form after an interruption', async t => {
  const {state, native} = fixture(t);
  await state.flush();
  state.nativeEvent('codesScanned', {
    scanId: native.starts[0].scanId,
    values: ['bitcoin:recipient'],
  });
  await state.flush();
  assert.equal(state.status, 'completing');
  assert.equal(
    state.find('qr-scan-preview').props.showProcessingSpinner,
    false,
  );
  state.appActive(false);
  await state.flush();
  assert.equal(state.status, 'paused');
  assert.ok(
    state.find(
      node => node.type === 'button' && node.props.children === 'Resume',
    ),
  );
  state.appActive(true);
  state.cover();
  await state.flush();
  assert.equal(native.starts.length, 1);
  assert.deepEqual(state.scans, []);
  state.dismiss();
  await state.flush();
  assert.equal(state.dismissals, 1);
});

test('successful scanning waits for the cover and delivers its result once without a spinner', async t => {
  const {state, native} = fixture(t);
  await state.flush();
  state.nativeEvent('codesScanned', {
    scanId: native.starts[0].scanId,
    values: ['bitcoin:recipient'],
  });
  await state.flush();
  assert.deepEqual(state.scans, []);
  assert.equal(
    state.find('qr-scan-preview').props.showProcessingSpinner,
    false,
  );
  state.cover();
  state.cover();
  await state.flush();
  assert.deepEqual(state.scans, ['bitcoin:recipient']);
  assert.equal(native.stops.length, 1);
  state.appActive(false);
  state.appActive(true);
  await state.flush();
  assert.equal(native.starts.length, 1);
});

test('failed native cleanup never opens another camera on foreground', async t => {
  const failure = new Error('Camera cleanup failed');
  let stops = 0;
  const {state, native} = fixture(t, {
    async stopScan() {
      if (++stops === 1) throw failure;
    },
  });
  await state.flush();
  state.appActive(false);
  await state.flush();
  state.appActive(true);
  await state.flush();
  assert.equal(native.starts.length, 1);
  assert.deepEqual(state.errors, [failure]);
});

test('unmount cancels recovery and removes app, visibility and scanner listeners', async t => {
  const stopped = deferred();
  const {state, native, application, frames, visibilityListeners} = fixture(t, {
    stopScan: () => stopped.promise,
  });
  await state.flush();
  state.appActive(false);
  state.cleanup();
  state.appActive(true);
  stopped.resolve();
  await state.flush();
  assert.equal(native.starts.length, 1);
  assert.equal(frames.size, 0);
  assert.equal(visibilityListeners.size, 0);
  assert.ok(application.listeners.every(listener => listener.removals === 1));
  assert.ok(native.listeners.every(listener => listener.removals === 1));
  assert.deepEqual(state.errors, []);
});

test('a scanner listener that registers after unmount is removed without opening a camera', async t => {
  const registration = deferred();
  let removals = 0;
  const {state, native} = fixture(t, {addListener: () => registration.promise});
  await state.flush();
  state.cleanup();
  registration.resolve({
    async remove() {
      removals++;
    },
  });
  await state.flush();
  assert.equal(removals, 1);
  assert.equal(native.starts.length, 0);
});
