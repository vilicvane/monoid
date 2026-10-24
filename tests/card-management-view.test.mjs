import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {observable, runInAction} from 'mobx';

import {SyncCardsState} from '../.bld/app/@components/views/safe/@card/sync-cards-state.js';
import * as monoid from '../.bld/app/@lib/monoid/index.js';
import {
  MonoidCardError,
  MonoidWrongCardError,
} from '../.bld/app/@lib/monoid/card-error.js';
import {SyncCardsStore} from '../.bld/app/@services/sync-cards-store.js';

let fixture;
let rendering;
const owners = [];
const PIN = 'Secret-42';
const AID = 'f06d6f6e6f69640201';
const SECURITY_KEY = {
  stage: 'security-key',
  optional: true,
  dependencies: ['library', 'monoid'],
};

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
    ...monoid,
    MonoidCardError,
    MonoidWrongCardError,
    hasAppletBundle: true,
    APPLET_NAMES: {
      identity: 'Monoid Identity Applet',
      library: 'Monoid Library',
      monoid: 'Monoid Applet',
      'security-key': 'Monoid Security Key Applet',
    },
    getAppletCatalog: () => [
      {stage: 'identity'},
      {stage: 'library'},
      {stage: 'monoid'},
      SECURITY_KEY,
    ],
    getAppletDependents: stages =>
      stages.some(stage => ['identity', 'library', 'monoid'].includes(stage))
        ? [SECURITY_KEY]
        : [],
    readMonoidAppletInstallation: async () => {
      fixture.installationReads = (fixture.installationReads ?? 0) + 1;
      return fixture.installation;
    },
    resolveMonoidAppletMaintenanceAid: async (
      sessionId,
      installation,
      signal,
    ) => {
      fixture.events.push({
        type: 'resolve-aid',
        sessionId,
        installation,
        signal,
      });
      if (fixture.resolveAidError) throw fixture.resolveAidError;
      return fixture.resolvedAid ?? installation.monoid.aid ?? AID;
    },
    createMonoidApplet: aid => ({
      async openSession() {
        fixture.events.push({type: 'select', aid});
        return fixture.applet;
      },
    }),
    installMonoidApplets: async (
      _session,
      _progress,
      _signal,
      selectedOptionalStages,
      identityOptions,
    ) => {
      fixture.events.push({
        type: 'install',
        selectedOptionalStages,
        identityOptions,
      });
      if (fixture.installError) throw fixture.installError;
      fixture.installation = installed(
        fixture.uninitialized,
        selectedOptionalStages,
      );
      return fixture.uninitialized;
    },
    initializeMonoidCard: async (_applet, hello, pin, _signal, access) => {
      fixture.initializedAccessPIN = access;
      fixture.events.push({type: 'initialize', pin});
      assert.equal(hello.id, fixture.uninitialized.id);
      if (fixture.initializeError) throw fixture.initializeError;
      fixture.installation = {
        ...fixture.installation,
        hello: fixture.initialized,
      };
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
  ['views/card/applet-selection-popup', ['AppletSelectionPopup']],
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
    authority: false,
    pins: {access: initialized ? 5 : false, secret: initialized ? 5 : false},
  };
}
function installed(hello, optional = []) {
  return {
    identity: {installed: true, loaded: true, aid: 'f06d6f6e6f69640001'},
    library: {installed: true, loaded: true},
    monoid: {installed: true, loaded: true, aid: AID, version: hello.version},
    optional: {
      'security-key': {
        installed: optional.includes('security-key'),
        loaded: optional.includes('security-key'),
      },
    },
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
    recordedInstallations: [],
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
    installation: {
      identity: {installed: false, loaded: false},
      library: {installed: false, loaded: false},
      monoid: {installed: false, loaded: false},
      optional: {'security-key': {installed: false, loaded: false}},
    },
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
      await state.flush();
      for (let step = 0; step < 4; step++) {
        const input = state.inputs.at(-1);
        input.finished.resolve(value);
        await state.flush();
        const next = state.inputs.at(-1);
        if (
          next === input ||
          value === undefined ||
          !/^(Confirm|Set Access)/.test(next.options.placeholder)
        )
          break;
      }
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
    list: async () => {
      state.events.push({type: 'list'});
      return {items: []};
    },
  };
  state.pinSession = {
    authenticate: async () => state.events.push({type: 'vault'}),
    removePIN: async () => {},
    getPINs: async signal => {
      await state.pinSession.authenticate(signal);
      return state.savedPINs ?? {};
    },
    setPIN: async (id, pin) =>
      state.events.push({type: 'save-access', id, pin}),
    clear: () => state.events.push({type: 'clear'}),
  };
  state.maintenance = {
    matchOperation: () => state.pending,
    get: () => state.pending,
    discardPrepared: async id => {
      state.events.push({type: 'discard-prepared', id});
      if (state.discardError) throw state.discardError;
      await state.discardGate?.promise;
      if (state.pending?.id !== id) return;
      if (
        state.pending.phase !== 'ready' ||
        state.pending.checkpoint !== undefined
      ) {
        throw new MonoidCardError('Card maintenance has already started');
      }
      state.pending = undefined;
    },
    isUpdateAvailable: () => false,
    isAppletUpdateAvailable: () => false,
    recordInstallation: async (hello, options) => {
      state.recordedInstallations.push({hello, options});
    },
    prepare: async (_applet, options) => {
      state.prepareOptions = options;
      state.events.push({
        type: 'prepare',
        mode: options.mode,
        appletAid: options.appletAid,
      });
      const prepared = {
        id: 'maintenance',
        mode: options.mode,
        phase: 'ready',
        card: {
          id: Buffer.from(state.initialized.id).toString('hex'),
          publicKey: Buffer.from(state.initialized.publicKey).toString('hex'),
          appletAid: AID,
          bundle: bundle ? Buffer.from(bundle).toString('hex') : false,
        },
      };
      if (
        !bundle ||
        options.replaceStages?.every(stage => stage === 'security-key')
      )
        state.pending = prepared;
      state.prepared = prepared;
      return prepared;
    },
    prepareFresh: async (
      _information,
      _hello,
      _signal,
      selectedOptionalStages,
      identityOptions,
    ) => {
      state.events.push({
        type: 'prepare-fresh',
        selectedOptionalStages,
        identityOptions,
      });
      state.pending = {
        id: 'fresh',
        mode: 'fresh',
        phase: 'ready',
        card: {appletAid: AID, bundle: false},
      };
      return state.pending;
    },
    replace: async (_session, id) => {
      state.events.push({type: 'replace', id});
      if (!['ready', 'replacing'].includes(state.pending.phase)) {
        return state.installation.hello;
      }
      if (state.pending.mode === 'fresh') state.pending = undefined;
      else
        state.pending.phase =
          bundle && !state.pending.archive ? 'manual-restore' : 'restore';
      state.installation = installed(state.uninitialized);
      return state.uninitialized;
    },
    restore: async () => {
      state.events.push({type: 'restore'});
      state.pending = undefined;
    },
  };
  const safe = {
    $exact: 'safe',
    copyItems: {$exact: 'copy'},
    setupCard: {$exact: 'bundle'},
    syncCards: options => ({
      $push: () => state.events.push({type: 'open-sync', options}),
    }),
  };
  state.entrances = {
    router: {
      safe,
      securityKey: Object.assign(
        options => ({
          $push: () => state.events.push({type: 'open-security-key', options}),
        }),
        {$exact: 'securityKey'},
      ),
      $backTo: route =>
        returnTo === route ? () => state.backs.push(route) : undefined,
    },
    monoidApplet: {openSession: async () => state.applet},
    monoidCredentialsStore: {createPINSession: () => state.pinSession},
    cardMaintenanceService: state.maintenance,
    syncCardsStore: new SyncCardsStore(),
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

test('installation chooses applets before Secret PIN, completes PIN setup, then returns the new card to Copy', async () => {
  const state = mount({returnTo: 'copy'});
  state.click('Install applets');
  assert.ok(state.node('AppletSelectionPopup'));
  assert.equal(state.inputs.length, 0);
  assert.equal(state.scans.length, 0);
  const identityOptions = {
    authorityUrl: 'https://authority.example',
    authorityPublicKey: new Uint8Array(65).fill(4),
  };
  state.node('AppletSelectionPopup').props.onInstall(identityOptions);
  await state.flush();
  assert.equal(state.inputs.length, 1);
  assert.match(state.inputs[0].options.placeholder, /Secret PIN/);
  assert.equal(state.scans.length, 0);
  await state.answer();
  assert.deepEqual(
    state.events.slice(0, 6).map(event => event.type),
    ['vault', 'input', 'input', 'input', 'input', 'scan'],
  );
  await state.tap({finish: false});
  assert.deepEqual(
    state.events.find(event => event.type === 'install').identityOptions,
    identityOptions,
  );
  assert.equal(state.informationReads, 1);
  assert.equal(state.installationReads, 2, 'refresh installed applets only');
  assert.deepEqual(state.recordedInstallations, [
    {
      hello: state.uninitialized,
      options: {identity: true, library: true, monoid: true, optional: []},
    },
  ]);
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
  state.installation.library = {installed: true, loaded: true};
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
  state.node('AppletSelectionPopup').props.onInstall();
  await state.answer();
  await state.tap();
  assert.deepEqual(state.recordedInstallations, [
    {
      hello: state.uninitialized,
      options: {identity: true, library: false, monoid: true, optional: []},
    },
  ]);
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
  state.node('AppletSelectionPopup').props.onInstall();
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
  assert.deepEqual(state.recordedInstallations, []);
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
  state.node('AppletSelectionPopup').props.onInstall();
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
  state.node('AppletSelectionPopup').props.onInstall();
  await state.flush();
  assert.equal(state.inputs.length, 5);
});

test('a verified destination is added to the retained Copy flow even when navigation changes while the scanner closes', async () => {
  const state = mount({returnTo: 'copy'});
  state.click('Install applets');
  state.node('AppletSelectionPopup').props.onInstall();
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
  state.node('AppletSelectionPopup').props.onInstall();
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
    state.node('AppletSelectionPopup').props.onInstall();
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
  state.node('AppletSelectionPopup').props.onInstall();
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
  state.node('AppletSelectionPopup').props.onInstall();
  await state.flush();
  runInAction(() => {
    state.view.$leaving = true;
  });
  await state.flush();
  assert.ok(state.inputs[0].signal.aborted);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.errors, []);
});

test('applet maintenance waits for PIN vault unlock before input and clears access when input is cancelled', async () => {
  const state = mount();
  const unlock = deferred();
  state.pinSession.authenticate = async () => {
    state.events.push({type: 'vault'});
    await unlock.promise;
  };
  state.click('Install applets');
  state.node('AppletSelectionPopup').props.onInstall();
  await state.flush();
  assert.equal(state.inputs.length, 0);
  assert.equal(state.scans.length, 0);
  unlock.resolve();
  await state.flush();
  assert.equal(state.inputs.length, 1);
  assert.deepEqual(
    state.events.map(event => event.type),
    ['vault', 'input'],
  );
  state.inputs[0].finished.resolve(undefined);
  await state.flush();
  assert.deepEqual(
    state.events.map(event => event.type),
    ['vault', 'input', 'clear'],
  );
  assert.equal(state.scans.length, 0);
  assert.deepEqual(state.errors, []);
});

for (const interruption of ['cancel', 'leave', 'unmount']) {
  test(`${interruption} during vault unlock prevents PIN input and NFC`, async () => {
    const state = mount();
    const unlock = deferred();
    let unlockSignal;
    state.pinSession.authenticate = async signal => {
      unlockSignal = signal;
      await unlock.promise;
    };
    state.click('Install applets');
    state.node('AppletSelectionPopup').props.onInstall();
    await state.flush();
    assert.equal(state.inputs.length, 0);
    if (interruption === 'cancel') {
      unlock.reject(Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}));
    } else {
      if (interruption === 'unmount') state.unmount();
      else runInAction(() => (state.view.$leaving = true));
      assert.equal(unlockSignal.aborted, true);
      unlock.resolve();
    }
    await state.flush();
    assert.equal(state.inputs.length, 0);
    assert.equal(state.scans.length, 0);
    assert.deepEqual(state.errors, []);
    assert.ok(state.events.some(event => event.type === 'clear'));
  });
}

test('bundle replacement collects its target and opens Sync only after NFC closes, before any replacement', async () => {
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
  await state.tap({finish: false});
  assert.deepEqual(state.errors, []);
  assert.equal(
    state.pending,
    undefined,
    'the draft is not a recoverable archive',
  );
  assert.equal(state.node('OperationComplete'), undefined);
  assert.equal(
    state.events.some(event => event.type === 'open-sync'),
    false,
  );
  assert.equal(
    state.events.some(event =>
      ['replace', 'restore', 'initialize'].includes(event.type),
    ),
    false,
  );
  state.scans.at(-1).finished.resolve();
  await state.flush();
  const handoff = state.events.find(event => event.type === 'open-sync');
  assert.ok(handoff);
  const flow = state.entrances.syncCardsStore.getOrCreate(
    handoff.options.syncId,
    () => assert.fail('The target must be collected before navigation'),
  );
  assert.ok(flow instanceof SyncCardsState);
  assert.equal(flow.maintenance, state.prepared);
  assert.equal(flow.session.cards.length, 1);
  assert.equal(flow.session.cards[0].publicKey, state.prepared.card.publicKey);
  assert.equal(flow.session.phase, 'collect');
  assert.equal(state.view.maintenanceSyncId, handoff.options.syncId);
  assert.equal(flow.maintenanceCardSnapshot.information, state.information);
  assert.deepEqual(
    flow.maintenanceCardSnapshot.installation.hello,
    state.initialized,
  );
  assert.equal(
    state.events.some(event => ['replace', 'restore'].includes(event.type)),
    false,
  );

  // Routra may remount the parent after Sync. Matching must use the retained
  // card snapshot rather than a mock which returns pending on a blank page.
  state.pending = {
    ...state.prepared,
    archive: {source: {publicKey: 'peer'}, items: []},
  };
  state.maintenance.matchOperation = ({hello}) =>
    hello &&
    Buffer.from(hello.publicKey).toString('hex') ===
      state.pending?.card.publicKey
      ? state.pending
      : undefined;
  flow.finishMaintenance();
  const scans = state.scans.length;
  runInAction(() => {
    state.view.$match.$exact.$active = false;
  });
  state.unmount();
  state.render();
  assert.ok(state.node('CardAppletsContent'));
  assert.equal(state.view.maintenanceSyncId, handoff.options.syncId);
  assert.equal(
    state.entrances.syncCardsStore.get(handoff.options.syncId),
    flow,
  );
  // Cancelling a swipe back must leave the handoff available for the real return.
  state.unmount();
  assert.equal(state.view.maintenanceSyncId, handoff.options.syncId);
  assert.equal(
    state.entrances.syncCardsStore.get(handoff.options.syncId),
    flow,
  );
  runInAction(() => {
    state.view.$match.$exact.$active = true;
  });
  state.render();
  assert.ok(state.node('CardAppletsContent'));
  assert.equal(state.node('CardScanPlaceholder'), undefined);
  assert.equal(state.node('CardAppletsContent').props.recovery, true);
  assert.equal(
    text(state.node('ViewContent').props.footer),
    'Continue installation',
  );
  assert.equal(state.scans.length, scans);
  assert.equal(state.view.maintenanceSyncId, undefined);
  assert.equal(
    state.entrances.syncCardsStore.get(handoff.options.syncId),
    undefined,
  );

  // A second collection round must carry its own snapshot after Start over.
  state.click('Card menu');
  state.click('Start over');
  state.node('ConfirmPopup').props.onConfirm();
  await state.flush();
  state.click('Card menu');
  state.click('Reinstall Monoid Applet');
  state.node('ConfirmPopup').props.onConfirm();
  await state.answer();
  await state.tap();
  const nextHandoff = state.events.findLast(
    event => event.type === 'open-sync',
  );
  assert.notEqual(nextHandoff.options.syncId, handoff.options.syncId);
  const nextFlow = state.entrances.syncCardsStore.get(
    nextHandoff.options.syncId,
  );
  assert.deepEqual(
    nextFlow.maintenanceCardSnapshot.installation.hello,
    state.initialized,
  );
  state.pending = {
    ...state.prepared,
    archive: {source: {publicKey: 'peer'}, items: []},
  };
  nextFlow.finishMaintenance();
  state.unmount();
  state.render();
  assert.ok(state.node('CardAppletsContent'));
  assert.equal(state.node('CardScanPlaceholder'), undefined);
  assert.equal(
    text(state.node('ViewContent').props.footer),
    'Continue installation',
  );
  assert.equal(
    state.events.some(event => ['replace', 'restore'].includes(event.type)),
    false,
  );
});

for (const mode of ['update', 'reinstall']) {
  test(`${mode} resolves a protected registry AID before backup`, async () => {
    const state = mount({cardInformation: false});
    state.installation = installed(state.initialized);
    delete state.installation.monoid.aid;
    state.installation.registryError = Object.assign(
      new Error('Reading the card registry failed'),
      {sw: 0x6982},
    );
    const scannedInstallation = state.installation;
    state.maintenance.isUpdateAvailable = () => mode === 'update';
    state.click('Scan a card');
    await state.tap();
    assert.equal(
      state.events.some(event => event.type === 'resolve-aid'),
      false,
      'ordinary card inspection must not authenticate the GP channel',
    );
    if (mode === 'reinstall') state.click('Card menu');
    state.click(
      mode === 'update' ? 'Update applets' : 'Reinstall Monoid Applet',
    );
    assert.equal(state.inputs.length, 0);
    state.node('ConfirmPopup').props.onConfirm();
    await state.answer();
    await state.tap();

    assert.deepEqual(state.errors, []);
    const operations = state.events.filter(event =>
      ['resolve-aid', 'select', 'auth', 'prepare', 'replace'].includes(
        event.type,
      ),
    );
    assert.deepEqual(
      operations.slice(0, 5).map(event => event.type),
      ['resolve-aid', 'select', 'auth', 'prepare', 'replace'],
    );
    const lookups = operations.filter(event => event.type === 'resolve-aid');
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0].sessionId, 'session');
    assert.equal(lookups[0].installation, scannedInstallation);
    assert.equal(lookups[0].signal.aborted, false);
    assert.equal(
      Buffer.from(
        operations.find(event => event.type === 'select').aid,
      ).toString('hex'),
      AID,
    );
    assert.deepEqual(
      operations.find(event => event.type === 'auth'),
      {
        type: 'auth',
        secret: true,
        pin: PIN,
      },
    );
    assert.deepEqual(
      operations.find(event => event.type === 'prepare'),
      {
        type: 'prepare',
        mode,
        appletAid: AID,
      },
    );
    assert.ok(state.node('OperationComplete'));
  });
}

test('a failed maintenance AID resolution stops before backup or replacement and preserves the error', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  delete state.installation.monoid.aid;
  state.installation.registryError = Object.assign(
    new Error('Registry requires authentication'),
    {sw: 0x6982},
  );
  state.resolveAidError = new Error('Management authentication failed');
  state.click('Scan a card');
  await state.tap();
  state.click('Card menu');
  state.click('Reinstall Monoid Applet');
  state.node('ConfirmPopup').props.onConfirm();
  await state.answer();
  await state.tap();

  assert.deepEqual(state.errors, [state.resolveAidError]);
  assert.equal(
    state.events.filter(event => event.type === 'resolve-aid').length,
    1,
  );
  assert.equal(
    state.events.some(event =>
      [
        'select',
        'auth',
        'prepare',
        'replace',
        'install',
        'initialize',
      ].includes(event.type),
    ),
    false,
  );
  assert.equal(state.pending, undefined);
  assert.equal(state.node('OperationComplete'), undefined);
});

test('maintenance rejects a changed card identity before authenticating its protected registry', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  delete state.installation.monoid.aid;
  state.click('Scan a card');
  await state.tap();
  state.click('Card menu');
  state.click('Reinstall Monoid Applet');
  state.node('ConfirmPopup').props.onConfirm();
  await state.answer();
  state.installation = {
    ...state.installation,
    hello: {...state.initialized, publicKey: new Uint8Array(65).fill(3)},
  };
  await state.tap();

  assert.ok(state.errors[0] instanceof MonoidWrongCardError);
  assert.equal(
    state.events.some(event =>
      ['resolve-aid', 'auth', 'prepare', 'replace'].includes(event.type),
    ),
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
  assert.equal(state.node('AppletSelectionPopup').props.fresh, true);
  assert.equal(state.node('ConfirmPopup'), undefined);
  assert.equal(state.inputs.length, 0);
  state.node('AppletSelectionPopup').props.onChange(['security-key']);
  const identityOptions = {
    authorityUrl: 'https://authority.example',
    authorityPublicKey: new Uint8Array(65).fill(4),
  };
  state.node('AppletSelectionPopup').props.onInstall(identityOptions);
  const confirm = state.node('ConfirmPopup');
  assert.equal(confirm.props.confirmColor, 'danger');
  assert.deepEqual(confirm.props.confirmText, ['Continue', 'Confirm']);
  assert.match(text(confirm), /Card keys will be regenerated/);
  assert.equal(state.inputs.length, 0);
  assert.equal(
    state.events.some(event => event.type === 'prepare-fresh'),
    false,
  );
  confirm.props.onConfirm();
  await state.flush();
  assert.equal(state.inputs[0].options.placeholder, 'Set Secret PIN');
  await state.answer();
  await state.tap();
  const types = state.events.map(event => event.type);
  assert.deepEqual(
    state.events.find(event => event.type === 'prepare-fresh')
      .selectedOptionalStages,
    ['security-key'],
  );
  assert.ok(types.indexOf('replace') < types.indexOf('initialize'));
  assert.deepEqual(
    state.events.find(event => event.type === 'prepare-fresh').identityOptions,
    identityOptions,
  );
  assert.equal(state.pending, undefined);
  assert.ok(state.node('OperationComplete'));
});

test('dismissing applet selection performs no PIN prompt, scan or installation', () => {
  const state = mount();
  state.click('Install applets');
  const selection = state.node('AppletSelectionPopup');
  assert.deepEqual(selection.props.selected, []);
  selection.props.onChange(['security-key']);
  state.node('AppletSelectionPopup').props.onDismiss();
  assert.equal(state.node('AppletSelectionPopup'), undefined);
  assert.deepEqual(state.inputs, []);
  assert.deepEqual(state.scans, []);
  assert.equal(
    state.events.some(event => event.type === 'install'),
    false,
  );
});

test('explicit Security Key selection reaches installation and returns to Security Key only on Back', async () => {
  const state = mount({returnTo: 'securityKey'});
  state.click('Install applets');
  state.node('AppletSelectionPopup').props.onChange(['security-key']);
  assert.equal(state.inputs.length, 0);
  state.node('AppletSelectionPopup').props.onInstall();
  await state.answer();
  await state.tap();
  assert.deepEqual(state.errors, []);
  assert.deepEqual(
    state.events.find(event => event.type === 'install').selectedOptionalStages,
    ['security-key'],
  );
  assert.deepEqual(state.recordedInstallations[0].options.optional, [
    'security-key',
  ]);
  assert.ok(state.node('OperationComplete'));
  assert.deepEqual(state.backs, []);
  state.click('Back to Security Key');
  assert.deepEqual(state.backs, ['securityKey']);
});

for (const mode of ['update', 'reinstall']) {
  test(`${mode} warns about the dependent Security Key and does nothing until confirmed`, async () => {
    const state = mount({cardInformation: false});
    state.installation = installed(state.initialized, ['security-key']);
    state.maintenance.isUpdateAvailable = () => mode === 'update';
    state.click('Scan a card');
    await state.tap();
    if (mode === 'reinstall') state.click('Card menu');
    state.click(
      mode === 'update' ? 'Update applets' : 'Reinstall Monoid Applet',
    );
    const confirmation = state.node('ConfirmPopup');
    assert.equal(confirmation.props.confirmColor, 'warning');
    assert.deepEqual(confirmation.props.confirmText, ['Continue', 'Confirm']);
    assert.match(
      text(confirmation),
      /Items and applet access will be backed up and restored/,
    );
    assert.match(
      text(confirmation),
      /Monoid Security Key Applet will be reinstalled/,
    );
    assert.match(text(confirmation), /FIDO PIN will be reset/);
    assert.equal(state.inputs.length, 0);
    assert.equal(
      state.events.some(event => event.type === 'prepare'),
      false,
    );
    confirmation.props.onCancel();
    assert.equal(state.node('ConfirmPopup'), undefined);
    assert.equal(state.inputs.length, 0);
    if (mode === 'reinstall') state.click('Card menu');
    state.click(
      mode === 'update' ? 'Update applets' : 'Reinstall Monoid Applet',
    );
    state.node('ConfirmPopup').props.onConfirm();
    await state.answer();
    await state.tap();
    assert.deepEqual(state.errors, []);
    assert.equal(state.prepareOptions.mode, mode);
    assert.deepEqual(state.prepareOptions.selectedOptionalStages, [
      'security-key',
    ]);
    assert.deepEqual(
      state.prepareOptions.replaceStages,
      mode === 'update' ? ['library', 'monoid'] : undefined,
    );
  });
}

test('a Security Key-only update preserves Monoid items and selects only its own replacement stage', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized, ['security-key']);
  state.maintenance.isAppletUpdateAvailable = (_hello, stage) =>
    stage === 'security-key';
  state.click('Scan a card');
  await state.tap();
  state.click('Update applets');
  const confirmation = state.node('ConfirmPopup');
  assert.match(text(confirmation), /Items and applet access will be preserved/);
  assert.doesNotMatch(text(confirmation), /backed up/);
  assert.match(text(confirmation), /FIDO PIN will be reset/);
  assert.equal(state.inputs.length, 0);
  confirmation.props.onConfirm();
  await state.answer();
  await state.tap();
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.prepareOptions.replaceStages, ['security-key']);
});

test('an unresolved Bundle recovery without grants still blocks a new installation', async () => {
  const state = mount({cardInformation: false, bundle: true});
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  state.pending = {
    id: 'earlier',
    mode: 'update',
    phase: 'manual-restore',
    card: {appletAid: AID, bundle: true},
    grants: [],
  };
  assert.ok(
    find(
      state.render(),
      node => node.type === 'Button' && text(node) === 'Sync items',
    ),
  );
  state.click('Card menu');
  const install = find(
    state.render(),
    node => node.type === 'Button' && text(node) === 'Install applets',
  );
  assert.equal(install.props.disabled, true);
  assert.equal(
    state.events.some(
      event =>
        event.type === 'replace' ||
        event.type === 'restore' ||
        event.type === 'install',
    ),
    false,
  );
  assert.equal(state.pending.id, 'earlier');
  assert.equal(state.node('OperationComplete'), undefined);
});

test('optional installation updates known outdated dependencies after confirmation', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  state.maintenance.isUpdateAvailable = () => true;
  state.click('Scan a card');
  await state.tap();
  state.click('Card menu');
  state.click('Install applets');
  state.node('AppletSelectionPopup').props.onChange(['security-key']);
  state.node('AppletSelectionPopup').props.onInstall();
  const confirmation = state.node('ConfirmPopup');
  assert.equal(confirmation.props.title, 'Update applets');
  assert.match(text(confirmation), /backed up and restored/);
  assert.equal(state.inputs.length, 0);
  confirmation.props.onConfirm();
  await state.answer();
  await state.tap();
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.prepareOptions.replaceStages, ['library', 'monoid']);
  assert.deepEqual(state.prepareOptions.selectedOptionalStages, [
    'security-key',
  ]);
});

test('Security Key maintenance includes known outdated required applets', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized, ['security-key']);
  state.maintenance.isUpdateAvailable = () => true;
  state.click('Scan a card');
  await state.tap();
  state.node('CardAppletsContent').props.onSelectApplet('security-key');
  state.click('Reinstall applet');
  const confirmation = state.node('ConfirmPopup');
  assert.match(text(confirmation), /backed up and restored/);
  assert.match(text(confirmation), /FIDO PIN will be reset/);
  confirmation.props.onConfirm();
  await state.answer();
  await state.tap();
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.prepareOptions.replaceStages, [
    'library',
    'monoid',
    'security-key',
  ]);
  assert.deepEqual(state.prepareOptions.selectedOptionalStages, [
    'security-key',
  ]);
});

test('the installed Security Key applet opens its Home page with the scanned card identity', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized, ['security-key']);
  state.click('Scan a card');
  await state.tap();
  state.node('CardAppletsContent').props.onSelectApplet('security-key');
  state.click('Open Security Key');
  assert.deepEqual(state.events.at(-1), {
    type: 'open-security-key',
    options: {
      card: {
        id: '01020304',
        publicKey: Buffer.from(state.initialized.publicKey).toString('hex'),
      },
    },
  });
  assert.equal(state.inputs.length, 0);
});

test('a known installed applet remains visible when card-manager information is unavailable', async () => {
  const state = mount({cardInformation: false});
  state.installation = {
    identity: {installed: true},
    library: {installed: undefined},
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
    library: {installed: undefined},
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

for (const [mode, label] of [
  ['reinstall', 'Resume reinstall'],
  ['update', 'Resume update'],
  ['fresh', 'Resume fresh install'],
]) {
  test(`interrupted ${mode} requires explicit confirmation and resumes its saved plan`, async () => {
    const state = mount({cardInformation: false});
    state.installation = installed(state.initialized);
    state.click('Scan a card');
    await state.tap();
    state.pending = {
      id: 'interrupted',
      mode,
      phase: 'replacing',
      checkpoint: 'remove-monoid-package',
      selectedOptionalStages: ['security-key'],
      replaceStages: ['library', 'monoid', 'security-key'],
      archive: mode === 'fresh' ? undefined : {items: []},
      card: {appletAid: AID, bundle: false},
    };
    const saved = state.pending;
    const footer = state.node('ViewContent').props.footer;
    assert.equal(text(footer), label);
    state.click(label);
    const confirmation = state.node('ConfirmPopup');
    assert.equal(
      confirmation.props.confirmColor,
      mode === 'fresh' ? 'danger' : 'warning',
    );
    assert.match(
      text(confirmation),
      /Monoid Security Key Applet will be reinstalled/,
    );
    assert.equal(state.inputs.length, 0);
    assert.equal(state.scans.length, 1);
    confirmation.props.onCancel();
    assert.equal(state.node('ConfirmPopup'), undefined);
    assert.equal(state.pending, saved);
    assert.equal(state.inputs.length, 0);
    state.click(label);
    state.node('ConfirmPopup').props.onConfirm();
    await state.flush();
    assert.equal(
      state.inputs[0].options.placeholder,
      mode === 'fresh' ? 'Set Secret PIN' : 'Enter existing Secret PIN',
    );
    await state.answer();
    await state.tap();
    assert.deepEqual(state.errors, []);
    assert.deepEqual(
      state.events.filter(event => event.type === 'replace'),
      [{type: 'replace', id: 'interrupted'}],
    );
    assert.equal(
      state.events.some(event =>
        ['prepare', 'prepare-fresh', 'install'].includes(event.type),
      ),
      false,
    );
    assert.deepEqual(saved.selectedOptionalStages, ['security-key']);
    assert.deepEqual(saved.replaceStages, [
      'library',
      'monoid',
      'security-key',
    ]);
  });
}

test('resume confirmation cannot authorize a different saved maintenance operation', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  state.pending = {
    id: 'confirmed',
    mode: 'reinstall',
    phase: 'replacing',
    card: {appletAid: AID, bundle: false},
  };
  state.click('Resume reinstall');
  state.node('ConfirmPopup').props.onConfirm();
  await state.answer();
  state.pending = {...state.pending, id: 'different'};
  await state.tap();
  assert.equal(state.errors.length, 1);
  assert.equal(
    state.events.some(event =>
      ['prepare', 'replace', 'install'].includes(event.type),
    ),
    false,
  );
});

test('an interrupted replacement disables new installation instead of borrowing its saved operation', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  state.pending = {
    id: 'interrupted',
    mode: 'fresh',
    phase: 'replacing',
    card: {appletAid: AID, bundle: false},
  };
  state.click('Card menu');
  for (const label of ['Install applets', 'Fresh install']) {
    const button = find(
      state.render(),
      node => node.type === 'Button' && text(node) === label,
    );
    assert.equal(button.props.disabled, true);
  }
});

test('a new Install action cannot resume an operation discovered during its scan', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  state.click('Card menu');
  state.click('Install applets');
  state.node('AppletSelectionPopup').props.onChange(['security-key']);
  state.node('AppletSelectionPopup').props.onInstall();
  await state.answer();
  state.pending = {
    id: 'interrupted',
    mode: 'reinstall',
    phase: 'replacing',
    card: {appletAid: AID, bundle: false},
  };
  await state.tap();
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0].message, /Resume card maintenance first/);
  assert.equal(
    state.events.some(event =>
      ['prepare', 'replace', 'install'].includes(event.type),
    ),
    false,
  );
});

for (const [phase, label, mode, archive, grants] of [
  ['restore', 'Restore items', 'reinstall', {items: []}, []],
  ['restore', 'Restore applet access', 'reinstall', undefined, ['grant']],
]) {
  test(`${phase} offers only its remaining ${label} action`, async () => {
    const state = mount({cardInformation: false});
    state.installation = installed(state.initialized);
    state.click('Scan a card');
    await state.tap();
    state.pending = {
      id: 'remaining',
      mode,
      phase,
      archive,
      grants,
      card: {appletAid: AID, bundle: false},
    };
    assert.equal(text(state.node('ViewContent').props.footer), label);
    state.click(label);
    assert.equal(state.node('ConfirmPopup'), undefined);
    await state.answer();
    await state.tap();
    assert.deepEqual(state.errors, []);
    assert.equal(
      state.events.some(event =>
        ['prepare', 'prepare-fresh', 'install'].includes(event.type),
      ),
      false,
    );
    assert.ok(state.events.some(event => event.type === 'restore'));
    assert.equal(
      state.events.some(event => event.type === 'initialize'),
      false,
    );
    assert.ok(state.node('OperationComplete'));
  });
}

for (const cached of [false, true]) {
  test(`restoration ${cached ? 'reuses saved' : 'confirms new'} Access PIN while authenticating existing Secret PIN once`, async () => {
    const state = mount({cardInformation: false});
    state.uninitialized.pins = {secret: 5, access: false};
    state.installation = installed(state.uninitialized);
    if (cached)
      state.savedPINs = {
        [Buffer.from(state.uninitialized.id).toString('hex')]: 'Saved-42',
      };
    state.click('Scan a card');
    await state.tap();
    state.pending = {
      id: 'restore-pins',
      mode: 'reinstall',
      phase: 'restore',
      archive: {items: []},
      grants: [],
      card: {appletAid: AID, bundle: false},
    };
    state.click('Restore items');
    await state.answer();
    assert.deepEqual(
      state.inputs.map(i => i.options.placeholder),
      cached
        ? ['Enter existing Secret PIN']
        : ['Enter existing Secret PIN', 'Set Access PIN', 'Confirm Access PIN'],
    );
    await state.tap();
    assert.deepEqual(state.errors, []);
    assert.equal(state.initializedAccessPIN, cached ? 'Saved-42' : PIN);
    assert.equal(
      state.events.find(e => e.type === 'save-access').pin,
      cached ? 'Saved-42' : PIN,
    );
  });
}

for (const grants of [[], ['grant']]) {
  test(`Bundle manual recovery syncs items before ${grants.length ? 'restoring grants' : 'finishing recovery'}`, async () => {
    const state = mount({
      cardInformation: false,
      bundle: new Uint8Array(32).fill(1),
    });
    state.installation = installed(state.initialized);
    state.click('Scan a card');
    await state.tap();
    state.pending = {
      id: 'remaining-bundle',
      mode: 'reinstall',
      phase: 'manual-restore',
      card: {
        id: Buffer.from(state.initialized.id).toString('hex'),
        publicKey: Buffer.from(state.initialized.publicKey).toString('hex'),
        appletAid: AID,
        bundle: '01'.repeat(32),
      },
      grants,
    };
    const saved = state.pending;
    assert.equal(text(state.node('ViewContent').props.footer), 'Sync items');
    state.click('Sync items');
    await state.answer();
    await state.tap({finish: false});
    assert.deepEqual(state.errors, []);
    assert.equal(state.pending, saved);
    assert.equal(
      state.events.some(event => event.type === 'open-sync'),
      false,
    );
    assert.equal(
      state.events.some(event =>
        ['replace', 'restore', 'prepare'].includes(event.type),
      ),
      false,
    );
    state.scans.at(-1).finished.resolve();
    await state.flush();
    assert.ok(state.events.some(event => event.type === 'open-sync'));
    assert.equal(state.node('OperationComplete'), undefined);
  });
}

for (const leavingAt of ['PIN', 'target read', 'NFC cleanup']) {
  test(`Bundle backup does not hand off or replace after leaving during ${leavingAt}`, async () => {
    const state = mount({
      cardInformation: false,
      bundle: new Uint8Array(32).fill(1),
    });
    state.installation = installed(state.initialized);
    state.click('Scan a card');
    await state.tap();
    state.click('Card menu');
    state.click('Reinstall Monoid Applet');
    state.node('ConfirmPopup').props.onConfirm();
    await state.flush();
    const read = deferred();
    if (leavingAt === 'target read') {
      state.applet.list = async () => read.promise;
    }
    if (leavingAt !== 'PIN') {
      await state.answer();
      if (leavingAt === 'target read') {
        const tapping = state.tap({finish: false});
        await state.flush();
        runInAction(() => {
          state.view.$leaving = true;
        });
        read.resolve({items: []});
        await tapping;
      } else {
        await state.tap({finish: false});
      }
    }
    runInAction(() => {
      state.view.$leaving = true;
    });
    if (leavingAt === 'PIN') await state.answer();
    else {
      state.scans.at(-1).finished.resolve();
      await state.flush();
    }
    assert.equal(
      state.events.some(event =>
        ['replace', 'restore', 'open-sync'].includes(event.type),
      ),
      false,
    );
    assert.equal(state.pending, undefined);
    assert.deepEqual(state.errors, []);
  });
}

test('manual Bundle recovery sets missing PINs before collecting its target in the same scan', async () => {
  const state = mount({
    cardInformation: false,
    bundle: new Uint8Array(32).fill(1),
  });
  state.installation = installed(state.uninitialized);
  state.click('Scan a card');
  await state.tap();
  state.pending = {
    id: 'manual-setup',
    mode: 'reinstall',
    phase: 'manual-restore',
    grants: ['grant'],
    card: {
      id: Buffer.from(state.initialized.id).toString('hex'),
      publicKey: Buffer.from(state.initialized.publicKey).toString('hex'),
      appletAid: AID,
      bundle: '01'.repeat(32),
    },
  };
  state.click('Sync items');
  await state.flush();
  assert.equal(state.inputs.length, 1);
  assert.match(state.inputs[0].options.placeholder, /Set Secret PIN/);
  await state.answer();
  await state.tap({finish: false});
  assert.deepEqual(state.errors, []);
  assert.equal(state.inputs.length, 4);
  assert.equal(
    state.scans.length,
    2,
    'one initial read and one setup/collection scan',
  );
  const initialize = state.events.findIndex(
    event => event.type === 'initialize',
  );
  const list = state.events.findIndex(event => event.type === 'list');
  assert.ok(initialize >= 0 && list > initialize);
  assert.equal(
    state.events.some(event => event.type === 'save-access'),
    false,
  );
  state.scans.at(-1).finished.resolve();
  await state.flush();
  assert.ok(state.events.some(event => event.type === 'save-access'));
  assert.ok(state.events.some(event => event.type === 'open-sync'));
  assert.equal(
    state.events.some(event => ['restore', 'replace'].includes(event.type)),
    false,
  );
});

test('a saved Bundle archive still requires explicit Reinstall confirmation before replacement', async () => {
  const state = mount({
    cardInformation: false,
    bundle: new Uint8Array(32).fill(1),
  });
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  state.pending = {
    id: 'saved-bundle',
    mode: 'reinstall',
    phase: 'ready',
    card: {appletAid: AID, bundle: '01'.repeat(32)},
    archive: {source: {publicKey: 'peer'}, items: []},
  };
  assert.equal(
    text(state.node('ViewContent').props.footer),
    'Continue installation',
  );
  assert.equal(
    state.events.some(event => event.type === 'replace'),
    false,
  );
  state.click('Continue installation');
  assert.ok(state.node('ConfirmPopup'));
  assert.equal(state.inputs.length, 0);
  state.node('ConfirmPopup').props.onConfirm();
  await state.answer();
  await state.tap();
  assert.deepEqual(state.errors, []);
  assert.deepEqual(
    state.events
      .filter(event => ['replace', 'restore'].includes(event.type))
      .map(event => event.type),
    ['replace', 'restore'],
  );
  assert.equal(
    state.events.some(event => event.type === 'open-sync'),
    false,
  );
  assert.ok(state.node('OperationComplete'));
});

for (const failureStage of [
  'authentication',
  'before import',
  'scan cancellation',
]) {
  test(`item recovery retains its card and Restore action after ${failureStage} failure`, async () => {
    const state = mount({cardInformation: false});
    state.installation = installed(state.initialized);
    state.click('Scan a card');
    await state.tap();
    const archive = {
      items: [{index: '02400000000000000001', secret: true, data: '01'}],
    };
    const pending = (state.pending = {
      id: 'remaining',
      mode: 'reinstall',
      phase: 'restore',
      archive,
      grants: [],
      card: {appletAid: AID, bundle: false},
    });
    // Ordinary recovery matches the retained card identity, not a blank page.
    state.maintenance.matchOperation = ({hello}) =>
      hello ? state.pending : undefined;
    const failure = Object.assign(
      new Error(failureStage),
      failureStage === 'scan cancellation' ? {code: 'CANCELLED'} : {},
    );
    const authenticate = state.applet.authenticate;
    const restore = state.maintenance.restore;
    if (failureStage === 'authentication') {
      state.applet.authenticate = async request => {
        await authenticate(request);
        throw failure;
      };
    } else {
      state.maintenance.restore = async (_applet, _id, onProgress) => {
        state.events.push({type: 'restore'});
        onProgress({
          stage: 'restore',
          completed: 0,
          total: archive.items.length,
        });
        throw failure;
      };
    }

    state.click('Restore items');
    await state.answer();
    await state.tap();

    assert.equal(state.pending, pending);
    assert.equal(state.pending.archive, archive);
    assert.equal(state.node('OperationComplete'), undefined);
    assert.equal(state.node('CardScanPlaceholder'), undefined);
    assert.equal(state.node('CardAppletsContent').props.recovery, true);
    assert.equal(text(state.node('ViewContent').props.footer), 'Restore items');
    assert.equal(state.node('ViewContent').props.footer.props.disabled, false);
    assert.deepEqual(
      state.errors,
      failureStage === 'scan cancellation' ? [] : [failure],
    );
    assert.equal(
      state.events.some(event => event.type === 'restore'),
      failureStage !== 'authentication',
    );
    assert.equal(
      state.events.some(event =>
        ['prepare', 'prepare-fresh', 'install', 'initialize'].includes(
          event.type,
        ),
      ),
      false,
    );

    // An explicit retry uses the same retained recovery without a fresh scan.
    state.applet.authenticate = authenticate;
    state.maintenance.restore = restore;
    state.click('Restore items');
    await state.answer();
    await state.tap();
    assert.equal(state.pending, undefined);
    assert.ok(state.node('OperationComplete'));
  });
}

test('recovery failure after a real replacement still discards the old card snapshot', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  const archive = {
    items: [{index: '02400000000000000001', secret: true, data: '01'}],
  };
  const prepare = state.maintenance.prepare;
  state.maintenance.prepare = async (...args) => {
    const pending = await prepare(...args);
    pending.archive = archive;
    return pending;
  };
  state.maintenance.matchOperation = ({hello}) =>
    hello ? state.pending : undefined;
  const failure = new Error('Import interrupted');
  state.maintenance.restore = async () => {
    state.events.push({type: 'restore'});
    throw failure;
  };

  state.click('Card menu');
  state.click('Reinstall Monoid Applet');
  state.node('ConfirmPopup').props.onConfirm();
  await state.answer();
  await state.tap();

  assert.equal(state.pending.phase, 'restore');
  assert.equal(state.pending.archive, archive);
  assert.deepEqual(state.errors, [failure]);
  assert.equal(state.node('OperationComplete'), undefined);
  assert.ok(state.node('CardScanPlaceholder'));
  assert.equal(state.node('CardAppletsContent'), undefined);
  assert.equal(text(state.node('ViewContent').props.footer), 'Scan a card');
  assert.ok(state.events.some(event => event.type === 'initialize'));
  assert.ok(state.events.some(event => event.type === 'restore'));

  state.click('Scan a card');
  await state.tap();
  assert.equal(text(state.node('ViewContent').props.footer), 'Restore items');
  assert.equal(state.node('CardAppletsContent').props.recovery, true);
});

test('fresh installation interrupted during PIN setup needs only a new card read, not a saved reinstall', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  state.click('Card menu');
  state.click('Fresh install');
  state.node('AppletSelectionPopup').props.onInstall();
  state.node('ConfirmPopup').props.onConfirm();
  await state.answer();
  state.initializeError = new Error('Card removed');
  await state.tap();
  assert.equal(state.pending, undefined);
  assert.equal(text(state.node('ViewContent').props.footer), 'Scan a card');
  assert.equal(state.node('OperationComplete'), undefined);
  state.initializeError = undefined;
  state.click('Scan a card');
  await state.tap();
  assert.equal(text(state.node('ViewContent').props.footer), 'Set Secret PIN');
  const replacements = state.events.filter(
    event => event.type === 'replace',
  ).length;
  state.click('Set Secret PIN');
  await state.answer();
  await state.tap();
  assert.equal(
    state.events.filter(event => event.type === 'replace').length,
    replacements,
  );
  assert.ok(state.node('OperationComplete'));
});

for (const [mode, label] of [
  ['reinstall', 'Continue installation'],
  ['update', 'Continue update'],
  ['fresh', 'Fresh install'],
]) {
  test(`a prepared ${mode} offers the next action and still requires confirmation`, async () => {
    const state = mount({cardInformation: false});
    state.installation = installed(state.initialized);
    state.click('Scan a card');
    await state.tap();
    state.pending = {
      id: 'prepared',
      mode,
      phase: 'ready',
      card: {appletAid: AID, bundle: false},
      archive: mode === 'fresh' ? undefined : {items: []},
    };
    assert.equal(text(state.node('ViewContent').props.footer), label);
    state.click(label);
    assert.ok(state.node('ConfirmPopup'));
    assert.equal(state.inputs.length, 0);
    assert.equal(state.scans.length, 1);
  });
}

test('Start over confirms, awaits discard and keeps the current card without opening NFC', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  state.pending = {
    id: 'prepared',
    mode: 'reinstall',
    phase: 'ready',
    card: {appletAid: AID, bundle: false},
    archive: {items: []},
  };
  const saved = state.pending;
  const scans = state.scans.length;
  const inputs = state.inputs.length;
  state.click('Card menu');
  state.click('Start over');
  const confirmation = state.node('ConfirmPopup');
  assert.equal(confirmation.props.title, 'Start over?');
  assert.equal(confirmation.props.confirmText, 'Start over');
  assert.equal(state.pending, saved);
  confirmation.props.onCancel();
  assert.equal(state.node('ConfirmPopup'), undefined);
  assert.equal(state.pending, saved);
  assert.equal(
    state.events.some(event => event.type === 'discard-prepared'),
    false,
  );
  state.click('Card menu');
  state.click('Start over');
  state.discardGate = deferred();
  state.node('ConfirmPopup').props.onConfirm();
  await state.flush();
  assert.equal(state.pending, saved);
  assert.ok(state.node('CardAppletsContent'));
  assert.equal(state.node('ViewContent').props.footer.props.disabled, true);
  assert.deepEqual(
    state.events.filter(event => event.type === 'discard-prepared'),
    [{type: 'discard-prepared', id: 'prepared'}],
  );
  assert.equal(state.scans.length, scans);
  assert.equal(state.inputs.length, inputs);
  state.discardGate.resolve();
  await state.flush();
  assert.equal(state.pending, undefined);
  assert.ok(state.node('CardAppletsContent'));
  assert.equal(state.node('CardScanPlaceholder'), undefined);
  assert.equal(state.node('ConfirmPopup'), undefined);
  assert.equal(state.scans.length, scans);
  assert.equal(state.inputs.length, inputs);
  assert.deepEqual(state.errors, []);
  assert.equal(
    state.events.some(event =>
      ['replace', 'restore', 'prepare', 'install'].includes(event.type),
    ),
    false,
  );
  state.click('Card menu');
  const reinstall = find(
    state.render(),
    node => node.type === 'Button' && text(node) === 'Reinstall Monoid Applet',
  );
  assert.equal(reinstall.props.disabled, false);
});

for (const [phase, checkpoint] of [
  ['ready', 'remove-monoid-instance'],
  ['replacing', undefined],
  ['restore', 'verify'],
  ['manual-restore', 'verify'],
]) {
  test(`Start over is unavailable for ${phase} with ${checkpoint ?? 'no'} checkpoint`, async () => {
    const state = mount({cardInformation: false});
    state.installation = installed(state.initialized);
    state.click('Scan a card');
    await state.tap();
    state.pending = {
      id: 'started',
      mode: 'reinstall',
      phase,
      checkpoint,
      card: {appletAid: AID, bundle: false},
      archive: {items: []},
    };
    state.click('Card menu');
    assert.equal(
      find(
        state.render(),
        node => node.type === 'Button' && text(node) === 'Start over',
      ),
      undefined,
    );
    assert.equal(
      state.events.some(event => event.type === 'discard-prepared'),
      false,
    );
  });
}

test('failed Start over keeps the recovery action and card visible', async () => {
  const state = mount({cardInformation: false});
  state.installation = installed(state.initialized);
  state.click('Scan a card');
  await state.tap();
  state.pending = {
    id: 'prepared',
    mode: 'reinstall',
    phase: 'ready',
    card: {appletAid: AID, bundle: false},
    archive: {items: []},
  };
  const saved = state.pending;
  state.discardError = new Error('Storage unavailable');
  state.click('Card menu');
  state.click('Start over');
  state.node('ConfirmPopup').props.onConfirm();
  await state.flush();
  assert.equal(state.pending, saved);
  assert.ok(state.node('CardAppletsContent'));
  assert.equal(
    text(state.node('ViewContent').props.footer),
    'Continue installation',
  );
  assert.equal(state.node('ViewContent').props.footer.props.disabled, false);
  assert.deepEqual(state.errors, [state.discardError]);
  assert.equal(state.scans.length, 1);
});
