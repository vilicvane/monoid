import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {observable, runInAction} from 'mobx';

import {
  CardBackupSession,
  assertBackupBundle,
  assertBackupCard,
  getBackupCardIdentity,
  readBackupCardIdentity,
} from '../.bld/app/@components/views/safe/@card/card-backup-session.js';
import {
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';
import {
  MonoidCardError,
  MonoidWrongCardError,
} from '../.bld/app/@lib/monoid/card-error.js';

let fixture;
let rendering;
const owners = [];
const PIN = 'Copy-42';

mock.module('react', {
  namedExports: {
    useMemo: create => rendering.slot(() => ({value: create()})).value,
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
  namedExports: Object.fromEntries(
    [
      'Check',
      'CircleAlert',
      'CircleCheck',
      'CreditCard',
      'Plus',
      'RotateCcw',
    ].map(name => [name, name]),
  ),
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
    isCredentialRequestCancelled: error => error?.code === 'CANCELLED',
  },
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {MonoidCardError, MonoidWrongCardError},
});
mock.module('../.bld/app/@components/@animations.js', {
  namedExports: {
    fadeInAnimationCSS: '',
    popInAnimationCSS: '',
    popOutAnimationCSS: '',
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanStatePromptContentHighlight: 'highlight',
    useMonoidScanPrompt: options => [
      null,
      (content, callback, validate) => {
        const scan = {
          content,
          callback,
          validate,
          options,
          finished: deferred(),
        };
        fixture.monoidScans.push(scan);
        return scan.finished.promise;
      },
    ],
  },
});
mock.module('../.bld/app/@components/@monoid/use-isodep-scan-prompt.js', {
  namedExports: {
    useIsoDepScanPrompt: () => (content, callback) => {
      const scan = {
        content,
        callback,
        finished: deferred(),
        controller: new AbortController(),
      };
      fixture.rawScans.push(scan);
      return scan.finished.promise;
    },
  },
});
mock.module('../.bld/app/@components/views/safe/@card/read-card-for-setup.js', {
  namedExports: {
    readCardForSetup: async (sessionId, applet, onStatus, signal) => {
      fixture.reads.push({sessionId, applet, signal});
      onStatus('Reading card information, hold tight...');
      return fixture.readPending
        ? fixture.readPending.promise
        : fixture.needsSetup
          ? {type: 'setup', cardInformation: fixture.cardInformation}
          : {type: 'ready', hello: fixture.hello};
    },
  },
});
mock.module('../.bld/app/@components/views/safe/@card/card-backup-session.js', {
  namedExports: {
    CardBackupSession: class extends CardBackupSession {
      constructor(...args) {
        super(...args);
        fixture.sessions.push(this);
      }
    },
    assertBackupCard,
    assertBackupBundle,
    getBackupCardIdentity,
    readBackupCardIdentity,
    initializeBackupTarget: async (...args) => {
      fixture.initializations.push(args);
      if (fixture.initializationPending) {
        await fixture.initializationPending.promise;
      }
      args[5]?.();
      args[4].throwIfAborted();
      return fixture.initializedHello;
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
        return input.finished.promise;
      },
    ],
  },
});
mock.module('../.bld/app/@components/@ui/toast.js', {
  namedExports: {useToast: () => value => fixture.toasts.push(value)},
});

const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);
for (const [path, names] of [
  ['@monoid/monoid-card', ['MonoidCard', 'MonoidCardFrame']],
  ['@ui/app-icon', ['AppIcon']],
  ['@ui/message-content', ['WarningMessage']],
  ['@ui/button', ['Button', 'Buttons']],
  ['@ui/centered-popup', ['CenteredPopup']],
  [
    '@ui/details-popup',
    ['DetailsPopup', 'DetailsPopupDivider', 'DetailsPopupTitle'],
  ],
  [
    '@ui/list',
    [
      'List',
      'ListItem',
      'ListItemContent',
      'ListItemDescription',
      'ListItemName',
    ],
  ],
  ['@ui/step', ['Step', 'Steps']],
  ['@ui/operation-complete', ['OperationComplete']],
  [
    '@view/index',
    [
      'View',
      'ViewContent',
      'ViewHeader',
      'ViewHeaderButton',
      'ViewHeaderTitle',
      'ViewPlaceholder',
    ],
  ],
  ['views/safe/@card/@resource-item', ['CardResourceItem', 'CardResourceList']],
]) {
  mock.module(`../.bld/app/@components/${path}.js`, {
    namedExports: {
      ...Object.fromEntries(names.map(name => [name, name])),
      ...(path === '@view/index' ? {useViewActive} : {}),
    },
  });
}

const {CopyItemsView} = await import(
  '../.bld/app/@components/views/safe/@card/copy-items-view.js'
);
const {CopyItemsStore} = await import(
  '../.bld/app/@services/copy-items-store.js'
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
  for (const child of Array.isArray(node)
    ? node
    : [node.props?.children, node.props?.footer]) {
    const result = find(child, predicate);
    if (result) return result;
  }
}

function hello(number, initialized = true, bundle = false) {
  return {
    id: Uint8Array.of(0, 0, 0, number),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(number)),
    bundle,
    pins: {access: initialized ? 5 : false, secret: initialized ? 5 : false},
  };
}

function mount({
  initialized = true,
  source = true,
  items,
  sourceIndexes,
  copyId = 'copy-flow',
  copyItemsStore = new CopyItemsStore(),
  needsSetup = false,
  sourceBundle = false,
  destinationBundle = false,
  canBackToCard = false,
  canBackToSafe = false,
} = {}) {
  const state = {
    slots: [],
    index: 0,
    sessions: [],
    rawScans: [],
    monoidScans: [],
    reads: [],
    inputs: [],
    initializations: [],
    routes: [],
    pinSessions: [],
    errors: [],
    toasts: [],
    progress: [],
    hello: hello(2, initialized, destinationBundle),
    initializedHello: hello(2, true, destinationBundle),
    needsSetup,
    cardInformation: {cardManagerAid: 'a000000151000000'},
    view: {
      $leaving: false,
      $match: {$exact: {$active: true}},
      copyId,
      sourceIndexes,
      sourceCard: source
        ? {
            ...readBackupCardIdentity(hello(1, true, sourceBundle)),
            items: items ?? [
              {index: '02400000000000000001', type: 'seed', secret: true},
            ],
          }
        : undefined,
    },
    slot: create => (state.slots[state.index++] ??= create()),
    render() {
      fixture = state;
      rendering = state;
      state.index = 0;
      state.tree = CopyItemsView({view: state.view});
      rendering = undefined;
      return state.tree;
    },
    async flush() {
      await setImmediate();
      state.render();
      await setImmediate();
    },
    click(label) {
      const button = find(
        state.render(),
        node => node.type === 'Button' && node.props.children === label,
      );
      assert.ok(button, `Expected button ${label}`);
      button.props.onClick();
    },
    async tapRaw() {
      const scan = state.rawScans.at(-1);
      try {
        await scan.callback(
          'destination-session',
          content => state.progress.push(content),
          scan.controller.signal,
        );
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
  state.view.$match.$exact = observable(state.view.$match.$exact);
  state.view.$match.$view = () => ({$entries: [state.view]});
  state.entrances = {
    router: {
      $backTo(target) {
        if (target === this.safe.card.$exact && canBackToCard) {
          return () => state.routes.push({type: 'back-to-card'});
        }

        if (target === this.safe.$exact && canBackToSafe) {
          return () => state.routes.push({type: 'back-to-safe'});
        }
      },
      safe: {
        $exact: {},
        card: {$exact: {}},
      },
      cardApplets: data => ({
        $push() {
          state.routes.push({type: 'setup', ...data});
          runInAction(() => (state.view.$match.$exact.$active = false));
        },
      }),
    },
    copyItemsStore,
    monoidApplet: {},
    monoidCredentialsStore: {
      createPINSession() {
        const session = {clear: mock.fn()};
        state.pinSessions.push(session);
        return session;
      },
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

test('adding a destination waits for scan cleanup and preserves the current Copy session', async () => {
  const state = mount();
  const session = state.sessions[0];
  await session.addTarget(hello(3));
  state.click('Scan another card');
  await state.tapRaw();
  assert.equal(session.backup.targets.length, 1);
  assert.equal(state.inputs.length, 0);
  assert.deepEqual(state.progress, ['Reading card information, hold tight...']);

  state.rawScans[0].finished.resolve();
  await state.flush();

  assert.equal(state.sessions.length, 1);
  assert.equal(session.backup.targets.length, 2);
  assert.deepEqual(session.backup.items, [
    {index: '02400000000000000001', type: 'seed', secret: true, selected: true},
  ]);
  assert.deepEqual(state.reads, [
    {
      sessionId: 'destination-session',
      applet: state.entrances.monoidApplet,
      signal: state.rawScans[0].controller.signal,
    },
  ]);
  assert.deepEqual(state.errors, []);
});

test('an uninstalled destination opens Setup only after scan cleanup and preserves Copy across remounts', async () => {
  const selectedIndex = '02400000000000000001';
  const state = mount({
    needsSetup: true,
    items: [
      {index: selectedIndex, type: 'seed', secret: true},
      {index: '03010000000000000002', type: 'secp256k1', secret: true},
    ],
    sourceIndexes: [selectedIndex],
  });
  const session = state.sessions[0];
  await session.addTarget(hello(3));
  const backup = session.backup;
  const source = backup.source;
  const target = backup.targets[0];
  state.click('Scan another card');
  await state.tapRaw();

  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.inputs, []);
  assert.equal(session.backup, backup);
  assert.equal(
    find(
      state.tree,
      node =>
        node.type === 'Button' && node.props.children === 'Continue to export',
    ).props.loading,
    true,
  );

  state.rawScans[0].finished.resolve();
  await state.flush();
  assert.deepEqual(state.routes, [
    {
      type: 'setup',
      cardInformation: state.cardInformation,
      copyId: state.view.copyId,
      returnTo: 'copy',
    },
  ]);
  assert.deepEqual(state.initializations, []);
  assert.deepEqual(state.monoidScans, []);
  state.unmount();
  assert.ok(state.pinSessions[0].clear.mock.callCount() > 0);

  // Setup hands the verified card to its originating flow before returning.
  const flow = state.entrances.copyItemsStore.get(state.routes[0].copyId);
  assert.equal(flow.session.backup, backup);
  await flow.session.addTarget(state.initializedHello);

  runInAction(() => (state.view.$match.$exact.$active = true));
  state.render();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.pinSessions.length, 2);
  assert.notEqual(state.pinSessions[0], state.pinSessions[1]);
  assert.equal(session.backup.source, source);
  assert.deepEqual(session.backup.targets[0], target);
  assert.equal(session.backup.targets.length, 2);
  assert.deepEqual(
    session.backup.items.map(item => [item.index, item.selected]),
    [
      [selectedIndex, true],
      ['03010000000000000002', false],
    ],
  );
  assert.equal(
    find(
      state.tree,
      node =>
        node.type === 'Button' && node.props.children === 'Continue to export',
    ).props.loading,
    false,
  );

  assert.equal(state.rawScans.length, 1);
  assert.equal(state.monoidScans.length, 0);
  assert.equal(
    session.backup.targets[1].publicKey,
    readBackupCardIdentity(state.initializedHello).publicKey,
  );
  assert.equal(state.sessions.length, 1);
  assert.deepEqual(state.errors, []);
});

test('a separate Copy route uses its own session while the original flow remains available', async () => {
  const first = mount({copyId: 'first-copy'});
  const firstSession = first.sessions[0];
  await firstSession.addTarget(hello(3));
  first.unmount();

  const second = mount({
    copyId: 'second-copy',
    copyItemsStore: first.entrances.copyItemsStore,
  });
  const secondSession = second.sessions[0];
  assert.notEqual(firstSession, secondSession);
  assert.equal(secondSession.backup.targets.length, 0);
  await secondSession.addTarget(hello(4));

  first.render();
  assert.equal(first.sessions.length, 1);
  assert.deepEqual(
    firstSession.backup.targets.map(target => target.id),
    [readBackupCardIdentity(hello(3)).id],
  );
  assert.deepEqual(
    secondSession.backup.targets.map(target => target.id),
    [readBackupCardIdentity(hello(4)).id],
  );
});

for (const phase of ['reading', 'cleanup']) {
  test(`cancelling an uninstalled destination during ${phase} does not open Setup and leaves Copy usable`, async () => {
    const state = mount({needsSetup: true});
    if (phase === 'reading') state.readPending = deferred();
    state.click('Scan destination card');
    const tapping = state.tapRaw();
    if (phase === 'cleanup') await tapping;

    const reason = Object.assign(new Error('Cancelled'), {code: 'CANCELLED'});
    state.rawScans[0].controller.abort(reason);
    state.rawScans[0].finished.reject(reason);
    state.readPending?.resolve({
      type: 'setup',
      cardInformation: state.cardInformation,
    });
    await tapping;
    await state.flush();

    assert.deepEqual(state.routes, []);
    assert.deepEqual(state.inputs, []);
    assert.equal(state.sessions[0].backup.targets.length, 0);
    assert.deepEqual(state.errors, []);
    assert.equal(
      find(
        state.tree,
        node =>
          node.type === 'Button' &&
          node.props.children === 'Scan destination card',
      ).props.loading,
      false,
    );
    state.readPending = undefined;
    state.click('Scan destination card');
    assert.equal(state.rawScans.length, 2);
    state.rawScans[1].finished.reject(reason);
    await state.flush();
  });
}

for (const destination of ['leaving', 'inactive', 'unmounted']) {
  test(`a destination needing Setup cannot navigate when Copy is ${destination}`, async () => {
    const state = mount({needsSetup: true});
    state.click('Scan destination card');
    await state.tapRaw();
    if (destination === 'leaving') state.view.$leaving = true;
    if (destination === 'inactive') {
      runInAction(() => (state.view.$match.$exact.$active = false));
    }
    if (destination === 'unmounted') state.unmount();
    state.rawScans[0].finished.resolve();
    await setImmediate();

    assert.deepEqual(state.routes, []);
    assert.deepEqual(state.inputs, []);
    assert.equal(state.sessions[0].backup.targets.length, 0);
    state.view.$leaving = false;
    runInAction(() => (state.view.$match.$exact.$active = true));
    state.render();
    assert.equal(
      find(
        state.tree,
        node =>
          node.type === 'Button' &&
          node.props.children === 'Scan destination card',
      ).props.loading,
      false,
    );
    assert.equal(state.sessions.length, 1);
  });
}

test('remounting while scan cleanup is pending ignores the old redirect and resets local busy state', async () => {
  const state = mount({needsSetup: true});
  state.click('Scan destination card');
  await state.tapRaw();
  state.unmount();
  state.render();
  assert.equal(
    find(
      state.tree,
      node =>
        node.type === 'Button' &&
        node.props.children === 'Scan destination card',
    ).props.loading,
    false,
  );
  state.rawScans[0].finished.resolve();
  await state.flush();
  assert.deepEqual(state.routes, []);
  assert.equal(state.sessions.length, 1);

  state.needsSetup = false;
  state.click('Scan destination card');
  await state.tapRaw();
  state.rawScans[1].finished.resolve();
  await state.flush();
  assert.equal(state.sessions[0].backup.targets.length, 1);
  assert.deepEqual(state.errors, []);
});

test('an installed destination continues its PIN initialization on the same Copy page', async () => {
  const state = mount({initialized: false});
  state.click('Scan destination card');
  await state.tapRaw();
  assert.equal(state.inputs.length, 0);
  state.rawScans[0].finished.resolve();
  await state.flush();

  assert.equal(state.inputs.length, 1);
  assert.equal(state.sessions[0].backup.targets.length, 0);
  state.inputs[0].finished.resolve(PIN);
  await state.flush();

  const scan = state.monoidScans[0];
  assert.equal(scan.options.ensureSetup, false);
  scan.validate(state.hello);
  await scan.callback({}, () => {}, state.hello, new AbortController().signal);
  scan.finished.resolve();
  await state.flush();

  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].backup.targets.length, 1);
  assert.equal(state.initializations[0][2], state.hello);
  assert.equal(state.initializations[0][3], PIN);
  assert.equal(state.rawScans.length, 1);
  assert.deepEqual(state.errors, []);

  const session = state.sessions[0];
  await session.confirmTargets();
  await session.exportItems(
    {
      authenticate: async () => {},
      exportItem: async () => ({data: Uint8Array.of(1)}),
    },
    hello(1),
    PIN,
    new AbortController().signal,
    () => {},
  );
  state.click('Scan a destination card');
  await state.flush();
  assert.equal(
    state.inputs.length,
    1,
    'the initialized Secret PIN is reused for import',
  );
  const importing = state.monoidScans.at(-1);
  importing.validate(state.initializedHello);
  const authentication = [];
  await importing.callback(
    {
      authenticate: async request => authentication.push(request),
      importItem: async () => {},
      list: async () => ({
        items: [
          {index: Uint8Array.from(Buffer.from('02400000000000000001', 'hex'))},
        ],
      }),
    },
    () => {},
    state.initializedHello,
    new AbortController().signal,
  );
  importing.finished.resolve();
  await state.flush();
  assert.deepEqual(authentication, [{secret: true, pin: PIN}]);
  assert.equal(session.backup.complete, true);
});

for (const phase of ['PIN input', 'initialization']) {
  test(`leaving and returning to Copy ignores a late destination ${phase} result and does not restore its PIN`, async () => {
    const state = mount({initialized: false});
    state.click('Scan destination card');
    await state.tapRaw();
    state.rawScans[0].finished.resolve();
    await state.flush();

    const input = state.inputs[0];
    let initializing;
    let scan;
    if (phase === 'initialization') {
      state.initializationPending = deferred();
      input.finished.resolve(PIN);
      await state.flush();
      scan = state.monoidScans[0];
      initializing = scan
        .callback({}, () => {}, state.hello, new AbortController().signal)
        .catch(error => error);
    }

    runInAction(() => (state.view.$match.$exact.$active = false));
    assert.equal(input.signal.aborted, true);
    runInAction(() => (state.view.$match.$exact.$active = true));
    if (phase === 'PIN input') {
      input.finished.resolve(PIN);
    } else {
      assert.equal(state.initializations[0][4].aborted, true);
      state.initializationPending.resolve();
      const error = await initializing;
      assert.equal(error.name, 'AbortError');
      scan.finished.reject(error);
    }
    await state.flush();

    assert.equal(state.monoidScans.length, phase === 'PIN input' ? 0 : 1);
    assert.equal(state.sessions[0].backup.targets.length, 0);
    assert.deepEqual(state.errors, []);

    const session = state.sessions[0];
    await session.addTarget(state.initializedHello);
    await session.confirmTargets();
    await session.exportItems(
      {
        authenticate: async () => {},
        exportItem: async () => ({data: Uint8Array.of(1)}),
      },
      hello(1),
      PIN,
      new AbortController().signal,
      () => {},
    );
    state.click('Scan a destination card');
    await state.flush();
    assert.equal(state.inputs.length, 2, 'returning requires a fresh PIN');
    state.inputs.at(-1).finished.resolve(undefined);
    await state.flush();
    assert.deepEqual(state.errors, []);
  });
}

test('a failed destination read preserves previously added cards and the source selection', async () => {
  const state = mount();
  const session = state.sessions[0];
  await session.addTarget(hello(3));
  const backup = session.backup;
  state.readPending = deferred();
  state.click('Scan another card');
  const tapping = state.tapRaw();
  const failure = new Error('Card management keys are unsupported');
  state.readPending.reject(failure);
  await tapping;

  assert.equal(state.sessions.length, 1);
  assert.equal(session.backup, backup);
  assert.equal(state.rawScans[0].error, failure);
  assert.deepEqual(state.inputs, []);
  assert.deepEqual(state.errors, [failure]);
});

for (const initialized of [true, false]) {
  test(`cancelling before a late destination hello does not ${initialized ? 'add a target' : 'prompt for a PIN'}`, async () => {
    const state = mount({initialized});
    state.readPending = deferred();
    state.click('Scan destination card');
    const tapping = state.tapRaw();
    const reason = Object.assign(new Error('Cancelled'), {code: 'CANCELLED'});
    state.rawScans[0].controller.abort(reason);
    state.rawScans[0].finished.reject(reason);
    state.readPending.resolve({type: 'ready', hello: state.hello});
    await tapping;
    await state.flush();

    assert.equal(state.sessions[0].backup.targets.length, 0);
    assert.deepEqual(state.inputs, []);
    assert.deepEqual(state.monoidScans, []);
    assert.deepEqual(state.errors, []);
    assert.equal(state.rawScans[0].error, reason);
  });
}

for (const destination of ['leaving', 'inactive', 'unmounted']) {
  test(`a completed destination scan does not continue when Copy is ${destination}`, async () => {
    const state = mount({initialized: false});
    state.click('Scan destination card');
    await state.tapRaw();
    if (destination === 'leaving') state.view.$leaving = true;
    if (destination === 'inactive') {
      runInAction(() => (state.view.$match.$exact.$active = false));
    }
    if (destination === 'unmounted') state.unmount();
    state.rawScans[0].finished.resolve();
    await setImmediate();

    assert.equal(state.sessions[0].backup.targets.length, 0);
    assert.deepEqual(state.inputs, []);
  });
}

test('a source card is rejected in the scan overlay without modifying Copy', async () => {
  const state = mount();
  state.hello = hello(1);
  state.click('Scan destination card');
  await state.tapRaw();

  assert.ok(state.rawScans[0].error instanceof MonoidCardError);
  assert.equal(state.rawScans[0].error.message, 'Use a different card');
  assert.equal(state.sessions[0].backup.targets.length, 0);
  assert.deepEqual(state.inputs, []);
  assert.deepEqual(state.errors, []);
});

test('a different destination bundle is rejected in the scan overlay before initialization', async () => {
  const state = mount({
    initialized: false,
    sourceBundle: new Uint8Array(32).fill(1),
    destinationBundle: new Uint8Array(32).fill(2),
  });
  state.click('Scan destination card');
  await state.tapRaw();

  assert.equal(
    state.rawScans[0].error.message,
    'Use a card in the same bundle',
  );
  assert.equal(state.sessions[0].backup.targets.length, 0);
  assert.deepEqual(state.inputs, []);
  assert.deepEqual(state.monoidScans, []);
  assert.deepEqual(state.errors, []);
});

test('reading a source still uses the ordinary authenticated scan and cannot install', async () => {
  const state = mount({source: false});
  state.click('Scan source card');

  assert.equal(state.rawScans.length, 0);
  assert.equal(state.monoidScans.length, 1);
  assert.equal(state.monoidScans[0].options.auth, 'access');
  assert.equal(state.monoidScans[0].options.ensureSetup, false);
  state.monoidScans[0].finished.reject(
    Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}),
  );
  await state.flush();
});

test('multi-card export advances for every transferred item and keeps the source card count aligned', async () => {
  const index = '02400000000000000001';
  const state = mount({
    items: [
      {index, type: 'seed', secret: true},
      {
        index: getCardDerivationItemIndex(index),
        type: 0x0f01,
        key: index,
        derivationRecord: {index, wallets: []},
        secret: false,
      },
    ],
  });
  const session = state.sessions[0];
  await session.addTarget(hello(2));
  await session.addTarget(hello(3));
  await session.confirmTargets();
  state.click('Scan source card');
  state.inputs[0].finished.resolve(PIN);
  await state.flush();
  const scan = state.monoidScans[0];
  const progress = [];
  const descriptions = [];
  scan.validate(hello(1));
  await scan.callback(
    {
      authenticate: async () => {},
      exportItem: async () => ({data: Uint8Array.of(1)}),
    },
    content => {
      if (typeof content === 'string') return;
      progress.push(content.props.value);
      const card = find(
        state.render(),
        node =>
          node.type === 'MonoidCard' &&
          node.props.id === session.backup.source.id,
      );
      descriptions.push(card.props.description);
    },
    hello(1),
    new AbortController().signal,
  );
  const exportStep = find(
    state.render(),
    node => node.type === 'Step' && node.props.numero === 3,
  );
  const importStep = find(
    state.tree,
    node => node.type === 'Step' && node.props.numero === 4,
  );
  assert.equal(exportStep.props.activeNumero, 3);
  assert.equal(exportStep.props.processing, true);
  assert.equal(importStep.props.activeNumero, 3);
  assert.equal(importStep.props.processing, false);

  scan.finished.resolve();
  await state.flush();

  const readyImportStep = find(
    state.tree,
    node => node.type === 'Step' && node.props.numero === 4,
  );
  assert.equal(readyImportStep.props.activeNumero, 4);
  assert.equal(readyImportStep.props.processing, false);
  assert.deepEqual(progress, ['0/4', '1/4', '2/4', '3/4', '4/4']);
  assert.deepEqual(descriptions, [
    'items 0/4',
    'items 1/4',
    'items 2/4',
    'items 3/4',
    'items 4/4',
  ]);
  assert.deepEqual(state.errors, []);
});

test('retrying a source export reuses its verified Secret PIN without automatically replaying the failed export', async () => {
  const state = mount();
  const session = state.sessions[0];
  await session.addTarget(hello(2));
  await session.confirmTargets();
  state.click('Scan source card');
  state.inputs.at(-1).finished.resolve(PIN);
  await state.flush();
  const firstScan = state.monoidScans.at(-1);
  const failure = new Error('Connection lost');
  let exports = 0;
  const applet = {
    authenticate: async request =>
      assert.deepEqual(request, {secret: true, pin: PIN}),
    exportItem: async () => {
      exports++;
      if (exports === 1) throw failure;
      return {data: Uint8Array.of(1)};
    },
  };
  firstScan.validate(hello(1));
  await assert.rejects(
    firstScan.callback(
      applet,
      () => {},
      hello(1),
      new AbortController().signal,
    ),
    error => error === failure,
  );
  firstScan.finished.reject(failure);
  await state.flush();
  assert.equal(exports, 1);
  assert.equal(state.monoidScans.length, 1);

  state.click('Scan source card');
  await state.flush();
  assert.equal(state.inputs.length, 1);
  const retry = state.monoidScans.at(-1);
  retry.validate(hello(1));
  await retry.callback(
    applet,
    () => {},
    hello(1),
    new AbortController().signal,
  );
  retry.finished.resolve();
  await state.flush();
  assert.equal(exports, 2);
  assert.equal(state.monoidScans.length, 2);
});

for (const {canBackToCard, canBackToSafe, backLabel, backRoute} of [
  {
    canBackToCard: true,
    canBackToSafe: true,
    backLabel: 'Back to Card',
    backRoute: 'back-to-card',
  },
  {
    canBackToCard: false,
    canBackToSafe: true,
    backLabel: 'Back to Safe',
    backRoute: 'back-to-safe',
  },
  {
    canBackToCard: false,
    canBackToSafe: false,
    backLabel: undefined,
    backRoute: undefined,
  },
]) {
  test(`single-item import reports progress and completes with ${backLabel ?? 'no return button'}`, async () => {
    const state = mount({canBackToCard, canBackToSafe});
    const session = state.sessions[0];
    await session.addTarget(hello(2));
    await session.confirmTargets();
    await session.exportItems(
      {
        authenticate: async () => {},
        exportItem: async () => ({data: Uint8Array.of(1)}),
      },
      hello(1),
      PIN,
      new AbortController().signal,
      () => {},
    );
    state.click('Scan a destination card');
    assert.equal(state.monoidScans.length, 0);
    state.inputs.at(-1).finished.resolve(PIN);
    await state.flush();
    const scan = state.monoidScans[0];
    assert.equal(scan.options.auth, undefined);
    const progress = [];
    const authentication = [];
    scan.validate(hello(2));
    await scan.callback(
      {
        authenticate: async request => authentication.push(request),
        importItem: async () => {},
        list: async () => {
          assert.equal(progress.at(-1), 'Checking card, hold tight...');
          assert.equal(session.backup.complete, false);
          return {
            items: [
              {
                index: Uint8Array.from(
                  Buffer.from('02400000000000000001', 'hex'),
                ),
              },
            ],
          };
        },
      },
      content =>
        progress.push(
          typeof content === 'string' ? content : content.props.value,
        ),
      hello(2),
      new AbortController().signal,
    );
    assert.equal(session.backup.complete, true);
    const pendingSteps = find(state.render(), node => node.type === 'Steps');
    assert.ok(pendingSteps);
    assert.equal(pendingSteps.props.$exiting, false);
    assert.equal(
      find(state.tree, node => node.type === 'Step' && node.props.numero === 4)
        .props.processing,
      true,
    );
    assert.equal(
      find(state.tree, node => node.type === 'OperationComplete'),
      undefined,
    );

    scan.finished.resolve();
    await state.flush();

    const exitingSteps = find(state.tree, node => node.type === 'Steps');
    assert.ok(exitingSteps);
    assert.equal(exitingSteps.props.$exiting, true);
    assert.equal(
      find(state.tree, node => node.type === 'OperationComplete'),
      undefined,
    );
    // A child spinner finishing must not end the steps' own exit animation.
    exitingSteps.props.onAnimationEnd({target: {}, currentTarget: {}});
    assert.ok(find(state.render(), node => node.type === 'Steps'));
    const element = {};
    exitingSteps.props.onAnimationEnd({
      target: element,
      currentTarget: element,
    });
    state.render();
    assert.equal(
      find(state.tree, node => node.type === 'Steps'),
      undefined,
    );
    assert.ok(find(state.tree, node => node.type === 'OperationComplete'));

    assert.deepEqual(authentication, [{secret: true, pin: PIN}]);
    assert.deepEqual(progress, ['Authenticating, hold tight...', '0/1', '1/1']);
    assert.equal(session.backup.complete, true);
    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.routes, []);

    const backButton = find(
      state.tree,
      node =>
        node.type === 'Button' &&
        ['Back to Card', 'Back to Safe'].includes(node.props.children),
    );
    if (backLabel) {
      assert.ok(backButton);
      assert.equal(backButton.props.children, backLabel);
      assert.equal(backButton.props.color, 'neutral');
      state.click(backLabel);
      await state.flush();
      assert.deepEqual(state.routes, [{type: backRoute}]);
      assert.equal(state.monoidScans.length, 1);
      assert.deepEqual(state.errors, []);
    } else {
      assert.equal(backButton, undefined);
    }
  });
}

for (const hasRecord of [true, false]) {
  test(`reading a Copy source ${hasRecord ? 'shows a single record count' : 'keeps the listing message without a count'}`, async () => {
    const state = mount({source: false});
    state.click('Scan source card');
    const scan = state.monoidScans[0];
    const index = '02400000000000000001';
    const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
    const progress = [];
    scan.validate(hello(1));
    await scan.callback(
      {
        list: async () => ({
          items: [
            {index: bytes(index), type: 'seed', secret: true},
            ...(hasRecord
              ? [
                  {
                    index: bytes(getCardDerivationItemIndex(index)),
                    key: bytes(index),
                    type: 0x0f01,
                    secret: false,
                  },
                ]
              : []),
          ],
        }),
        get: async () => ({
          data: encodeCardDerivationRecord({index, wallets: []}),
        }),
      },
      content =>
        progress.push(
          typeof content === 'string'
            ? content
            : [content.props.children, content.props.value],
        ),
      hello(1),
      new AbortController().signal,
    );
    scan.finished.resolve();
    await state.flush();

    assert.deepEqual(
      progress,
      hasRecord
        ? [
            'Reading items, hold tight...',
            ['Reading address records', '0/1'],
            ['Reading address records', '1/1'],
          ]
        : ['Reading items, hold tight...'],
    );
    assert.ok(state.sessions[0].backup);
    assert.deepEqual(state.errors, []);
  });
}
