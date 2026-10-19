import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';

import {MonoidCardError} from '../.bld/app/@lib/monoid/card-error.js';

let fixture;
let rendering;
const owners = [];
const sameDependencies = (left, right) =>
  left?.length === right?.length &&
  left.every((value, index) => Object.is(value, right[index]));

mock.module('react', {
  namedExports: {
    useMemo(create, dependencies) {
      const slot = rendering.slot(() => ({}));
      if (!sameDependencies(slot.dependencies, dependencies)) {
        slot.dependencies = dependencies;
        slot.value = create();
      }
      return slot.value;
    },
    useRef(initial) {
      return rendering.slot(() => ({current: initial}));
    },
    useState(initial) {
      const owner = rendering;
      const slot = owner.slot(() => ({
        value: typeof initial === 'function' ? initial() : initial,
      }));
      return [
        slot.value,
        value => {
          const next = typeof value === 'function' ? value(slot.value) : value;
          if (Object.is(next, slot.value)) return;
          slot.value = next;
          owner.dirty = true;
        },
      ];
    },
    useEffect(effect, dependencies) {
      const slot = rendering.slot(() => ({}));
      if (sameDependencies(slot.dependencies, dependencies)) return;
      rendering.effects.push(() => {
        slot.cleanup?.();
        slot.dependencies = dependencies;
        slot.cleanup = effect();
      });
    },
  },
});
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('mobx', {
  namedExports: {
    reaction(expression, effect) {
      const owner = fixture;
      let current = expression();
      const update = () => {
        const next = expression();
        if (Object.is(next, current)) return;
        current = next;
        effect(next);
      };
      owner.reactions.add(update);
      return () => owner.reactions.delete(update);
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
mock.module('lucide-react', {
  namedExports: {Info: 'info'},
});
mock.module('../.bld/app/@components/@ui/app-icon.js', {
  namedExports: {AppIcon: 'icon'},
});
mock.module('../.bld/app/@components/@ui/details-popup.js', {
  namedExports: {
    DetailsPopup: 'details-popup',
    DetailsPopupTitle: 'details-title',
    DetailsPopupDivider: 'details-divider',
  },
});
mock.module('../.bld/app/@components/@ui/operation-complete.js', {
  namedExports: {OperationComplete: 'operation-complete'},
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
      fixture.scans.push(callback);
      fixture.scanCallback = callback;
      fixture.scanController = new AbortController();
      return fixture.scanFinished.promise;
    },
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {MonoidScanStatePromptContentHighlight: 'highlight'},
});
mock.module('../.bld/app/@components/@ui/button.js', {
  namedExports: {Button: 'button'},
});
mock.module('../.bld/app/@components/@ui/info-section.js', {
  namedExports: {
    InfoPanel: 'panel',
    InfoSection: 'section',
    InfoSectionTitle: 'h2',
    InfoSectionItemLabel: 'label',
  },
});
mock.module('../.bld/app/@lib/global-platform/card-information.js', {
  namedExports: {
    async readCardInformation(sessionId) {
      fixture.reads.push(sessionId);
      return fixture.onRead ? fixture.onRead() : fixture.cardInformation;
    },
  },
});
mock.module(
  '../.bld/app/@components/views/safe/@card/card-setup-information.js',
  {
    namedExports: {CardSetupInformation: 'card-information'},
  },
);
mock.module(
  '../.bld/app/@components/views/safe/@card/card-information-details.js',
  {
    namedExports: {CardInformationDetails: 'card-information-details'},
  },
);
mock.module('../.bld/app/@components/views/safe/@card/card-setup-pin.js', {
  namedExports: {CardSetupPIN: 'card-setup-pin'},
});
const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {
    View: 'view',
    ViewContent: 'content',
    ViewHeader: 'header',
    ViewHeaderButton: 'header-button',
    ViewHeaderTitle: 'h1',
    useViewActive,
  },
});

const {APPLET_NAMES, describeAppletInstallProgress} = await import(
  '../.bld/app/@lib/monoid/applet-install-progress.js'
);

test('upload percentage reaches 100 only after the final block is acknowledged', () => {
  assert.equal(
    describeAppletInstallProgress({
      stage: 'monoid',
      phase: 'uploading',
      progress: 299 / 300,
    }).percentage,
    99,
  );
  assert.equal(
    describeAppletInstallProgress({
      stage: 'monoid',
      phase: 'uploading',
      progress: 1,
    }).percentage,
    100,
  );
});
const install = async (sessionId, onProgress, signal) => {
  fixture.installs.push(sessionId);
  fixture.installSignals.push(signal);
  fixture.onProgress = onProgress;
  onProgress({stage: 'checking'});
  return fixture.hello;
};
const pendingBundle = mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    MonoidCardError,
    APPLET_NAMES,
    describeAppletInstallProgress,
    hasAppletBundle: false,
    installMonoidApplets: install,
  },
});
const {SetupCardView: PendingSetupView} = await import(
  '../.bld/app/@components/views/safe/@card/setup-card-view.js?pending'
);
pendingBundle.restore();
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    MonoidCardError,
    APPLET_NAMES,
    describeAppletInstallProgress,
    hasAppletBundle: true,
    installMonoidApplets: install,
  },
});
const {SetupCardView} = await import(
  '../.bld/app/@components/views/safe/@card/setup-card-view.js?ready'
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

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.type === 'function') return textOf(node.type(node.props));
  if (node.type === 'br') return '\n';
  return textOf(node.props?.children);
}

const CARD_INFORMATION = {
  cardManagerAid: 'a000000151000000',
  secureChannels: ['SCP03'],
  cplc: {
    icFabricator: '4790',
    icType: '1234',
    icSerialNumber: '01020304',
    operatingSystemId: '0001',
    operatingSystemReleaseDate: '2345',
    operatingSystemReleaseLevel: '0002',
  },
};

function initializedHello(hello) {
  return {
    ...hello,
    pins: {access: 5, safe: 5},
  };
}

function mount(Component = SetupCardView, viewOptions = {}) {
  const state = {
    slots: [],
    reactions: new Set(),
    index: 0,
    errors: [],
    installs: [],
    installSignals: [],
    reads: [],
    scans: [],
    routes: [],
    copyFlowLookups: [],
    copyAddAttempts: [],
    copyAdditions: [],
    backAvailable: true,
    backToCopyAvailable: false,
    backToLookups: [],
    promptContents: [],
    cardInformation: structuredClone(CARD_INFORMATION),
    scanFinished: deferred(),
    hello: {
      id: new Uint8Array([1, 2, 3, 4]),
      publicKey: new Uint8Array([4, ...new Uint8Array(64).fill(5)]),
      bundle: false,
      pins: {access: 5, safe: 5},
    },
    view: {
      $leaving: false,
      $match: {$exact: {$active: true}},
      cardInformation: CARD_INFORMATION,
      ...viewOptions,
    },
    slot(create) {
      return (this.slots[this.index++] ??= create());
    },
    render() {
      fixture = state;
      let passes = 0;
      do {
        assert.ok(++passes < 20, 'Hook rerender loop');
        state.dirty = false;
        state.reactions.forEach(update => update());
        state.effects = [];
        rendering = state;
        state.index = 0;
        state.tree = Component({view: state.view});
        rendering = undefined;
        state.effects.forEach(effect => effect());
      } while (state.dirty);
      return state.tree;
    },
    click() {
      return find(
        state.render(),
        node => node.type === 'button',
      ).props.onClick();
    },
    async connect() {
      try {
        await state.scanCallback(
          'native-session',
          content => state.promptContents.push(content),
          state.scanController.signal,
        );
      } catch (error) {
        state.scanFinished.reject(error);
        throw error;
      }
    },
    unmount() {
      state.slots.splice(0).forEach(slot => slot.cleanup?.());
    },
  };
  const copyFlows = new Map(
    ['source-copy', 'other-copy'].map(copyId => [
      copyId,
      {
        session: {
          async addTarget(hello) {
            assert.notEqual(hello.pins.access, false);
            assert.notEqual(hello.pins.safe, false);
            assert.notEqual(hello.pins.access, 0);
            assert.notEqual(hello.pins.safe, 0);
            state.copyAddAttempts.push({copyId, hello});
            if (state.copyAddFailure) throw state.copyAddFailure;
            await state.copyAddPending?.promise;
            state.copyAdditions.push({copyId, hello});
          },
        },
      },
    ]),
  );
  state.view.$match.$view = () => ({$entries: [state.view]});
  state.entrances = {
    copyItemsStore: {
      get(copyId) {
        state.copyFlowLookups.push(copyId);
        return copyFlows.get(copyId);
      },
    },
    router: {
      $backTo: target => {
        state.backToLookups.push(target);
        if (target === state.entrances.router.safe.copyItems.$exact) {
          return state.backToCopyAvailable
            ? () => state.routes.push({type: 'back-to-copy'})
            : undefined;
        }
        assert.equal(target, state.entrances.router.safe.$exact);
        return state.backAvailable
          ? () => state.routes.push({type: 'back-to-safe'})
          : undefined;
      },
      safe: {
        $exact: {},
        copyItems: {$exact: {}},
        scanCard: {$replace: () => state.routes.push({type: 'scan'})},
      },
    },
    errorService: {
      catch:
        callback =>
        (...args) => {
          state.finished = callback(...args).catch(error =>
            state.errors.push(error),
          );
          return state.finished;
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

test('missing approved bundle disables installation and blocks a forced handler call', async () => {
  const state = mount(PendingSetupView);
  assert.equal(
    find(state.tree, node => node.type === 'button').props.disabled,
    true,
  );
  assert.ok(
    find(state.tree, node => node === 'Applet package not available yet'),
  );

  await state.click();

  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.installs, []);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.routes, []);
});

test('route card information is displayed immediately without another read or installation steps', () => {
  const state = mount();
  assert.equal(
    find(state.tree, node => node.type === 'card-information').props
      .information,
    CARD_INFORMATION,
  );
  assert.equal(
    find(state.tree, node => node.type === 'button').props.children,
    'Install applets',
  );
  assert.equal(
    find(state.tree, node => node.type === 'button').props.disabled,
    false,
  );
  assert.equal(
    find(state.tree, node => node.type === 'steps' || node.type === 'step'),
    undefined,
  );
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.installs, []);
});

test('installation is available without manually confirming the Java Card version', async () => {
  const state = mount();
  assert.equal(
    find(state.tree, node => node.type === 'button').props.disabled,
    false,
  );

  state.click();
  assert.equal(state.scans.length, 1);
  await state.connect();
  state.scanFinished.resolve();
  await state.finished;
  assert.deepEqual(state.installs, ['native-session']);
});

test('the Setup header opens card details for the currently displayed information', () => {
  const state = mount();
  const header = find(state.tree, node => node.type === 'header');
  const button = find(header, node => node.type === 'header-button');

  assert.ok(button);
  assert.equal(button.props['aria-label'], 'Card information');
  assert.equal(button.props['aria-haspopup'], 'dialog');
  assert.equal(button.props['aria-expanded'], false);
  assert.equal(find(button, node => node.type === 'icon').props.icon, 'info');
  assert.equal(
    find(state.tree, node => node.type === 'details-popup'),
    undefined,
  );

  button.props.onClick();
  state.render();
  const popup = find(state.tree, node => node.type === 'details-popup');
  assert.equal(popup.props['aria-label'], 'Card information');
  assert.equal(
    find(popup, node => node.type === 'details-title').props.children,
    'Card information',
  );
  assert.ok(find(popup, node => node.type === 'details-divider'));
  assert.equal(
    find(popup, node => node.type === 'card-information-details').props
      .information,
    CARD_INFORMATION,
  );
  assert.equal(
    find(state.tree, node => node.type === 'header-button').props[
      'aria-expanded'
    ],
    true,
  );

  popup.props.onDismiss();
  assert.equal(
    find(state.render(), node => node.type === 'details-popup'),
    undefined,
  );
  assert.deepEqual(state.scans, []);
});

test('direct Setup entry reads and displays information before enabling a separate installation scan', async () => {
  const state = mount(SetupCardView, {cardInformation: undefined});
  assert.equal(
    find(state.tree, node => node.type === 'button').props.children,
    'Read card',
  );
  assert.equal(
    find(state.tree, node => node.type === 'button').props.disabled,
    false,
  );
  assert.equal(
    find(state.tree, node => node.type === 'header-button'),
    undefined,
  );
  state.click();
  await state.connect();
  assert.deepEqual(state.reads, ['native-session']);
  assert.deepEqual(state.installs, []);
  assert.equal(
    find(state.render(), node => node.type === 'card-information'),
    undefined,
  );
  state.scanFinished.resolve();
  await state.finished;

  assert.equal(
    find(state.render(), node => node.type === 'card-information').props
      .information,
    state.cardInformation,
  );
  assert.equal(
    find(state.tree, node => node.type === 'button').props.children,
    'Install applets',
  );
  assert.deepEqual(state.routes, []);

  assert.equal(
    find(state.tree, node => node.type === 'button').props.disabled,
    false,
  );
  find(state.tree, node => node.type === 'header-button').props.onClick();
  assert.equal(
    find(state.render(), node => node.type === 'card-information-details').props
      .information,
    state.cardInformation,
  );
  find(state.tree, node => node.type === 'details-popup').props.onDismiss();
  state.scanFinished = deferred();
  state.click();
  await state.connect();
  assert.deepEqual(state.reads, ['native-session', 'native-session']);
  assert.deepEqual(state.installs, ['native-session']);
  assert.deepEqual(state.installSignals, [state.scanController.signal]);
  state.scanFinished.resolve();
  await state.finished;
  assert.deepEqual(state.routes, []);
  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
});

test('card information can be read when the installation package is unavailable', async () => {
  const state = mount(PendingSetupView, {cardInformation: undefined});
  assert.equal(
    find(state.tree, node => node.type === 'button').props.disabled,
    false,
  );
  state.click();
  await state.connect();
  state.scanFinished.resolve();
  await state.finished;

  assert.equal(
    find(state.render(), node => node.type === 'button').props.disabled,
    true,
  );
  assert.equal(
    find(state.tree, node => node.type === 'card-information').props
      .information,
    state.cardInformation,
  );
  assert.deepEqual(state.installs, []);
  assert.deepEqual(state.routes, []);
});

test('installation waits for a fresh identity read before sending installation commands', async () => {
  const state = mount();
  const reading = deferred();
  state.onRead = () => reading.promise;
  state.click();
  const connecting = state.connect();

  assert.deepEqual(state.reads, ['native-session']);
  assert.deepEqual(state.installs, []);
  assert.deepEqual(state.routes, []);
  assert.equal(
    state.promptContents.at(-1),
    'Reading card information, hold tight...',
  );

  reading.resolve(state.cardInformation);
  await connecting;
  assert.deepEqual(state.installs, ['native-session']);
  assert.deepEqual(state.routes, []);
  state.scanFinished.resolve();
  await state.finished;
  assert.deepEqual(state.routes, []);
  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
});

test('cancelling an in-flight identity read prevents late installation and permits explicit retry', async () => {
  const state = mount();
  const reading = deferred();
  state.onRead = () => reading.promise;
  state.click();
  const connecting = state.connect();
  const cancellation = Object.assign(new Error('Card scanning was cancelled'), {
    code: 'CANCELLED',
  });
  state.scanController.abort(cancellation);
  state.scanFinished.reject(cancellation);
  await state.finished;
  reading.resolve(state.cardInformation);
  await assert.rejects(connecting, error => error === cancellation);

  assert.deepEqual(state.installs, []);
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.errors, []);
  assert.equal(
    find(state.render(), node => node.type === 'button').props.children,
    'Try again',
  );

  state.onRead = undefined;
  state.scanFinished = deferred();
  state.click();
  await state.connect();
  state.scanFinished.resolve();
  await state.finished;
  assert.deepEqual(state.installs, ['native-session']);
  assert.equal(state.installSignals[0], state.scanController.signal);
  assert.equal(state.installSignals[0].aborted, false);
  assert.deepEqual(state.routes, []);
  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
});

for (const difference of [
  'icFabricator',
  'icType',
  'icSerialNumber',
  'missing CPLC',
]) {
  test(`a different card (${difference}) is rejected before any installation command`, async () => {
    const state = mount();
    if (difference === 'missing CPLC') delete state.cardInformation.cplc;
    else state.cardInformation.cplc[difference] = 'ffff';
    state.click();
    await assert.rejects(state.connect(), /Wrong card/);
    await state.finished;

    assert.deepEqual(state.reads, ['native-session']);
    assert.deepEqual(state.installs, []);
    assert.deepEqual(state.routes, []);
    assert.equal(state.errors.length, 1);
    assert.equal(state.errors[0].message, 'Wrong card');
    assert.ok(state.errors[0] instanceof MonoidCardError);
    assert.equal(
      find(state.render(), node => node.type === 'button').props.children,
      'Try again',
    );
  });
}

test('failed identity read never starts installation or navigates', async () => {
  const state = mount();
  const failure = new Error('Could not read card');
  state.onRead = () => {
    throw failure;
  };
  state.click();
  await assert.rejects(state.connect(), error => error === failure);
  await state.finished;

  assert.deepEqual(state.errors, [failure]);
  assert.deepEqual(state.installs, []);
  assert.deepEqual(state.routes, []);
});

test('rapid duplicate clicks start one scan and keep the first operation active', async () => {
  const state = mount();
  const click = find(state.tree, node => node.type === 'button').props.onClick;
  const first = click();
  await click();

  assert.equal(state.scans.length, 1);
  assert.equal(
    find(state.render(), node => node.type === 'button').props.loading,
    true,
  );

  await state.connect();
  state.scanFinished.resolve();
  await first;

  assert.deepEqual(state.installs, ['native-session']);
  assert.deepEqual(state.routes, []);
  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
  assert.deepEqual(state.errors, []);
});

for (const [stage, name] of [
  ['identity', 'Monoid Identity Applet'],
  ['monoid', 'Monoid Applet'],
]) {
  test(`${name} shows progress only in the scan prompt and clears the percentage while configuring`, async () => {
    const state = mount();
    state.click();
    await state.connect();

    for (const progress of [0.4, 1]) {
      state.onProgress({stage, phase: 'uploading', progress});
      assert.equal(
        textOf(state.promptContents.at(-1)),
        `Uploading ${name}...\n${progress * 100}%`,
      );
      const content = state.promptContents.at(-1);
      assert.equal(
        textOf(
          find(content.type(content.props), node => node.type === 'highlight'),
        ),
        `${progress * 100}%`,
      );
      state.render();
      assert.equal(
        find(state.tree, node => node.type === 'step' || node.type === 'steps'),
        undefined,
      );
      assert.equal(textOf(state.tree).includes('%'), false);
      assert.equal(textOf(state.tree).includes('Uploading'), false);
    }

    state.onProgress({stage, phase: 'configuring'});
    assert.equal(
      textOf(state.promptContents.at(-1)),
      `Configuring ${name}, hold tight...`,
    );
    state.render();
    assert.equal(textOf(state.tree).includes('%'), false);
    assert.equal(textOf(state.tree).includes('Configuring'), false);

    state.scanFinished.resolve();
    await state.finished;
  });
}

test('existing applets can complete after checking without showing an upload percentage', async () => {
  const state = mount();
  state.click();
  await state.connect();
  assert.equal(
    textOf(state.promptContents.at(-1)),
    'Checking card, hold tight...',
  );

  for (const [stage, name] of [
    ['identity', 'Monoid Identity Applet'],
    ['monoid', 'Monoid Applet'],
  ]) {
    state.onProgress({stage, phase: 'checking'});
    assert.equal(
      textOf(state.promptContents.at(-1)),
      `Checking ${name}, hold tight...`,
    );
    state.render();
    assert.equal(
      find(state.tree, node => node.type === 'step' || node.type === 'steps'),
      undefined,
    );
    assert.equal(textOf(state.tree).includes('Complete'), false);
  }

  state.onProgress({stage: 'verifying'});
  assert.equal(
    textOf(state.promptContents.at(-1)),
    'Verifying installation, hold tight...',
  );
  assert.equal(textOf(state.promptContents).includes('%'), false);
  assert.equal(textOf(state.promptContents).includes('Uploading'), false);
  assert.equal(textOf(state.promptContents).includes(' installed'), false);

  state.scanFinished.resolve();
  await state.finished;
});

for (const [name, pin, safePIN, setupLabel] of [
  ['initialized card', 5, 5, undefined],
  ['new Safe', false, false, 'Set Safe PIN'],
  ['unset Access PIN', false, 5, 'Set Access PIN'],
]) {
  test(`setup completes after scan exit and required PIN initialization (${name})`, async () => {
    const state = mount();
    state.hello.pins.access = pin;
    state.hello.pins.safe = safePIN;
    find(state.tree, node => node.type === 'header-button').props.onClick();
    state.render();
    assert.ok(find(state.tree, node => node.type === 'details-popup'));
    const installClick = find(state.tree, node => node.type === 'button').props
      .onClick;
    state.click();
    await state.connect();
    assert.deepEqual(state.installs, ['native-session']);
    assert.deepEqual(state.routes, []);
    assert.equal(
      find(state.render(), node => node.type === 'operation-complete'),
      undefined,
    );
    assert.ok(find(state.tree, node => node.type === 'card-information'));
    assert.equal(
      find(state.tree, node => node.type === 'card-setup-pin'),
      undefined,
    );
    assert.equal(
      find(state.tree, node => node.type === 'button').props.children,
      'Install applets',
    );
    state.scanFinished.resolve();
    await state.finished;
    state.render();
    assert.equal(
      find(state.tree, node => node.type === 'details-popup'),
      undefined,
    );
    assert.deepEqual(state.routes, []);
    assert.deepEqual(state.errors, []);
    const pinSetup = find(state.tree, node => node.type === 'card-setup-pin');
    if (setupLabel) {
      assert.ok(pinSetup);
      assert.equal(pinSetup.props.hello, state.hello);
      assert.equal(
        find(state.tree, node => node.type === 'operation-complete'),
        undefined,
      );
      assert.ok(find(state.tree, node => node.type === 'card-information'));
      assert.ok(find(state.tree, node => node.type === 'header-button'));
      assert.equal(
        find(
          state.tree,
          node =>
            node.type === 'button' && node.props.children === 'Back to Safe',
        ),
        undefined,
      );
      assert.deepEqual(state.backToLookups, []);
      assert.ok(
        find(
          state.tree,
          node => node.type === 'button' && node.props.children === setupLabel,
        ),
      );
    } else {
      assert.equal(pinSetup, undefined);
      assert.ok(find(state.tree, node => node.type === 'operation-complete'));
      assert.equal(
        find(state.tree, node => node.type === 'card-information'),
        undefined,
      );
      assert.equal(
        find(state.tree, node => node.type === 'header-button'),
        undefined,
      );
      assert.equal(
        find(
          state.tree,
          node =>
            node.type === 'button' &&
            ['Set Safe PIN', 'Set Access PIN'].includes(node.props.children),
        ),
        undefined,
      );
    }

    await installClick();
    assert.equal(state.scans.length, 1);
    assert.deepEqual(state.installs, ['native-session']);
    if (pinSetup)
      await pinSetup.props.onFinished(true, initializedHello(state.hello));
    state.render();
    assert.ok(find(state.tree, node => node.type === 'operation-complete'));
    assert.equal(
      find(state.tree, node => node.type === 'card-information'),
      undefined,
    );
    assert.equal(
      find(state.tree, node => node.type === 'header-button'),
      undefined,
    );
    assert.equal(
      find(state.tree, node => node.type === 'card-setup-pin'),
      undefined,
    );

    const back = find(
      state.render(),
      node => node.type === 'button' && node.props.children === 'Back to Safe',
    );
    assert.equal(back.props.children, 'Back to Safe');
    assert.equal(back.props.color, 'neutral');
    assert.equal(
      find(back, node => node.type === 'icon'),
      undefined,
    );
    assert.deepEqual(state.backToLookups.slice(-2), [
      state.entrances.router.safe.copyItems.$exact,
      state.entrances.router.safe.$exact,
    ]);
    back.props.onClick();
    assert.deepEqual(state.routes, [{type: 'back-to-safe'}]);
  });
}

for (const safeAvailable of [true, false]) {
  test(`completed setup prioritizes Copy history and waits for a return click (Safe history: ${safeAvailable})`, async () => {
    const state = mount();
    state.backToCopyAvailable = true;
    state.backAvailable = safeAvailable;
    state.hello.pins.safe = false;
    state.click();
    await state.connect();
    state.scanFinished.resolve();
    await state.finished;

    const pinSetup = find(
      state.render(),
      node => node.type === 'card-setup-pin',
    );
    assert.ok(pinSetup);
    assert.deepEqual(state.backToLookups, []);
    assert.deepEqual(state.routes, []);
    assert.equal(
      find(
        state.tree,
        node =>
          node.type === 'button' && node.props.children === 'Back to Copy',
      ),
      undefined,
    );

    await pinSetup.props.onFinished(true, initializedHello(state.hello));
    state.render();
    assert.ok(find(state.tree, node => node.type === 'operation-complete'));
    const back = find(state.tree, node => node.type === 'button');
    assert.equal(back.props.children, 'Back to Copy');
    assert.equal(back.props.color, 'neutral');
    assert.deepEqual(state.backToLookups, [
      state.entrances.router.safe.copyItems.$exact,
    ]);
    assert.deepEqual(state.routes, []);

    back.props.onClick();
    assert.deepEqual(state.routes, [{type: 'back-to-copy'}]);
  });
}

test('PIN completion adds the final initialized card to the originating Copy before showing Complete', async () => {
  const state = mount(SetupCardView, {copyId: 'source-copy'});
  state.backToCopyAvailable = true;
  state.hello.pins.access = false;
  state.hello.pins.safe = false;
  state.click();
  await state.connect();
  state.scanFinished.resolve();
  await state.finished;

  const pinSetup = find(state.render(), node => node.type === 'card-setup-pin');
  assert.ok(pinSetup);
  assert.deepEqual(state.copyAdditions, []);
  assert.deepEqual(state.copyFlowLookups, ['source-copy']);
  const current = initializedHello(state.hello);
  state.copyAddPending = deferred();
  const finishing = pinSetup.props.onFinished(true, current);
  await pinSetup.props.onFinished(true, current);
  assert.equal(state.copyAddAttempts.length, 1);
  assert.equal(
    find(state.render(), node => node.type === 'operation-complete'),
    undefined,
  );
  assert.deepEqual(state.routes, []);
  state.copyAddPending.resolve();
  await finishing;

  assert.deepEqual(state.copyAdditions, [
    {copyId: 'source-copy', hello: current},
  ]);
  assert.equal(state.copyAdditions[0].hello, current);
  assert.notEqual(state.copyAdditions[0].hello, state.hello);
  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
  await pinSetup.props.onFinished(true, current);
  assert.equal(state.copyAddAttempts.length, 1);
  const back = find(state.tree, node => node.type === 'button');
  assert.equal(back.props.children, 'Back to Copy');
  assert.deepEqual(state.routes, []);
  back.props.onClick();
  state.render();
  assert.deepEqual(state.routes, [{type: 'back-to-copy'}]);
  assert.equal(state.copyAdditions.length, 1);
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.errors, []);
});

test('an already initialized installation result is added only to the captured Copy flow', async () => {
  const state = mount(SetupCardView, {copyId: 'source-copy'});
  state.click();
  await state.connect();
  assert.deepEqual(state.copyAdditions, []);
  // The mounted Setup retains its original owner instead of looking up another flow later.
  state.view.copyId = 'other-copy';
  state.scanFinished.resolve();
  await state.finished;

  assert.deepEqual(state.copyFlowLookups, ['source-copy']);
  assert.deepEqual(state.copyAdditions, [
    {copyId: 'source-copy', hello: state.hello},
  ]);
  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
  assert.equal(
    find(state.tree, node => node.type === 'card-setup-pin'),
    undefined,
  );
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.errors, []);
});

test('adding an installed card to Copy can be retried without reinstalling or losing the initialized Hello', async () => {
  const state = mount(SetupCardView, {copyId: 'source-copy'});
  const failure = new Error('Destination could not be added');
  state.copyAddFailure = failure;
  state.click();
  await state.connect();
  state.scanFinished.resolve();
  await state.finished;

  assert.deepEqual(state.errors, [failure]);
  assert.equal(state.copyAddAttempts.length, 1);
  assert.deepEqual(state.copyAdditions, []);
  assert.equal(
    find(state.render(), node => node.type === 'operation-complete'),
    undefined,
  );
  assert.equal(
    find(state.tree, node => node.props?.role === 'status'),
    undefined,
  );
  const retry = find(state.tree, node => node.type === 'button');
  assert.equal(retry.props.children, 'Continue');
  retry.props.onClick();
  const pinSetup = find(state.render(), node => node.type === 'card-setup-pin');
  assert.equal(pinSetup.props.hello, state.hello);

  state.copyAddFailure = undefined;
  await pinSetup.props.onFinished(true, state.hello);
  assert.deepEqual(state.copyAdditions, [
    {copyId: 'source-copy', hello: state.hello},
  ]);
  assert.equal(state.copyAddAttempts.length, 2);
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.installs, ['native-session']);
  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
});

test('a cancelled leaving gesture retains completion when the destination was added during the gesture', async () => {
  const state = mount(SetupCardView, {copyId: 'source-copy'});
  state.copyAddPending = deferred();
  state.click();
  await state.connect();
  state.scanFinished.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.copyAddAttempts.length, 1);
  state.view.$leaving = true;
  state.copyAddPending.resolve();
  await state.finished;

  state.view.$leaving = false;
  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
  assert.deepEqual(state.copyAdditions, [
    {copyId: 'source-copy', hello: state.hello},
  ]);
  assert.deepEqual(state.routes, []);
  state.render();
  assert.equal(state.copyAddAttempts.length, 1);
  assert.equal(state.scans.length, 1);
});

for (const copyId of [undefined, 'missing-copy']) {
  test(`Setup does not alter another Copy flow when its origin is ${copyId ?? 'absent'}`, async () => {
    const state = mount(SetupCardView, {copyId});
    state.click();
    await state.connect();
    state.scanFinished.resolve();
    await state.finished;

    assert.deepEqual(state.copyAdditions, []);
    assert.ok(find(state.render(), node => node.type === 'operation-complete'));
    assert.deepEqual(state.errors, []);
  });
}

for (const result of ['cancelled', 'access-unset', 'missing-hello']) {
  test(`a ${result} PIN result does not add a destination to Copy`, async () => {
    const state = mount(SetupCardView, {copyId: 'source-copy'});
    state.hello.pins.safe = false;
    state.click();
    await state.connect();
    state.scanFinished.resolve();
    await state.finished;

    const pinSetup = find(
      state.render(),
      node => node.type === 'card-setup-pin',
    );
    const current =
      result === 'access-unset'
        ? {
            ...initializedHello(state.hello),
            pins: {access: false, safe: 5},
          }
        : undefined;
    await pinSetup.props.onFinished(result === 'missing-hello', current);
    assert.deepEqual(state.copyAdditions, []);
    assert.equal(
      find(state.render(), node => node.type === 'operation-complete'),
      undefined,
    );
    assert.deepEqual(state.routes, []);
    assert.deepEqual(state.errors, []);
  });
}

for (const destination of ['leaving', 'inactive', 'unmounted']) {
  test(`a late successful PIN result cannot add to Copy after Setup is ${destination}`, async () => {
    const state = mount(SetupCardView, {copyId: 'source-copy'});
    state.hello.pins.safe = false;
    state.click();
    await state.connect();
    state.scanFinished.resolve();
    await state.finished;
    const pinSetup = find(
      state.render(),
      node => node.type === 'card-setup-pin',
    );

    if (destination === 'leaving') state.view.$leaving = true;
    if (destination === 'inactive') state.view.$match.$exact.$active = false;
    if (destination === 'unmounted') state.unmount();
    await pinSetup.props.onFinished(true, initializedHello(state.hello));

    assert.deepEqual(state.copyAdditions, []);
    assert.deepEqual(state.routes, []);
    assert.deepEqual(state.errors, []);
  });
}

test('completed installation hides the return button without Copy or Safe history', async () => {
  const state = mount();
  state.backAvailable = false;
  state.click();
  await state.connect();
  state.scanFinished.resolve();
  await state.finished;

  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
  assert.equal(
    find(state.tree, node => node.type === 'button'),
    undefined,
  );
  assert.equal(
    find(state.tree, node => node.type === 'card-information'),
    undefined,
  );
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.backToLookups.slice(-2), [
    state.entrances.router.safe.copyItems.$exact,
    state.entrances.router.safe.$exact,
  ]);
});

test('a cancelled or unsuccessful PIN flow stays incomplete and can reopen without reinstalling', async () => {
  const state = mount();
  state.hello.pins.access = false;
  state.hello.pins.safe = false;
  state.click();
  await state.connect();
  state.scanFinished.resolve();
  await state.finished;

  const pinSetup = find(state.render(), node => node.type === 'card-setup-pin');
  assert.ok(pinSetup);
  await pinSetup.props.onFinished(false);
  state.render();
  assert.equal(
    find(state.tree, node => node.type === 'card-setup-pin'),
    undefined,
  );
  assert.equal(
    find(state.tree, node => node.type === 'operation-complete'),
    undefined,
  );
  assert.ok(find(state.tree, node => node.type === 'card-information'));
  assert.ok(find(state.tree, node => node.type === 'header-button'));
  assert.equal(
    find(
      state.tree,
      node => node.type === 'button' && node.props.children === 'Back to Safe',
    ),
    undefined,
  );
  const reopen = find(
    state.tree,
    node => node.type === 'button' && node.props.children === 'Set Safe PIN',
  );
  assert.ok(reopen);
  reopen.props.onClick();
  const retried = find(state.render(), node => node.type === 'card-setup-pin');
  assert.ok(retried);
  assert.equal(retried.props.hello, state.hello);
  assert.deepEqual(state.installs, ['native-session']);
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.routes, []);

  await retried.props.onFinished(true, initializedHello(state.hello));
  state.render();
  assert.equal(
    find(state.tree, node => node.type === 'card-setup-pin'),
    undefined,
  );
  assert.equal(
    find(
      state.tree,
      node =>
        node.type === 'button' &&
        ['Set Safe PIN', 'Set Access PIN'].includes(node.props.children),
    ),
    undefined,
  );
  assert.ok(find(state.tree, node => node.type === 'operation-complete'));
  assert.ok(
    find(
      state.tree,
      node => node.type === 'button' && node.props.children === 'Back to Safe',
    ),
  );
  assert.deepEqual(state.installs, ['native-session']);
});

test('a Safe with an unset Access PIN updates the retry entry and reopens with its verified current state', async () => {
  const state = mount();
  state.hello.pins.access = false;
  state.hello.pins.safe = false;
  state.click();
  await state.connect();
  state.scanFinished.resolve();
  await state.finished;

  const pinSetup = find(state.render(), node => node.type === 'card-setup-pin');
  const current = {
    ...state.hello,
    pins: {access: false, safe: 5},
  };
  assert.ok(
    find(
      state.tree,
      node => node.type === 'button' && node.props.children === 'Set Safe PIN',
    ),
  );
  await pinSetup.props.onFinished(false, current);
  state.render();

  assert.equal(
    find(state.tree, node => node.type === 'card-setup-pin'),
    undefined,
  );
  assert.equal(
    find(
      state.tree,
      node => node.type === 'button' && node.props.children === 'Set Safe PIN',
    ),
    undefined,
  );
  const reopen = find(
    state.tree,
    node => node.type === 'button' && node.props.children === 'Set Access PIN',
  );
  assert.ok(reopen);
  assert.equal(
    find(state.tree, node => node.type === 'operation-complete'),
    undefined,
  );
  assert.ok(find(state.tree, node => node.type === 'card-information'));
  assert.ok(find(state.tree, node => node.type === 'header-button'));
  assert.equal(
    find(
      state.tree,
      node => node.type === 'button' && node.props.children === 'Back to Safe',
    ),
    undefined,
  );
  reopen.props.onClick();
  assert.equal(
    find(state.render(), node => node.type === 'card-setup-pin').props.hello,
    current,
  );
  assert.deepEqual(state.installs, ['native-session']);
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.routes, []);
});

test('required PIN setup remains available when there is no Safe history', async () => {
  const state = mount();
  state.backAvailable = false;
  state.hello.pins.safe = false;
  state.click();
  await state.connect();
  state.scanFinished.resolve();
  await state.finished;

  assert.equal(
    find(state.render(), node => node.type === 'operation-complete'),
    undefined,
  );
  assert.ok(find(state.tree, node => node.type === 'card-setup-pin'));
  assert.ok(
    find(
      state.tree,
      node => node.type === 'button' && node.props.children === 'Set Safe PIN',
    ),
  );
  assert.equal(
    find(
      state.tree,
      node => node.type === 'button' && node.props.children === 'Back to Safe',
    ),
    undefined,
  );
  assert.deepEqual(state.routes, []);

  await find(
    state.tree,
    node => node.type === 'card-setup-pin',
  ).props.onFinished(true, initializedHello(state.hello));
  assert.equal(
    find(state.render(), node => node.type === 'button'),
    undefined,
  );
  assert.equal(
    find(state.tree, node => node.type === 'card-setup-pin'),
    undefined,
  );
  assert.ok(find(state.tree, node => node.type === 'operation-complete'));
});

for (const destination of ['leaving', 'inactive']) {
  test(`leaving the pending Setup page (${destination}) closes PIN entry until explicitly reopened`, async () => {
    const state = mount();
    state.hello.pins.safe = false;
    state.click();
    await state.connect();
    state.scanFinished.resolve();
    await state.finished;
    assert.ok(find(state.render(), node => node.type === 'card-setup-pin'));

    if (destination === 'leaving') state.view.$leaving = true;
    else state.view.$match.$exact.$active = false;
    assert.equal(
      find(state.render(), node => node.type === 'card-setup-pin'),
      undefined,
    );

    state.view.$leaving = false;
    state.view.$match.$exact.$active = true;
    assert.equal(
      find(state.render(), node => node.type === 'card-setup-pin'),
      undefined,
    );
    assert.equal(
      find(state.tree, node => node.type === 'operation-complete'),
      undefined,
    );
    assert.equal(
      find(
        state.tree,
        node =>
          node.type === 'button' && node.props.children === 'Back to Safe',
      ),
      undefined,
    );
    const reopen = find(
      state.tree,
      node => node.type === 'button' && node.props.children === 'Set Safe PIN',
    );
    assert.ok(reopen);
    reopen.props.onClick();
    assert.ok(find(state.render(), node => node.type === 'card-setup-pin'));
    assert.deepEqual(state.installs, ['native-session']);
    assert.equal(state.scans.length, 1);
  });
}

test('failed scan cleanup after installation does not start the PIN flow', async () => {
  const state = mount();
  state.hello.pins.safe = false;
  state.click();
  await state.connect();
  const failure = new Error('Native scan cleanup failed');
  state.scanFinished.reject(failure);
  await state.finished;

  assert.equal(
    find(state.render(), node => node.type === 'card-setup-pin'),
    undefined,
  );
  assert.equal(
    find(state.tree, node => node.type === 'operation-complete'),
    undefined,
  );
  assert.deepEqual(state.errors, [failure]);
  assert.deepEqual(state.routes, []);
});

for (const destination of ['unmounted', 'leaving', 'inactive']) {
  test(`an installation cannot start when Setup is ${destination}`, async () => {
    const state = mount();
    const click = find(state.tree, node => node.type === 'button').props
      .onClick;
    if (destination === 'unmounted') state.unmount();
    if (destination === 'leaving') state.view.$leaving = true;
    if (destination === 'inactive') state.view.$match.$exact.$active = false;

    await click();

    assert.deepEqual(state.scans, []);
    assert.deepEqual(state.installs, []);
    assert.deepEqual(state.routes, []);
    assert.deepEqual(state.errors, []);
  });

  test(`completion is ignored when the installation page is ${destination}`, async () => {
    const state = mount();
    state.hello.pins.safe = false;
    state.click();
    await state.connect();
    if (destination === 'unmounted') state.unmount();
    if (destination === 'leaving') state.view.$leaving = true;
    if (destination === 'inactive') state.view.$match.$exact.$active = false;
    state.scanFinished.resolve();
    await state.finished;
    if (destination !== 'unmounted') {
      assert.equal(
        find(state.render(), node => node.type === 'operation-complete'),
        undefined,
      );
      assert.equal(
        find(state.tree, node => node.type === 'card-setup-pin'),
        undefined,
      );
    }
    assert.deepEqual(state.routes, []);
    assert.deepEqual(state.errors, []);
  });

  test(`a pending identity read cannot install or navigate after Setup becomes ${destination}`, async () => {
    const state = mount();
    const reading = deferred();
    state.onRead = () => reading.promise;
    state.click();
    const connecting = state.connect();
    assert.deepEqual(state.reads, ['native-session']);
    if (destination === 'unmounted') state.unmount();
    if (destination === 'leaving') state.view.$leaving = true;
    if (destination === 'inactive') state.view.$match.$exact.$active = false;
    reading.resolve(state.cardInformation);
    await connecting;
    state.scanFinished.resolve();
    await state.finished;

    assert.deepEqual(state.installs, []);
    assert.deepEqual(state.routes, []);
    assert.deepEqual(state.errors, []);
  });
}

test('returning to Setup before scan cleanup cannot complete an installation skipped while inactive', async () => {
  const state = mount();
  const reading = deferred();
  state.onRead = () => reading.promise;
  state.click();
  const connecting = state.connect();

  state.view.$match.$exact.$active = false;
  reading.resolve(state.cardInformation);
  await connecting;
  assert.deepEqual(state.installs, []);

  state.view.$match.$exact.$active = true;
  state.scanFinished.resolve();
  await state.finished;

  assert.equal(
    find(state.render(), node => node.type === 'operation-complete'),
    undefined,
  );
  assert.ok(find(state.tree, node => node.type === 'card-information'));
  assert.equal(
    find(state.tree, node => node.type === 'button').props.children,
    'Install applets',
  );
  assert.deepEqual(state.installs, []);
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.errors, []);
});

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
  assert.equal(button.props.disabled, false);
  assert.equal(
    find(state.tree, node => node.type === 'operation-complete'),
    undefined,
  );
  assert.equal(
    find(state.tree, node => node.props?.role === 'status'),
    undefined,
  );
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.installs, []);

  state.scanFinished = deferred();
  const retry = state.click();
  assert.equal(state.scans.length, 2);
  await state.connect();
  state.scanFinished.resolve();
  await retry;

  assert.deepEqual(state.installs, ['native-session']);
  assert.deepEqual(state.routes, []);
  assert.ok(find(state.render(), node => node.type === 'operation-complete'));
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
  assert.equal(
    find(state.render(), node => node.type === 'operation-complete'),
    undefined,
  );
});
