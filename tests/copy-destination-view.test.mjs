import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {
  MonoidCardError,
  MonoidWrongCardError,
} from '../.bld/app/@lib/monoid/card-error.js';
import {
  CardBackupSession,
  assertBackupCard,
  getBackupCardIdentity,
  readBackupCardIdentity,
} from '../.bld/app/@components/views/safe/@card/card-backup-session.js';
import {
  encodeCardDerivationRecord,
  getCardDerivationItemIndex,
} from '../.bld/app/@components/views/safe/card-derivations.js';

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
  namedExports: {fadeInAnimationCSS: '', popInAnimationCSS: ''},
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
mock.module(
  '../.bld/app/@components/views/safe/@card/read-copy-destination.js',
  {
    namedExports: {
      readCopyDestination: async (sessionId, applet, onProgress, signal) => {
        fixture.reads.push({sessionId, applet, signal});
        onProgress({stage: 'monoid', phase: 'uploading', progress: 0.4});
        return fixture.readPending
          ? fixture.readPending.promise
          : fixture.hello;
      },
    },
  },
);
mock.module('../.bld/app/@components/views/safe/@card/card-backup-session.js', {
  namedExports: {
    CardBackupSession: class extends CardBackupSession {
      constructor(...args) {
        super(...args);
        fixture.sessions.push(this);
      }
    },
    assertBackupCard,
    getBackupCardIdentity,
    readBackupCardIdentity,
    initializeBackupTarget: async (...args) => {
      fixture.initializations.push(args);
      return fixture.initializedHello;
    },
  },
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {
    useInputModal: () => [
      null,
      options => {
        const input = {options, finished: deferred()};
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
  ['@monoid/applet-install-progress', ['AppletInstallProgressContent']],
  ['@monoid/monoid-card', ['MonoidCard', 'MonoidCardFrame']],
  ['@ui/app-icon', ['AppIcon']],
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

function hello(number, initialized = true) {
  return {
    id: Uint8Array.of(0, 0, 0, number),
    pin: initialized ? 5 : false,
    safe: {
      id: Uint8Array.of(1, 0, 0, number),
      publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(number)),
      pin: initialized ? 5 : false,
      unlocked: initialized,
    },
  };
}

function mount({initialized = true, source = true, items} = {}) {
  const state = {
    slots: [],
    index: 0,
    sessions: [],
    rawScans: [],
    monoidScans: [],
    reads: [],
    inputs: [],
    initializations: [],
    errors: [],
    toasts: [],
    progress: [],
    hello: hello(2, initialized),
    initializedHello: hello(2),
    view: {
      $leaving: false,
      $match: {$exact: {$active: true}},
      sourceCard: source
        ? {
            ...readBackupCardIdentity(hello(1)),
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
  state.view.$match.$view = () => ({$entries: [state.view]});
  state.entrances = {
    router: {$backTo: () => undefined, safe: {$exact: {}}},
    monoidApplet: {},
    monoidCredentialsStore: {createPINSession: () => ({clear() {}})},
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
  assert.equal(state.progress[0].type, 'AppletInstallProgressContent');

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

test('a newly installed destination continues its PIN initialization on the same Copy page', async () => {
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
});

test('a failed destination installation preserves previously added cards and the source selection', async () => {
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
    state.readPending.resolve(state.hello);
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
    if (destination === 'inactive') state.view.$match.$exact.$active = false;
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
      if (content.props.value !== '4/4')
        descriptions.push(card.props.description);
    },
    hello(1),
    new AbortController().signal,
  );
  scan.finished.resolve();
  await state.flush();

  assert.deepEqual(progress, ['0/4', '1/4', '2/4', '3/4', '4/4']);
  assert.deepEqual(descriptions, [
    'Items · 0/4',
    'Items · 1/4',
    'Items · 2/4',
    'Items · 3/4',
  ]);
  assert.deepEqual(state.errors, []);
});

test('single-item import shows the count and changes to Checking card during final verification', async () => {
  const state = mount();
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
  const scan = state.monoidScans[0];
  const progress = [];
  scan.validate(hello(2));
  await scan.callback(
    {
      importItem: async () => {},
      list: async () => {
        assert.equal(progress.at(-1), 'Checking card...');
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
  scan.finished.resolve();
  await state.flush();

  assert.deepEqual(progress, ['0/1', '1/1', 'Checking card...']);
  assert.equal(session.backup.complete, true);
  assert.deepEqual(state.errors, []);
});

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
            'Reading items...',
            ['Reading address records', '0/1'],
            ['Reading address records', '1/1'],
          ]
        : ['Reading items...'],
    );
    assert.ok(state.sessions[0].backup);
    assert.deepEqual(state.errors, []);
  });
}
