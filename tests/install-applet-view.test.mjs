import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';

let fixture;
let rendering;
const owners = [];

mock.module('react', {
  namedExports: {
    useRef(initial) {
      return rendering.slot(() => ({current: initial}));
    },
    useState(initial) {
      const slot = rendering.slot(() => ({value: initial}));
      return [slot.value, value => (slot.value = value)];
    },
    useEffect(effect) {
      rendering.slot(() => ({cleanup: effect()}));
    },
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
    Fragment: 'fragment',
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {
    isCredentialRequestCancelled: error => error?.code === 'CANCELLED',
  },
});
mock.module('../.bld/app/@components/@monoid/use-isodep-scan-prompt.js', {
  namedExports: {
    useIsoDepScanPrompt: () => (_initial, callback) => {
      fixture.scanCallback = callback;
      return fixture.scanFinished.promise;
    },
  },
});
mock.module('../.bld/app/@components/@ui/button.js', {
  namedExports: {Button: 'button'},
});
mock.module('../.bld/app/@components/@ui/info-section.js', {
  namedExports: {
    InfoSection: 'section',
    InfoSectionTitle: 'h2',
    InfoSectionItemLabel: 'label',
  },
});
mock.module('../.bld/app/@components/@ui/step.js', {
  namedExports: {Steps: 'steps', Step: 'step'},
});
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {
    View: 'view',
    ViewContent: 'content',
    ViewHeader: 'header',
    ViewHeaderTitle: 'h1',
  },
});

const install = async (sessionId, onProgress) => {
  fixture.installs.push(sessionId);
  onProgress({stage: 'monoid', progress: 0.4});
  return fixture.hello;
};
const pendingBundle = mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {hasAppletBundle: false, installMonoidApplets: install},
});
const {InstallAppletView: PendingInstallView} = await import(
  '../.bld/app/@components/views/safe/@card/install-applet-view.js?pending'
);
pendingBundle.restore();
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {hasAppletBundle: true, installMonoidApplets: install},
});
const {InstallAppletView} = await import(
  '../.bld/app/@components/views/safe/@card/install-applet-view.js?ready'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return {promise, resolve, reject};
}

function find(node, predicate) {
  if (node === null || node === undefined) return;
  if (predicate(node)) return node;
  const children = Array.isArray(node)
    ? node
    : [node.props?.children, node.props?.footer];
  for (const child of children) {
    const result = find(child, predicate);
    if (result) return result;
  }
}

function mount(Component = InstallAppletView) {
  const state = {
    slots: [],
    index: 0,
    errors: [],
    installs: [],
    routes: [],
    scanFinished: deferred(),
    hello: {
      id: new Uint8Array([1, 2, 3, 4]),
      pin: false,
      safe: {
        id: new Uint8Array([5, 6, 7, 8]),
        pin: 5,
        unlocked: false,
      },
    },
    view: {$leaving: false, $match: {$exact: {$active: true}}},
    slot(create) {
      return (this.slots[this.index++] ??= create());
    },
    render() {
      fixture = state;
      rendering = state;
      state.index = 0;
      state.tree = Component({view: state.view});
      rendering = undefined;
      return state.tree;
    },
    click() {
      find(state.render(), node => node.type === 'button').props.onClick();
    },
    connect() {
      return state.scanCallback('native-session', () => {});
    },
    unmount() {
      state.slots.splice(0).forEach(slot => slot.cleanup?.());
    },
  };
  state.entrances = {
    router: {
      safe: {
        setupCard: data => ({
          $replace: () => state.routes.push({type: 'setup', data}),
        }),
        scanCard: {$replace: () => state.routes.push({type: 'scan'})},
      },
    },
    errorService: {
      catch: callback => () => {
        state.finished = callback().catch(error => state.errors.push(error));
      },
    },
  };
  owners.push(state);
  state.render();
  return state;
}

afterEach(() => {
  owners.splice(0).forEach(owner => owner.unmount());
});

test('missing approved bundle disables installation and explains the pending state', () => {
  const state = mount(PendingInstallView);
  assert.equal(
    find(state.tree, node => node.type === 'button').props.disabled,
    true,
  );
  assert.ok(
    find(state.tree, node => node === 'Waiting for the applet package.'),
  );
  assert.deepEqual(state.installs, []);
});

for (const pin of [false, 5]) {
  test(`verified installation returns to card scanning only after scan exit (${pin === false ? 'unset' : 'configured'} Access PIN)`, async () => {
    const state = mount();
    state.hello.pin = pin;
    state.click();
    await state.connect();
    assert.deepEqual(state.installs, ['native-session']);
    assert.deepEqual(state.routes, []);
    state.scanFinished.resolve();
    await state.finished;
    // The ordinary card scan now performs any required Safe setup inline.
    assert.deepEqual(state.routes, [{type: 'scan'}]);
    assert.deepEqual(state.errors, []);
  });
}

for (const destination of ['unmounted', 'leaving', 'inactive']) {
  test(`completion cannot navigate when the installation page is ${destination}`, async () => {
    const state = mount();
    state.click();
    await state.connect();
    if (destination === 'unmounted') state.unmount();
    if (destination === 'leaving') state.view.$leaving = true;
    if (destination === 'inactive') state.view.$match.$exact.$active = false;
    state.scanFinished.resolve();
    await state.finished;
    assert.deepEqual(state.routes, []);
    assert.deepEqual(state.errors, []);
  });
}

test('quiet scan cancellation leaves an interrupted state and permits explicit retry', async () => {
  const state = mount();
  state.click();
  state.scanFinished.reject(
    Object.assign(new Error('Card scanning was cancelled.'), {
      code: 'CANCELLED',
    }),
  );
  await state.finished;
  state.render();
  const button = find(state.tree, node => node.type === 'button');
  assert.equal(button.props.children, 'Try again');
  assert.equal(button.props.loading, false);
  assert.ok(find(state.tree, node => node.props?.role === 'status'));
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.installs, []);
});

test('an installation failure is reported without navigating or auto-retrying', async () => {
  const state = mount();
  state.click();
  const failure = new Error('Card management credentials are not supported.');
  state.scanFinished.reject(failure);
  await state.finished;
  assert.deepEqual(state.errors, [failure]);
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.installs, []);
});
