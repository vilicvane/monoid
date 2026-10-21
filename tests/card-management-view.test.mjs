import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {observable, runInAction} from 'mobx';

import {
  MonoidCardError,
  MonoidWrongCardError,
} from '../.bld/app/@lib/monoid/card-error.js';

let fixture;
let rendering;
const owners = [];
const PIN = 'Secret-42';
const AID = 'f06d6f6e6f69640201';

mock.module('react', {
  namedExports: {
    useState(initial) {
      const slot = rendering.slot(() => ({
        value: typeof initial === 'function' ? initial() : initial,
      }));
      return [
        slot.value,
        value => {
          slot.value = typeof value === 'function' ? value(slot.value) : value;
        },
      ];
    },
    useMemo: create => rendering.slot(() => ({value: create()})).value,
    useRef: initial => rendering.slot(() => ({current: initial})),
    useEffect: effect => rendering.slot(() => ({cleanup: effect()})),
  },
});
mock.module('react/jsx-runtime', {
  namedExports: {
    jsx: (type, props) => ({type, props}),
    jsxs: (type, props) => ({type, props}),
    Fragment: 'fragment',
  },
});
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('lucide-react', {
  namedExports: {Ellipsis: 'ellipsis', Info: 'info'},
});
mock.module('styled-components', {
  namedExports: {
    styled: new Proxy(component => () => component, {
      get: (_target, tag) => () => `styled-${tag}`,
    }),
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {
    cardFingerprint: info => info.cplc.icSerialNumber,
    isCredentialRequestCancelled: error => error?.code === 'CANCELLED',
  },
});
class CardManagerNotFoundError extends Error {}
mock.module('../.bld/app/@lib/global-platform/install.js', {
  namedExports: {CardManagerNotFoundError},
});
mock.module('../.bld/app/@lib/global-platform/card-information.js', {
  namedExports: {
    readCardInformation: async () => {
      fixture.informationReads = (fixture.informationReads ?? 0) + 1;
      if (fixture.informationError) throw fixture.informationError;
      return fixture.information;
    },
  },
});
mock.module('../.bld/app/@lib/global-platform/installation-support.js', {
  namedExports: {getCardInstallationChecks: () => fixture.checks},
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    MonoidCardError,
    MonoidWrongCardError,
    hasAppletBundle: true,
    readMonoidAppletInstallation: async () => {
      fixture.installationReads = (fixture.installationReads ?? 0) + 1;
      return fixture.installation;
    },
    createMonoidApplet: aid => ({
      async openSession() {
        fixture.events.push({type: 'select', aid});
        return fixture.applet;
      },
    }),
    installMonoidApplets: async () => {
      fixture.events.push({type: 'install'});
      if (fixture.installError) throw fixture.installError;
      fixture.installation = installed(fixture.uninitialized);
      return fixture.uninitialized;
    },
    initializeMonoidCard: async (_applet, hello, pin) => {
      fixture.events.push({type: 'initialize', pin});
      assert.equal(hello.id, fixture.uninitialized.id);
      if (fixture.initializeError) throw fixture.initializeError;
      fixture.installation = installed(fixture.initialized);
      return fixture.initialized;
    },
  },
});
mock.module('../.bld/app/@components/@monoid/pin-input-placeholder.js', {
  namedExports: {
    PINKind: 'PINKind',
    getPINInputPlaceholder: (kind, prefix) => ({
      placeholder: `${prefix} ${kind} PIN`,
    }),
  },
});
mock.module('../.bld/app/@components/@monoid/use-isodep-scan-prompt.js', {
  namedExports: {
    useIsoDepScanPrompt: () => (label, callback) => {
      const scan = {label, callback, finished: deferred()};
      fixture.scans.push(scan);
      fixture.events.push({type: 'scan'});
      return scan.finished.promise;
    },
  },
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {
    useInputModal: () => [
      null,
      (options, signal) => {
        const input = {options, signal, finished: deferred()};
        fixture.inputs.push(input);
        fixture.events.push({type: 'input'});
        signal?.addEventListener('abort', () =>
          input.finished.resolve(undefined),
        );
        return input.finished.promise;
      },
    ],
  },
});
mock.module('../.bld/app/@components/@ui/toast.js', {
  namedExports: {useToast: () => options => fixture.toasts.push(options)},
});
const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);
for (const [path, names] of [
  ['@monoid/applet-install-progress', ['AppletInstallProgressContent']],
  ['@monoid/monoid-scan-prompt', ['MonoidScanStatePromptProgress']],
  ['@ui/app-icon', ['AppIcon']],
  ['@ui/button', ['Button']],
  ['@ui/confirm-popup', ['ConfirmPopup']],
  [
    '@ui/details-popup',
    ['DetailsPopup', 'DetailsPopupDivider', 'DetailsPopupTitle'],
  ],
  ['@ui/message-content', ['InfoMessage']],
  ['@ui/operation-complete', ['OperationComplete']],
  ['views/safe/index', ['CardInformationPopup']],
  [
    'views/card/card-management-content',
    ['CardAppletsContent', 'CardInformationContent', 'CardScanPlaceholder'],
  ],
  [
    '@view/index',
    [
      'View',
      'ViewContent',
      'ViewHeader',
      'ViewHeaderButton',
      'ViewHeaderTitle',
    ],
  ],
]) {
  mock.module(`../.bld/app/@components/${path}.js`, {
    namedExports: {
      ...Object.fromEntries(names.map(name => [name, name])),
      ...(path === '@view/index' && {useViewActive}),
    },
  });
}
const {CardManagementView} = await import(
  '../.bld/app/@components/views/card/card-management-view.js'
);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}
function find(node, predicate) {
  if (node === undefined || node === null) return;
  if (predicate(node)) return node;
  for (const child of Array.isArray(node)
    ? node
    : [node.props?.children, node.props?.footer]) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node) return '';
  return (Array.isArray(node) ? node : [node.props?.children])
    .map(text)
    .join('');
}
function hello(initialized = true, bundle = false) {
  return {
    id: Uint8Array.of(1, 2, 3, 4),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(9)),
    version: 1,
    bundle,
    pins: {access: initialized ? 5 : false, secret: initialized ? 5 : false},
  };
}
function installed(hello) {
  return {
    identity: {installed: true, aid: 'f06d6f6e6f69640001'},
    monoid: {installed: true, aid: AID, version: hello.version},
    hello,
  };
}
function mount({returnTo, cardInformation = true, bundle = false} = {}) {
  const state = {
    slots: [],
    index: 0,
    inputs: [],
    scans: [],
    events: [],
    errors: [],
    toasts: [],
    progress: [],
    targets: [],
    backs: [],
    checks: [{supported: true}],
    information: {
      cardManagerAid: 'a000000151000000',
      cplc: {icSerialNumber: '1234'},
    },
    installation: {identity: {installed: false}, monoid: {installed: false}},
    uninitialized: hello(false, bundle),
    initialized: hello(true, bundle),
    slot: create => (state.slots[state.index++] ??= create()),
    render() {
      fixture = rendering = state;
      state.index = 0;
      state.tree = CardManagementView({view: state.view});
      rendering = undefined;
      return state.tree;
    },
    async flush() {
      await setImmediate();
      state.render();
      await setImmediate();
    },
    node(type) {
      return find(state.render(), node => node.type === type);
    },
    click(label) {
      const button = find(
        state.render(),
        node =>
          (node.type === 'Button' || node.type === 'ViewHeaderButton') &&
          (text(node) === label || node.props['aria-label'] === label),
      );
      assert.ok(button, `Expected button ${label}`);
      assert.ok(!button.props.disabled, `Expected enabled button ${label}`);
      button.props.onClick();
    },
    async answer(value = PIN) {
      state.inputs.at(-1).finished.resolve(value);
      await state.flush();
    },
    async tap({finish = true} = {}) {
      const scan = state.scans.at(-1);
      try {
        await scan.callback(
          'session',
          value => state.progress.push(value),
          new AbortController().signal,
        );
        if (finish) scan.finished.resolve();
      } catch (error) {
        scan.error = error;
        scan.finished.reject(error);
      }
      await state.flush();
    },
    unmount() {
      state.slots.splice(0).forEach(slot => slot.cleanup?.());
    },
  };
  state.view = observable({
    $leaving: false,
    $match: {$exact: {$active: true}},
    returnTo,
    copyId: returnTo === 'copy' ? 'copy' : undefined,
    cardInformation: cardInformation ? state.information : undefined,
  });
  state.view.$match.$view = () => ({$entries: [state.view]});
  state.applet = {
    authenticate: async request =>
      state.events.push({type: 'auth', ...request}),
  };
  state.pinSession = {
    authenticate: async () => state.events.push({type: 'vault'}),
    setPIN: async (id, pin) =>
      state.events.push({type: 'save-access', id, pin}),
    clear: () => state.events.push({type: 'clear'}),
  };
  state.maintenance = {
    matchOperation: () => state.pending,
    get: () => state.pending,
    isUpdateAvailable: () => false,
    recordInstallation: async () => {},
    prepare: async (_applet, options) => {
      state.events.push({type: 'prepare', mode: options.mode});
      state.pending = {
        id: 'maintenance',
        mode: options.mode,
        phase: 'ready',
        card: {appletAid: AID, bundle},
      };
      return state.pending;
    },
    prepareFresh: async () => {
      state.events.push({type: 'prepare-fresh'});
      state.pending = {
        id: 'fresh',
        mode: 'fresh',
        phase: 'ready',
        card: {appletAid: AID, bundle: false},
      };
      return state.pending;
    },
    replace: async () => {
      state.events.push({type: 'replace'});
      state.pending.phase =
        state.pending.mode === 'fresh'
          ? 'setup'
          : bundle
            ? 'manual-restore'
            : 'restore';
      state.installation = installed(state.uninitialized);
      return state.uninitialized;
    },
    restore: async () => {
      state.events.push({type: 'restore'});
      state.pending = undefined;
    },
    complete: async () => {
      state.events.push({type: 'complete'});
      state.pending = undefined;
    },
  };
  const safe = {
    $exact: 'safe',
    copyItems: {$exact: 'copy'},
    setupCard: {$exact: 'bundle'},
  };
  state.entrances = {
    router: {
      safe,
      $backTo: route =>
        returnTo === route ? () => state.backs.push(route) : undefined,
    },
    monoidApplet: {openSession: async () => state.applet},
    monoidCredentialsStore: {createPINSession: () => state.pinSession},
    cardMaintenanceService: state.maintenance,
    copyItemsStore: {
      get: () => ({
        session: {addTarget: async target => state.targets.push(target)},
      }),
    },
    cardBundleStore: {acceptInstalledCard: async () => {}},
    cardStore: {
      get: () => undefined,
      forget: identity => state.events.push({type: 'forget', identity}),
    },
    errorService: {
      catch: promise => promise.catch(error => state.errors.push(error)),
    },
  };
  owners.push(state);
  state.render();
  return state;
}
afterEach(() => owners.splice(0).forEach(owner => owner.unmount()));

test('installation asks for Secret PIN before scanning, completes PIN setup, then returns the new card to Copy', async () => {
  const state = mount({returnTo: 'copy'});
  state.click('Install applets');
  assert.equal(state.inputs.length, 1);
  assert.match(state.inputs[0].options.placeholder, /Secret PIN/);
  assert.equal(state.scans.length, 0);
  await state.answer();
  assert.deepEqual(
    state.events.slice(0, 3).map(event => event.type),
    ['input', 'vault', 'scan'],
  );
  await state.tap({finish: false});
  assert.equal(state.informationReads, 1);
  assert.equal(state.installationReads, 2, 'refresh installed applets only');
  assert.equal(
    state.targets.length,
    0,
    'wait for NFC sheet cleanup before adding target',
  );
  assert.equal(state.node('OperationComplete'), undefined);
  assert.equal(state.node('CardAppletsContent'), undefined);
  assert.ok(state.node('CardInformationContent'));
  state.scans[0].finished.resolve();
  await state.flush();
  assert.deepEqual(state.targets, [state.initialized]);
  assert.ok(state.node('OperationComplete'));
  assert.deepEqual(
    state.events.filter(event => event.type === 'save-access'),
    [{type: 'save-access', id: '01020304', pin: PIN}],
  );
  assert.deepEqual(
    state.backs,
    [],
    'completion waits for the explicit Back button',
  );
  state.click('Back to Copy');
  assert.deepEqual(state.backs, ['copy']);
});

test('installation keeps the current page during deferred PIN saving and Copy handoff, then shows Complete directly', async () => {
  const state = mount({returnTo: 'copy'});
  const savePIN = deferred();
  const handoff = deferred();
  state.pinSession.setPIN = async () => savePIN.promise;
  state.entrances.copyItemsStore.get = () => ({
    session: {
      async addTarget(target) {
        await handoff.promise;
        state.targets.push(target);
      },
    },
  });
  state.click('Install applets');
  await state.answer();
  await state.tap();
  assert.ok(state.node('CardInformationContent'));
  assert.equal(state.node('CardAppletsContent'), undefined);
  assert.equal(state.node('OperationComplete'), undefined);
  savePIN.resolve();
  await state.flush();
  assert.ok(state.node('CardInformationContent'));
  assert.equal(state.node('CardAppletsContent'), undefined);
  assert.equal(state.node('OperationComplete'), undefined);
  assert.ok(state.node('Button').props.disabled);
  handoff.resolve();
  await state.flush();
  assert.ok(state.node('OperationComplete'));
  assert.equal(state.node('CardAppletsContent'), undefined);
  assert.deepEqual(state.targets, [state.initialized]);
});

test('the refreshed applet list is shown only after leaving Complete', async () => {
  const state = mount();
  state.click('Install applets');
  await state.answer();
  await state.tap();
  assert.ok(state.node('OperationComplete'));
  assert.equal(state.node('CardAppletsContent'), undefined);
  state.click('Back to Card Applets');
  const content = state.node('CardAppletsContent');
  assert.ok(content);
  assert.equal(content.props.id, '01020304');
  assert.ok(content.props.applets.every(applet => applet.installed));
});

test('setting PINs reuses the current applet inventory and updated Hello', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.uninitialized);
  state.click('Scan a card');
  await state.tap();
  state.informationReads = 0;
  state.installationReads = 0;

  state.click('Set Secret PIN');
  await state.answer();
  await state.tap();

  assert.deepEqual(state.errors, []);
  assert.equal(state.informationReads, 1);
  assert.equal(state.installationReads, 1);
  assert.ok(state.node('OperationComplete'));
  state.click('Back to Card Applets');
  assert.equal(state.node('CardAppletsContent').props.id, '01020304');
  assert.ok(
    find(
      state.render(),
      node => node.type === 'Button' && text(node) === 'Scan another card',
    ),
  );
});

test('failed installation reports the error and stays on Card information without offering automatic reinstall', async () => {
  const state = mount();
  state.installError = new Error('Installing the applet failed (6a80)');
  state.click('Install applets');
  await state.answer();
  await state.tap();
  assert.deepEqual(state.errors, [state.installError]);
  assert.ok(state.node('CardInformationContent'));
  assert.equal(state.node('CardAppletsContent'), undefined);
  assert.equal(state.node('OperationComplete'), undefined);
  assert.deepEqual(state.backs, []);
  assert.equal(
    state.events.some(event => event.type === 'prepare-fresh'),
    false,
  );
  state.click('Install applets');
  assert.equal(state.inputs.length, 2);
});

test('a verified destination is added to the retained Copy flow even when navigation changes while the scanner closes', async () => {
  const state = mount({returnTo: 'copy'});
  state.click('Install applets');
  await state.answer();
  await state.tap({finish: false});
  runInAction(() => {
    state.view.$match.$exact.$active = false;
  });
  state.scans[0].finished.resolve();
  await state.flush();
  assert.deepEqual(state.targets, [state.initialized]);
  assert.equal(state.node('OperationComplete'), undefined);
  assert.deepEqual(state.backs, []);
});

test('failed PIN setup never marks an installed card complete or adds it to Copy', async () => {
  const state = mount({returnTo: 'copy'});
  state.initializeError = new Error('PIN response lost');
  state.click('Install applets');
  await state.answer();
  await state.tap();
  assert.deepEqual(state.errors, [state.initializeError]);
  assert.deepEqual(state.targets, []);
  assert.equal(state.node('OperationComplete'), undefined);
  assert.equal(
    state.events.filter(event => event.type === 'initialize').length,
    1,
  );
  assert.equal(
    state.events.some(event => event.type === 'save-access'),
    false,
  );
});

for (const [kind, label] of [
  ['secret', 'Secret'],
  ['access', 'Access'],
]) {
  test(`an installed card with a blocked ${label} PIN cannot complete setup or be added to Copy`, async () => {
    const state = mount({returnTo: 'copy'});
    state.uninitialized = {
      ...state.initialized,
      pins: {...state.initialized.pins, [kind]: 0},
    };
    state.click('Install applets');
    await state.answer();
    await state.tap();
    assert.equal(state.errors.length, 1);
    assert.equal(state.errors[0].message, `${label} PIN blocked`);
    assert.deepEqual(state.targets, []);
    assert.equal(state.node('OperationComplete'), undefined);
    assert.equal(
      state.events.some(event =>
        ['initialize', 'save-access', 'complete'].includes(event.type),
      ),
      false,
    );
  });
}

test('a different physical card is rejected before installation or any PIN command', async () => {
  const state = mount();
  state.click('Install applets');
  await state.answer();
  state.information = {
    ...state.information,
    cplc: {icSerialNumber: 'different'},
  };
  await state.tap();
  assert.match(state.errors[0].message, /same card/);
  assert.equal(
    state.events.some(event =>
      ['install', 'auth', 'initialize'].includes(event.type),
    ),
    false,
  );
});

test('leaving while entering Secret PIN cancels the flow before opening the scanner', async () => {
  const state = mount();
  state.click('Install applets');
  runInAction(() => {
    state.view.$leaving = true;
  });
  await state.flush();
  assert.ok(state.inputs[0].signal.aborted);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.errors, []);
});

test('bundle replacement requires explicit confirmation and leaves a manual recovery reminder', async () => {
  const state = mount({
    cardInformation: false,
    bundle: new Uint8Array(32).fill(1),
  });
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  state.click('Card menu');
  state.click('Reinstall Monoid Applet');
  const confirm = state.node('ConfirmPopup');
  assert.ok(confirm);
  assert.equal(confirm.props.confirmColor, 'warning');
  assert.match(text(confirm), /another bundle card/);
  assert.equal(state.inputs.length, 0);
  confirm.props.onConfirm();
  await state.answer();
  await state.tap();
  assert.ok(state.node('OperationComplete'));
  assert.match(text(state.node('InfoMessage')), /another bundle card/);
  assert.equal(
    state.events.some(event => event.type === 'restore'),
    false,
  );
});

test('fresh installation uses danger confirmation with two explicit actions before asking for a new Secret PIN', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  state.click('Card menu');
  state.click('Fresh install');
  const confirm = state.node('ConfirmPopup');
  assert.equal(confirm.props.confirmColor, 'danger');
  assert.deepEqual(confirm.props.confirmText, ['Continue', 'Confirm']);
  assert.match(text(confirm), /new identity/);
  assert.equal(state.inputs.length, 0);
  assert.equal(
    state.events.some(event => event.type === 'prepare-fresh'),
    false,
  );
  confirm.props.onConfirm();
  assert.equal(state.inputs[0].options.placeholder, 'Set Secret PIN');
  await state.answer();
  await state.tap();
  const types = state.events.map(event => event.type);
  assert.ok(types.indexOf('initialize') < types.indexOf('complete'));
  assert.ok(state.node('OperationComplete'));
});

test('a known installed applet remains visible when card-manager information is unavailable', async () => {
  const state = mount({cardInformation: false});
  state.installation = {
    identity: {installed: true},
    monoid: {installed: true},
    helloError: new Error('Could not read Monoid'),
    registryError: new Error('GP unavailable'),
  };
  state.informationError = new CardManagerNotFoundError();
  state.click('Scan a card');
  await state.tap();
  const content = state.node('CardAppletsContent');
  assert.ok(content);
  assert.equal(content.props.applets[1].unknown, true);
  assert.equal(state.node('CardScanPlaceholder'), undefined);
  assert.deepEqual(state.errors, []);
});

test('a card with no accessible applets or supported manager uses the unsupported placeholder', async () => {
  const state = mount({cardInformation: false});
  state.informationError = new CardManagerNotFoundError();
  state.click('Scan a card');
  await state.tap();
  assert.equal(state.node('CardScanPlaceholder').props.unsupported, true);
  assert.equal(state.node('CardAppletsContent'), undefined);
  assert.deepEqual(state.errors, []);
});

test('a known Identity Applet is not classified as an unsupported card when Monoid and GP reads fail', async () => {
  const state = mount({cardInformation: false});
  state.installation = {
    identity: {installed: true},
    monoid: {installed: undefined},
    helloError: new Error('Monoid SELECT failed (6985)'),
    registryError: new Error('GP unavailable'),
  };
  state.informationError = new CardManagerNotFoundError();
  state.click('Scan a card');
  await state.tap();
  const content = state.node('CardAppletsContent');
  assert.ok(content);
  assert.equal(content.props.applets[0].installed, true);
  assert.equal(content.props.applets[1].unknown, true);
  assert.equal(state.node('CardScanPlaceholder'), undefined);
});
