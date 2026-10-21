import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

let fixture;

mock.module('react', {
  namedExports: {
    useMemo: create => create(),
    useEffect: effect => {
      fixture.cleanup = effect();
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
    isCredentialRequestCancelled: error =>
      error?.code === 'CANCELLED' || error?.code === 'APP_INACTIVE',
  },
});
mock.module('../.bld/app/@utils/index.js', {
  namedExports: {uint8ArrayToHex: bytes => Buffer.from(bytes).toString('hex')},
});
class MonoidScanRedirectError extends Error {
  code = 'CANCELLED';
}
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanRedirectError,
    MonoidScanStatePromptProgress: 'span',
    useMonoidScanPrompt: () => [
      null,
      (content, onScan) => {
        fixture.onScan = onScan;
        return fixture.scan;
      },
    ],
  },
});
const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {
    View: 'div',
    ViewHeader: 'header',
    ViewHeaderTitle: 'h1',
    useViewActive,
  },
});
mock.module('../.bld/app/@components/views/safe/scan-card.js', {
  namedExports: {
    scanCardItems: async (applet, onProgress, signal, localKeys) => {
      fixture.scannedApplet = applet;
      fixture.scannedSignal = signal;
      fixture.scannedLocalKeys = localKeys;
      for (const progress of fixture.progress ?? []) {
        onProgress(...progress);
      }
      return fixture.scannedItems;
    },
  },
});

const {ScanCardView} = await import(
  '../.bld/app/@components/views/safe/@scan-card-view.js'
);

function mount({active = true, leaving = false} = {}) {
  const state = {
    replacements: 0,
    errors: [],
    cards: [],
    scannedItems: [],
    storedCards: [],
    localKeys: [],
  };
  state.scan = new Promise((resolve, reject) => {
    state.resolveScan = resolve;
    state.rejectScan = reject;
  });
  state.entrances = {
    walletStorageService: {keys: state.localKeys},
    cardStore: {
      set: card => state.storedCards.push(card),
    },
    router: {
      safe: {
        $replace: () => state.replacements++,
        card: options => ({$push: () => state.cards.push(options)}),
      },
    },
    errorService: {
      catch: promise => {
        state.finished = promise.catch(error => state.errors.push(error));
      },
    },
  };
  fixture = state;
  const view = {
    $leaving: leaving,
    $match: {$exact: {$active: active, $transition: !active && !leaving}},
  };
  view.$match.$view = () => ({$entries: [view]});
  ScanCardView({view});
  return state;
}

test('background cancellation returns an active scan page to Safe without an error toast', async () => {
  const state = mount();
  state.rejectScan(
    Object.assign(new Error('App inactive'), {code: 'APP_INACTIVE'}),
  );
  await state.finished;

  assert.equal(state.replacements, 1);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.storedCards, []);
  state.cleanup();
});

test('ordinary scan cancellation still returns to Safe', async () => {
  const state = mount();
  state.rejectScan(Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}));
  await state.finished;

  assert.equal(state.replacements, 1);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.storedCards, []);
  state.cleanup();
});

for (const active of [true, false]) {
  test(`a scan redirect preserves the destination while scan-page active=${active}`, async () => {
    const state = mount({active});
    state.rejectScan(new MonoidScanRedirectError());
    await state.finished;

    assert.equal(state.replacements, 0);
    assert.deepEqual(state.errors, []);
    state.cleanup();
  });
}

test('a failure during page entry still schedules the return to Safe and reports the error', async () => {
  const state = mount({active: false});
  const failure = Object.assign(new Error('Storage unavailable'), {
    code: 'IO_ERROR',
  });
  state.rejectScan(failure);
  await state.finished;

  assert.equal(state.replacements, 1);
  assert.deepEqual(state.errors, [failure]);
  state.cleanup();
});

test('a late failure cannot replace a route that is already leaving', async () => {
  const state = mount({leaving: true});
  state.rejectScan(
    Object.assign(new Error('App inactive'), {code: 'APP_INACTIVE'}),
  );
  await state.finished;

  assert.equal(state.replacements, 0);
  assert.deepEqual(state.errors, []);
  state.cleanup();
});

test('a completed scan stores every resource and routes to Card with only its identity', async () => {
  const state = mount();
  state.localKeys.push({
    type: 'secp256k1',
    index: '03010000000000000001',
    wallets: [{addressType: 'evm', publicKey: `02${'11'.repeat(32)}`}],
  });
  state.scannedItems = [
    {type: 'seed', index: '00010000000000000001', alias: 'Seed', secret: true},
    {index: 'ffff0000000000000002', alias: '', key: '', secret: false},
  ];
  const applet = {};
  const publicKey = Uint8Array.from([
    4,
    ...Array.from({length: 64}, (_, index) => index),
  ]);
  await state.onScan(applet, () => {}, {
    id: new Uint8Array([1, 2, 3, 4]),
    publicKey,
    bundle: new Uint8Array(32).fill(0x42),
  });
  state.resolveScan();
  await state.finished;

  assert.equal(state.scannedApplet, applet);
  assert.equal(state.scannedLocalKeys, state.localKeys);
  assert.deepEqual(state.storedCards, [
    {
      id: '01020304',
      publicKey: Buffer.from(publicKey).toString('hex'),
      bundle: '42'.repeat(32),
      items: state.scannedItems,
    },
  ]);
  assert.deepEqual(state.cards, [
    {
      card: {
        id: '01020304',
        publicKey: Buffer.from(publicKey).toString('hex'),
      },
    },
  ]);
  assert.equal(state.replacements, 0);
  assert.deepEqual(state.errors, []);
  state.cleanup();
});

test('a successful scan finishing after unmount neither overwrites the store nor opens Card', async () => {
  const state = mount();
  state.scannedItems = [
    {type: 'seed', index: '02400000000000000001', secret: true},
  ];
  state.cleanup();
  await state.onScan({}, () => {}, {
    id: new Uint8Array([1, 2, 3, 4]),
    publicKey: new Uint8Array([4, 1, 2, 3]),
    bundle: false,
  });
  state.resolveScan();
  await state.finished;

  assert.deepEqual(state.storedCards, []);
  assert.deepEqual(state.cards, []);
  assert.equal(state.replacements, 0);
  assert.deepEqual(state.errors, []);
});

test('scan progress forwards completed counts and cancellation', async () => {
  const state = mount();
  state.progress = [
    [0, 1, 'records'],
    [1, 1, 'records'],
    [0, 1, 'keys'],
    [1, 1, 'keys'],
  ];
  const controller = new AbortController();
  const content = [];
  await state.onScan(
    {},
    value => content.push(value),
    {id: new Uint8Array([1]), publicKey: new Uint8Array([4]), bundle: false},
    controller.signal,
  );

  assert.equal(state.scannedSignal, controller.signal);
  assert.deepEqual(
    content
      .filter(value => typeof value !== 'string')
      .map(value => value.props),
    state.progress.map(([current, total, stage]) => ({
      current,
      total,
      children:
        stage === 'records' ? 'Reading address records' : 'Reading keys',
    })),
  );
  state.resolveScan();
  await state.finished;
  state.cleanup();
});
