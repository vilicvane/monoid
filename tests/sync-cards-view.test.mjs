import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {observable, runInAction} from 'mobx';

import {readBackupCardIdentity} from '../.bld/app/@components/views/safe/@card/card-backup-session.js';
import {
  MonoidCardError,
  MonoidWrongCardError,
} from '../.bld/app/@lib/monoid/card-error.js';
import {CardStore} from '../.bld/app/@services/card-store.js';

let fixture;
let rendering;
const owners = [];
const PIN = 'Sync-42';

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
    useEffect(effect, dependencies) {
      const slot = rendering.slot(() => ({}));
      if (
        !slot.dependencies ||
        dependencies?.some((value, index) => value !== slot.dependencies[index])
      ) {
        slot.cleanup?.();
        slot.dependencies = dependencies;
        slot.cleanup = effect();
      }
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
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('lucide-react', {
  namedExports: {Plus: 'Plus', RotateCcw: 'RotateCcw'},
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
mock.module('../.bld/app/@components/@animations.js', {
  namedExports: {popOutAnimationCSS: ''},
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanStatePromptContentHighlight: 'highlight',
    MonoidScanStatePromptProgress: 'progress',
    useMonoidScanPrompt(options) {
      const state = fixture;
      return [
        null,
        (content, callback, validate) => {
          const scan = {
            content,
            callback,
            validate,
            options,
            finished: deferred(),
            controller: new AbortController(),
            closed: false,
          };
          state.scans.push(scan);
          return scan.finished.promise;
        },
      ];
    },
  },
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {
    useInputModal() {
      const state = fixture;
      return [
        null,
        options => {
          const input = {options, finished: deferred()};
          state.inputs.push(input);
          return input.finished.promise;
        },
      ];
    },
  },
});
mock.module('../.bld/app/@components/@ui/toast.js', {
  namedExports: {useToast: () => value => fixture.toasts.push(value)},
});
mock.module('../.bld/app/@components/views/safe/scan-card.js', {
  namedExports: {
    readCardAddressPreviews: async (
      applet,
      items,
      _progress,
      signal,
      knownItems,
      localKeys,
    ) => {
      fixture.previewSignals.push(signal);
      fixture.previewApplets.push(applet);
      fixture.previewRecords.push(items);
      fixture.previewKnownItems.push(knownItems);
      fixture.previewLocalKeys.push(localKeys);
      if (fixture.previewFailure) throw fixture.previewFailure;
      signal.throwIfAborted();
      return fixture.previewItems;
    },
  },
});

const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);
for (const [path, names] of [
  [
    '@monoid/card-preview',
    ['CardGrid', 'CardPlaceholder', 'CardPreview', 'CardPreviewButton'],
  ],
  ['@ui/app-icon', ['AppIcon']],
  ['@ui/button', ['Button', 'Buttons']],
  ['@ui/confirm-popup', ['ConfirmPopup']],
  [
    '@ui/details-popup',
    ['DetailsPopup', 'DetailsPopupDivider', 'DetailsPopupTitle'],
  ],
  ['@ui/step', ['Step', 'Steps']],
  ['@ui/message-content', ['InfoMessage']],
  ['@ui/operation-complete', ['OperationComplete']],
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
  ['views/safe/@card/@resource-item', ['CardResourceItem', 'CardResourceList']],
]) {
  mock.module(`../.bld/app/@components/${path}.js`, {
    namedExports: {
      ...Object.fromEntries(names.map(name => [name, name])),
      ...(path === '@view/index' ? {useViewActive} : {}),
    },
  });
}

const {SyncCardsView} = await import(
  '../.bld/app/@components/views/safe/@card/sync-cards-view.js'
);
const {SyncCardsStore} = await import(
  '../.bld/app/@services/sync-cards-store.js'
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

function hello(number, bundle = false) {
  return {
    version: 1,
    id: Uint8Array.of(0, 0, 0, number),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(number)),
    bundle,
    pins: {access: 5, secret: 5},
  };
}

const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const signal = () => new AbortController().signal;
const emptyCard = {
  authenticate: async request => {
    assert.deepEqual(request, {secret: true, pin: PIN});
  },
  list: async () => ({items: []}),
};
const cancelled = () =>
  Object.assign(new Error('Cancelled'), {code: 'CANCELLED'});

function publicCard(number) {
  const items = new Map([
    [
      `0fff000000000000000${number}`,
      {type: 0x0fff, secret: false, data: Uint8Array.of(number)},
    ],
  ]);
  const requests = [];
  const authentications = [];
  return {
    hello: hello(number),
    requests,
    authentications,
    applet: {
      authenticate: async request => {
        assert.deepEqual(request, {secret: true, pin: PIN});
        authentications.push(request);
      },
      list: async () => ({
        items: [...items].map(([index, {data: _data, ...item}]) => ({
          ...item,
          index: bytes(index),
        })),
      }),
      get: async ({index}) => ({data: items.get(hex(index)).data}),
      view: async ({index}) => {
        const {data: _data, type: _type, ...item} = items.get(hex(index));
        return item;
      },
      create: async ({index, ...item}) => {
        assert.equal(items.has(hex(index)), false);
        requests.push(['create', hex(index)]);
        items.set(hex(index), {
          ...item,
          type: 0x0fff,
          secret: item.secret ?? false,
        });
        return {index};
      },
      set: async ({index, ...item}) => {
        requests.push(['set', hex(index)]);
        items.set(hex(index), {...items.get(hex(index)), ...item});
        return {};
      },
    },
  };
}

function mount({
  source,
  canBack = true,
  canBackToCard = !!source,
  canBackToSafe = true,
  store = new SyncCardsStore(),
  syncId = 'sync-flow',
} = {}) {
  const state = {
    slots: [],
    index: 0,
    scans: [],
    inputs: [],
    errors: [],
    toasts: [],
    backs: [],
    previewSignals: [],
    previewApplets: [],
    previewRecords: [],
    previewKnownItems: [],
    previewLocalKeys: [],
    previewItems: [],
    localKeys: [],
    progress: [],
    mounted: true,
    slot: create => (state.slots[state.index++] ??= create()),
    render() {
      fixture = state;
      rendering = state;
      state.index = 0;
      state.tree = SyncCardsView({view: state.view});
      rendering = undefined;
      return state.tree;
    },
    async flush() {
      await setImmediate();
      if (state.mounted) state.render();
      await setImmediate();
    },
    button(label) {
      return find(
        state.render(),
        node => node.type === 'Button' && node.props.children === label,
      );
    },
    click(label) {
      const button = state.button(label);
      assert.ok(button, `Expected button ${label}`);
      assert.notEqual(button.props.disabled, true, `${label} is disabled`);
      button.props.onClick();
    },
    async startScan(label, pin = PIN) {
      const scanCount = state.scans.length;
      const inputCount = state.inputs.length;
      state.click(label);
      assert.equal(state.scans.length, scanCount, 'PIN precedes NFC');
      assert.equal(state.inputs.length, inputCount + 1);
      state.inputs.at(-1).finished.resolve(pin);
      await state.flush();
      assert.equal(state.scans.length, scanCount + 1);
      assert.equal(state.scans.at(-1).options.auth, false);
    },
    async startWriteScan() {
      await state.startScan('Scan a pending card');
    },
    async tap(cardHello, applet = emptyCard) {
      const scan = state.scans.at(-1);
      try {
        scan.validate?.(cardHello);
        scan.result = await scan.callback(
          applet,
          content => state.progress.push(content),
          cardHello,
          scan.controller.signal,
        );
      } catch (error) {
        scan.error = error;
        scan.closed = true;
        scan.finished.reject(error);
      }
      await state.flush();
      return scan;
    },
    async finishScan() {
      const scan = state.scans.at(-1);
      scan.closed = true;
      scan.finished.resolve();
      await state.flush();
    },
    unmount() {
      state.mounted = false;
      state.slots.splice(0).forEach(slot => slot.cleanup?.());
    },
  };
  state.view = observable({
    $leaving: false,
    $match: {
      $exact: {$active: true},
      $view: () => ({$entries: state.mounted ? [state.view] : []}),
    },
    syncId,
    card: source && {id: source.id, publicKey: source.publicKey},
  });
  const cardStore = new CardStore();
  if (source) cardStore.set(source);
  const safeRoute = {$exact: {}, card: {$exact: {}}};
  state.entrances = {
    walletStorageService: {keys: state.localKeys},
    router: {
      $backTo: target =>
        canBack &&
        ((target === safeRoute.card.$exact && canBackToCard) ||
          (target === safeRoute.$exact && canBackToSafe))
          ? () => state.backs.push(target)
          : undefined,
      safe: safeRoute,
    },
    cardStore,
    syncCardsStore: store,
    monoidCredentialsStore: {
      createPINSession() {
        assert.fail('Sync must not open an Access PIN vault session');
      },
    },
    errorService: {
      catch: promise => promise.catch(error => state.errors.push(error)),
    },
  };
  owners.push(state);
  state.render();
  state.flow = store.getOrCreate(syncId, () =>
    assert.fail('The view must create the flow'),
  );
  state.session = state.flow.session;
  return state;
}

afterEach(() => owners.splice(0).forEach(owner => owner.unmount()));

test('opening from Card keeps its preview but requires a fresh authenticated read', async () => {
  const source = {...readBackupCardIdentity(hello(1)), items: []};
  const state = mount({source});
  assert.equal(state.session.cards.length, 0);
  assert.equal(state.scans.length, 0);
  assert.equal(state.inputs.length, 0);
  assert.ok(
    find(
      state.tree,
      node =>
        node.type === 'CardPreview' &&
        node.props.description === 'scan to read',
    ),
  );

  await state.startScan('Scan card');
  const scan = state.scans[0];
  assert.equal(scan.options.auth, false);
  assert.equal(scan.options.ensureSetup, false);
  assert.equal(scan.options.retryOnError, false);
  assert.throws(() => scan.validate(hello(2)), MonoidWrongCardError);
  assert.throws(
    () => scan.validate({...hello(1), publicKey: hello(2).publicKey}),
    MonoidWrongCardError,
  );
  assert.throws(
    () => scan.validate({...hello(1), bundle: new Uint8Array(32).fill(1)}),
    /bundle changed/,
  );
  await state.tap(hello(1));
  assert.equal(state.session.cards.length, 1);
  await state.finishScan();
  assert.equal(state.flow.sourceConsumed, true);
  assert.ok(state.button('Add another card'));
});

test('collecting cards preserves the original Card cache without loading address previews', async () => {
  const first = publicCard(1);
  const second = publicCard(2);
  const source = {
    ...readBackupCardIdentity(first.hello),
    items: [
      {
        index: '0fff0000000000000001',
        type: 0x0fff,
        secret: false,
        publicKey: `04${'02'.repeat(64)}`,
      },
    ],
  };
  const state = mount({source});
  const cached = state.entrances.cardStore.get(source);
  const previous = cached.snapshot();
  await state.startScan('Scan card');
  await state.tap(first.hello, first.applet);
  await state.finishScan();
  await state.startScan('Add another card');
  await state.tap(second.hello, second.applet);
  await state.finishScan();

  assert.equal(state.session.cards.length, 2);
  assert.equal(state.entrances.cardStore.get(source), cached);
  assert.deepEqual(cached.snapshot(), previous);
  assert.equal(
    state.entrances.cardStore.get(readBackupCardIdentity(second.hello)),
    undefined,
  );
  assert.equal(state.previewSignals.length, 0);
  assert.deepEqual(state.toasts, []);
});

test('cancelling the known source Secret PIN does not start NFC or collect cached data', async () => {
  const source = {
    ...readBackupCardIdentity(hello(1, new Uint8Array(32).fill(1))),
    items: [{index: '02400000000000000001', type: 'seed', secret: true}],
  };
  const state = mount({source});
  state.click('Scan card');
  assert.equal(state.inputs.length, 1);
  assert.equal(state.scans.length, 0);
  state.inputs[0].finished.resolve(undefined);
  await state.flush();
  assert.equal(state.scans.length, 0);
  assert.equal(state.session.cards.length, 0);
  assert.equal(state.flow.sourceConsumed, false);
});

test('a wrong-card scan uses the shared error handler without adding page content or an extra step connector', async () => {
  const source = {...readBackupCardIdentity(hello(1)), items: []};
  const state = mount({source});
  await state.startScan('Scan card');
  const scan = await state.tap(hello(2), {
    authenticate: () => assert.fail('Validate card before authenticating'),
  });
  assert.ok(scan.error instanceof MonoidWrongCardError);
  assert.deepEqual(state.errors, [scan.error]);
  assert.equal(
    find(state.tree, node => node.props?.role === 'status'),
    undefined,
  );
  const steps = find(state.tree, node => node.type === 'Steps');
  assert.equal(steps.props.children.length, 2);
  assert.ok(steps.props.children.every(node => node.type === 'Step'));
});

test('adding an unknown card requests Secret PIN before NFC and authenticates before reading in one scan', async () => {
  const state = mount();
  const target = hello(2, new Uint8Array(32).fill(1));
  const calls = [];
  await state.startScan('Add a card');
  await state.tap(target, {
    authenticate: async request => {
      assert.deepEqual(request, {secret: true, pin: PIN});
      calls.push('authenticate');
    },
    list: async () => {
      calls.push('list');
      return {items: []};
    },
  });
  assert.equal(state.scans[0].error, undefined);
  assert.deepEqual(calls, ['authenticate', 'list']);
  assert.equal(state.session.cards.length, 1);
  await state.finishScan();
  assert.equal(state.inputs.length, 1);
  assert.equal(state.scans.length, 1);
  assert.equal(state.scans[0].options.auth, false);
  assert.ok(state.button('Add another card'));
});

for (const phase of ['leaving', 'inactive', 'unmounted']) {
  test(`resolving an add Secret PIN after the view is ${phase} does not open NFC`, async () => {
    const state = mount();
    state.click('Add a card');
    assert.equal(state.inputs.length, 1);
    if (phase === 'leaving')
      runInAction(() => {
        state.view.$leaving = true;
      });
    if (phase === 'inactive')
      runInAction(() => {
        state.view.$match.$exact.$active = false;
      });
    if (phase === 'unmounted') state.unmount();
    state.inputs[0].finished.resolve(PIN);
    await state.flush();
    assert.equal(state.scans.length, 0);
    assert.equal(state.session.cards.length, 0);
  });
}

test('leaving while a card callback is active aborts its work before later preview commands', async t => {
  const state = mount();
  const pending = deferred();
  let activeSignal;
  t.mock.method(
    state.session,
    'add',
    async (_applet, _hello, operationSignal) => {
      activeSignal = operationSignal;
      await pending.promise;
      operationSignal.throwIfAborted();
    },
  );
  await state.startScan('Add a card');
  const tapping = state.tap(hello(1));
  await setImmediate();
  assert.equal(activeSignal.aborted, false);
  runInAction(() => {
    state.view.$match.$exact.$active = false;
  });
  assert.equal(activeSignal.aborted, true);
  pending.resolve();
  await tapping;
  assert.equal(state.previewSignals.length, 0);
  assert.equal(state.session.cards.length, 0);
});

test('a write ACK arriving after unmount retains progress and invalidates the stale Card cache', async () => {
  const first = publicCard(1);
  const second = publicCard(2);
  const source = {...readBackupCardIdentity(first.hello), items: []};
  const state = mount({source});
  await state.session.add(first.applet, first.hello, signal(), PIN);
  await state.session.add(second.applet, second.hello, signal(), PIN);
  state.flow.consumeSource();
  state.session.prepare();
  const started = deferred();
  const response = deferred();
  const create = first.applet.create;
  first.applet.create = async request => {
    started.resolve();
    await response.promise;
    return create(request);
  };

  await state.startWriteScan();
  const tapping = state.tap(first.hello, first.applet);
  await started.promise;
  state.unmount();
  response.resolve();
  await tapping;
  assert.equal(state.session.cards[0].completed, 1);
  assert.equal(state.session.cards[0].complete, true);
  assert.equal(state.entrances.cardStore.get(source), undefined);
  assert.deepEqual(
    state.session.confirmedSnapshot.items.map(item => item.index),
    ['0fff0000000000000001', '0fff0000000000000002'],
  );
  assert.equal(state.previewSignals.length, 0);
  assert.equal(state.scans[0].error, undefined);
});

test('only writing the original Card reloads its addresses and restores the complete cache', async () => {
  const first = publicCard(1);
  const second = publicCard(2);
  const source = {
    ...readBackupCardIdentity(first.hello),
    items: [
      {
        index: '0fff0000000000000001',
        type: 0x0fff,
        secret: false,
        publicKey: `04${'02'.repeat(64)}`,
      },
    ],
  };
  const state = mount({source});
  state.localKeys.push({
    type: 'secp256k1',
    index: '03010000000000000001',
    wallets: [{addressType: 'evm', publicKey: `02${'11'.repeat(32)}`}],
  });
  await state.session.add(first.applet, first.hello, signal(), PIN);
  await state.session.add(second.applet, second.hello, signal(), PIN);
  state.flow.consumeSource();
  const otherIdentity = readBackupCardIdentity(second.hello);
  state.entrances.cardStore.set({...otherIdentity, items: []});
  state.session.prepare();

  await state.startWriteScan();
  await state.tap(second.hello, second.applet);
  await state.finishScan();
  assert.equal(state.previewSignals.length, 0);
  assert.equal(state.entrances.cardStore.get(otherIdentity), undefined);
  assert.ok(state.entrances.cardStore.get(source));

  state.previewItems = [
    {
      index: '0fff0000000000000001',
      type: 0x0fff,
      secret: false,
      publicKey: `04${'02'.repeat(64)}`,
    },
    {index: '0fff0000000000000002', type: 0x0fff, secret: false},
  ];
  first.applet.list = () => assert.fail('Confirmed writes must not relist');
  first.applet.get = () => assert.fail('Confirmed records must not be reread');
  await state.startWriteScan();
  await state.tap(first.hello, first.applet);
  await state.finishScan();
  assert.equal(state.session.phase, 'complete');
  assert.deepEqual(state.previewApplets, [first.applet]);
  assert.deepEqual(state.previewRecords, [
    state.session.confirmedSnapshot.items,
  ]);
  assert.deepEqual(state.previewKnownItems, [
    [{...source.items[0], derivations: []}],
  ]);
  assert.equal(state.previewLocalKeys.length, 1);
  assert.equal(state.previewLocalKeys[0], state.localKeys);
  assert.deepEqual(state.entrances.cardStore.get(source).snapshot(), {
    ...readBackupCardIdentity(first.hello),
    items: state.previewItems,
  });
  assert.equal(state.entrances.cardStore.get(otherIdentity), undefined);
  assert.equal(state.button('Back to Safe'), undefined);
  const back = state.button('Back to Card');
  assert.ok(back);
  assert.equal(back.props.color, 'neutral');
  back.props.onClick();
  assert.deepEqual(state.backs, [state.entrances.router.safe.card.$exact]);
});

test('an operation failing before a new snapshot does not overwrite a richer CardStore preview', async t => {
  const card = publicCard(1);
  const source = {
    ...readBackupCardIdentity(card.hello),
    items: [
      {
        index: '0fff0000000000000001',
        type: 0x0fff,
        secret: false,
        publicKey: `04${'02'.repeat(64)}`,
      },
    ],
  };
  const state = mount({source});
  await state.session.add(card.applet, card.hello, signal(), PIN);
  const previousSnapshot = state.session.confirmedSnapshot;
  const stored = state.entrances.cardStore.get(source);
  t.mock.method(state.session, 'add', async () => {
    throw new MonoidCardError('Read failed');
  });

  await state.startScan('Scan card');
  await state.tap(card.hello, card.applet);
  assert.equal(state.session.confirmedSnapshot, previousSnapshot);
  assert.equal(state.entrances.cardStore.get(source), stored);
  assert.equal(stored.items[0].publicKey, source.items[0].publicKey);
});

test('the second round accepts pending cards in either order and completes only after scan cleanup', async () => {
  const state = mount();
  const first = publicCard(1);
  const second = publicCard(2);
  await state.session.add(first.applet, first.hello, signal(), PIN);
  await state.session.add(second.applet, second.hello, signal(), PIN);
  state.click('Continue');
  await state.flush();
  assert.equal(state.session.phase, 'write');

  await state.startWriteScan();
  await state.tap(second.hello, second.applet);
  await state.finishScan();
  assert.equal(state.session.cards[1].complete, true);
  assert.equal(state.session.cards[0].complete, false);
  assert.deepEqual(second.requests, [['create', '0fff0000000000000001']]);
  assert.equal(second.authentications.length, 2);
  assert.equal(state.inputs.length, 1);

  await state.startWriteScan();
  await state.tap(first.hello, first.applet);
  assert.equal(state.session.phase, 'complete');
  assert.equal(state.button('Back to Safe'), undefined);
  assert.equal(
    find(state.tree, node => node.type === 'OperationComplete'),
    undefined,
  );
  await state.finishScan();
  const back = state.button('Back to Safe');
  assert.ok(back);
  assert.equal(back.props.color, 'neutral');
  assert.deepEqual(state.backs, []);

  const steps = find(state.tree, node => node.type === 'Steps');
  assert.equal(steps.props.$exiting, true);
  steps.props.onAnimationEnd({target: {}, currentTarget: {}});
  assert.equal(state.flow.stepsExited, false);
  const element = {};
  steps.props.onAnimationEnd({target: element, currentTarget: element});
  assert.ok(find(state.render(), node => node.type === 'OperationComplete'));
  back.props.onClick();
  assert.equal(state.backs.length, 1);
  assert.equal(state.previewSignals.length, 0);
  assert.equal(
    state.entrances.cardStore.get(readBackupCardIdentity(first.hello)),
    undefined,
  );
  assert.equal(
    state.entrances.cardStore.get(readBackupCardIdentity(second.hello)),
    undefined,
  );
});

test('cancelling the write Secret PIN leaves NFC and card data untouched', async () => {
  const state = mount();
  const first = publicCard(1);
  const second = publicCard(2);
  await state.session.add(first.applet, first.hello, signal(), PIN);
  await state.session.add(second.applet, second.hello, signal(), PIN);
  state.session.prepare();
  state.click('Scan a pending card');
  assert.equal(state.inputs.length, 1);
  assert.equal(state.scans.length, 0);
  state.inputs[0].finished.resolve(undefined);
  await state.flush();
  assert.equal(state.scans.length, 0);
  assert.deepEqual(first.authentications, [{secret: true, pin: PIN}]);
  assert.equal(state.session.cards[0].completed, 0);
});

test('collection verifies each card PIN once and arbitrary write order reuses the matching PIN', async () => {
  const state = mount();
  const cards = [publicCard(1), publicCard(2)];
  const pins = ['First-42', 'Second-42'];
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index];
    card.applet.authenticate = async request => {
      assert.deepEqual(request, {secret: true, pin: pins[index]});
      card.authentications.push(request);
    };
    await state.startScan(
      index ? 'Add another card' : 'Add a card',
      pins[index],
    );
    await state.tap(card.hello, card.applet);
    await state.finishScan();
  }
  state.click('Continue');
  await state.flush();
  for (const card of [...cards].reverse()) {
    state.click('Scan a pending card');
    await state.flush();
    assert.equal(
      state.inputs.length,
      2,
      'the write round must not ask for PINs again',
    );
    await state.tap(card.hello, card.applet);
    await state.finishScan();
    assert.equal(
      card.authentications.length,
      2,
      'each new tap still authenticates',
    );
  }
  assert.equal(state.session.phase, 'complete');
});

test('leaving Sync clears verified PINs while keeping the collected cards', async () => {
  const state = mount();
  const first = publicCard(1);
  const second = publicCard(2);
  for (const [card, label] of [
    [first, 'Add a card'],
    [second, 'Add another card'],
  ]) {
    await state.startScan(label);
    await state.tap(card.hello, card.applet);
    await state.finishScan();
  }
  state.click('Continue');
  await state.flush();
  runInAction(() => {
    state.view.$match.$exact.$active = false;
  });
  runInAction(() => {
    state.view.$match.$exact.$active = true;
  });
  await state.startWriteScan();
  assert.equal(state.inputs.length, 3);
  assert.equal(state.session.cards.length, 2);
  state.scans
    .at(-1)
    .finished.reject(
      Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}),
    );
  await state.flush();
});

for (const alreadyWritten of [false, true]) {
  test(`an ${alreadyWritten ? 'already synced' : 'unchanged'} card skips authentication, reads and previews`, async t => {
    const state = mount();
    const first = publicCard(1);
    const second = publicCard(2);
    await state.session.add(first.applet, first.hello, signal(), PIN);
    await state.session.add(second.applet, second.hello, signal(), PIN);
    if (!alreadyWritten) {
      await second.applet.create({
        index: bytes('0fff0000000000000001'),
        secret: false,
        data: Uint8Array.of(1),
      });
      await state.session.add(second.applet, second.hello, signal(), PIN);
    }
    state.session.prepare();
    if (alreadyWritten)
      await state.session.write(second.applet, second.hello, signal(), PIN);
    assert.equal(state.session.cards[1].complete, true);
    const write = t.mock.method(state.session, 'write', () =>
      assert.fail('Already synced card must skip write'),
    );
    await state.startWriteScan();
    const scan = await state.tap(second.hello, {});
    assert.equal(scan.error, undefined);
    assert.deepEqual(scan.result, {message: 'Already synced'});
    assert.equal(write.mock.callCount(), 0);
    assert.equal(state.previewSignals.length, 0);
    await state.finishScan();
    assert.ok(state.button('Scan a pending card'));
  });
}

test('a lost card preserves another card already synced and keeps the pending scan available', async () => {
  const state = mount();
  const first = publicCard(1);
  const second = publicCard(2);
  await state.session.add(first.applet, first.hello, signal(), PIN);
  await state.session.add(second.applet, second.hello, signal(), PIN);
  state.session.prepare();
  await state.session.write(second.applet, second.hello, signal(), PIN);
  await state.startWriteScan();
  const scan = state.scans.at(-1);
  scan.controller.abort(cancelled());
  scan.finished.reject(cancelled());
  await state.flush();
  assert.equal(state.session.cards[1].complete, true);
  assert.equal(state.session.cards[0].complete, false);
  assert.ok(state.button('Scan a pending card'));
});

test('a failed original-card address preview retains completion and requires a fresh Card scan', async () => {
  const first = publicCard(1);
  const second = publicCard(2);
  const source = {...readBackupCardIdentity(first.hello), items: []};
  const state = mount({source});
  await state.session.add(first.applet, first.hello, signal(), PIN);
  await state.session.add(second.applet, second.hello, signal(), PIN);
  state.flow.consumeSource();
  state.session.prepare();
  await state.session.write(second.applet, second.hello, signal(), PIN);
  state.previewFailure = new Error('Address preview failed');

  await state.startWriteScan();
  const scan = await state.tap(first.hello, first.applet);
  await state.finishScan();
  assert.equal(scan.error, undefined);
  assert.equal(state.session.phase, 'complete');
  assert.equal(
    state.session.cards.every(card => card.complete),
    true,
  );
  assert.equal(state.entrances.cardStore.get(source), undefined);
  assert.deepEqual(
    state.session.confirmedSnapshot.items.map(item => item.index),
    ['0fff0000000000000001', '0fff0000000000000002'],
  );
  assert.equal(state.toasts.length, 1);
  assert.equal(state.toasts[0].color, 'warning');
  assert.ok(state.button('Back to Card'));
});

for (const contents of ['empty', 'identical public']) {
  test(`${contents} cards offer Back to Card without entering Complete`, async () => {
    const source = {...readBackupCardIdentity(hello(1)), items: []};
    const state = mount({source});
    const first = contents === 'empty' ? emptyCard : publicCard(1).applet;
    const second = contents === 'empty' ? emptyCard : publicCard(1).applet;
    await state.session.add(first, hello(1), signal(), PIN);
    await state.session.add(second, hello(2), signal(), PIN);
    state.flow.consumeSource();

    assert.equal(state.button('Continue'), undefined);
    assert.equal(state.button('Back to Safe'), undefined);
    const back = state.button('Back to Card');
    assert.ok(back);
    assert.equal(back.props.color, 'neutral');
    assert.ok(state.button('Add another card'));
    assert.equal(state.session.phase, 'collect');
    assert.equal(state.flow.stepsExited, false);
    assert.equal(
      find(state.tree, node => node.type === 'OperationComplete'),
      undefined,
    );
    assert.equal(
      find(state.tree, node => node.type === 'Steps').props.$exiting,
      false,
    );
    back.props.onClick();
    assert.deepEqual(state.backs, [state.entrances.router.safe.card.$exact]);
    assert.equal(state.session.phase, 'collect');
  });
}

test('no-op collection falls back to Safe when the original Card is absent from history', async () => {
  const source = {...readBackupCardIdentity(hello(1)), items: []};
  const state = mount({source, canBackToCard: false});
  await state.session.add(emptyCard, hello(1), signal(), PIN);
  await state.session.add(emptyCard, hello(2), signal(), PIN);
  state.flow.consumeSource();
  assert.equal(state.button('Continue'), undefined);
  assert.equal(state.button('Back to Card'), undefined);
  const back = state.button('Back to Safe');
  assert.ok(back);
  back.props.onClick();
  assert.deepEqual(state.backs, [state.entrances.router.safe.$exact]);
  assert.equal(state.session.phase, 'collect');
});

test('standalone sync ignores unrelated Card history and returns to Safe', async () => {
  const state = mount({canBackToCard: true});
  await state.session.add(emptyCard, hello(1), signal(), PIN);
  await state.session.add(emptyCard, hello(2), signal(), PIN);
  assert.equal(state.button('Back to Card'), undefined);
  const back = state.button('Back to Safe');
  assert.ok(back);
  back.props.onClick();
  assert.deepEqual(state.backs, [state.entrances.router.safe.$exact]);
});

test('adding and removing cards updates no-op navigation without freezing the collection', async () => {
  const state = mount();
  await state.session.add(emptyCard, hello(1), signal(), PIN);
  await state.session.add(emptyCard, hello(2), signal(), PIN);
  assert.ok(state.button('Back to Safe'));

  const third = publicCard(3);
  await state.session.add(third.applet, third.hello, signal(), PIN);
  assert.ok(state.button('Continue'));
  assert.equal(state.button('Back to Safe'), undefined);
  assert.equal(state.session.phase, 'collect');

  state.session.remove(readBackupCardIdentity(third.hello).publicKey);
  assert.ok(state.button('Back to Safe'));
  assert.equal(state.button('Continue'), undefined);

  state.session.remove(readBackupCardIdentity(hello(2)).publicKey);
  assert.equal(state.button('Back to Safe'), undefined);
  assert.equal(state.button('Continue'), undefined);
  assert.ok(state.button('Add another card'));
  assert.equal(state.session.phase, 'collect');
});

test('opaque Secret copies keep Continue because their contents still require card verification', async () => {
  const state = mount();
  const opaqueCard = {
    ...emptyCard,
    list: async () => ({
      items: [
        {index: bytes('0fff0000000000000001'), type: 0x0fff, secret: true},
      ],
    }),
    exportItem: async () => ({data: Uint8Array.of(1)}),
  };
  const bundle = new Uint8Array(32).fill(1);
  await state.session.add(opaqueCard, hello(1, bundle), signal(), PIN);
  await state.session.add(opaqueCard, hello(2, bundle), signal(), PIN);

  assert.equal(state.button('Back to Safe'), undefined);
  assert.ok(state.button('Continue'));
  state.click('Continue');
  await state.flush();
  assert.equal(state.session.phase, 'write');
  assert.ok(state.button('Scan a pending card'));
});

test('a conflicting collection stays actionable and reports the conflict through Continue', async () => {
  const state = mount();
  const first = publicCard(1);
  const conflicting = {
    ...emptyCard,
    list: async () => ({
      items: [
        {index: bytes('0fff0000000000000001'), type: 0x0fff, secret: true},
      ],
    }),
  };
  await state.session.add(first.applet, first.hello, signal(), PIN);
  await state.session.add(conflicting, hello(2), signal(), PIN);

  assert.equal(state.button('Back to Safe'), undefined);
  assert.ok(state.button('Continue'));
  assert.deepEqual(state.errors, []);
  state.click('Continue');
  await state.flush();
  assert.equal(state.session.phase, 'collect');
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0].message, /conflicting sync scopes/);
  assert.ok(state.button('Add another card'));
});

test('no-op collection has no Continue or return button without matching route history', async () => {
  const source = {...readBackupCardIdentity(hello(1)), items: []};
  const state = mount({source, canBack: false});
  await state.session.add(emptyCard, hello(1), signal(), PIN);
  await state.session.add(emptyCard, hello(2), signal(), PIN);
  state.flow.consumeSource();
  await state.flush();
  assert.equal(state.session.phase, 'collect');
  assert.equal(state.button('Continue'), undefined);
  assert.equal(state.button('Back to Safe'), undefined);
  assert.equal(state.button('Back to Card'), undefined);
  assert.ok(state.button('Add another card'));
  assert.equal(
    find(state.tree, node => node.type === 'OperationComplete'),
    undefined,
  );
  assert.deepEqual(state.backs, []);
});

test('completed writes have no return button without matching route history', async () => {
  const source = {...readBackupCardIdentity(hello(1)), items: []};
  const state = mount({source, canBack: false});
  const first = publicCard(1);
  const second = publicCard(2);
  await state.session.add(first.applet, first.hello, signal(), PIN);
  await state.session.add(second.applet, second.hello, signal(), PIN);
  state.click('Continue');
  await state.flush();
  await state.session.write(first.applet, first.hello, signal(), PIN);
  await state.session.write(second.applet, second.hello, signal(), PIN);
  assert.equal(state.session.phase, 'complete');
  assert.equal(state.button('Back to Safe'), undefined);
  assert.equal(state.button('Back to Card'), undefined);
  assert.deepEqual(state.backs, []);
});
