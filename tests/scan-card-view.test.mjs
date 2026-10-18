import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

let fixture;

mock.module('react', {
  namedExports: {
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
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {View: 'div', ViewHeader: 'header', ViewHeaderTitle: 'h1'},
});
mock.module('../.bld/app/@components/views/safe/scan-card.js', {
  namedExports: {
    scanCardItems: async applet => {
      fixture.scannedApplet = applet;
      return fixture.scannedItems;
    },
  },
});

const {ScanCardView} = await import(
  '../.bld/app/@components/views/safe/@scan-card-view.js'
);

function mount({active = true, leaving = false} = {}) {
  const state = {replacements: 0, errors: [], cards: [], scannedItems: []};
  state.scan = new Promise((resolve, reject) => {
    state.resolveScan = resolve;
    state.rejectScan = reject;
  });
  state.entrances = {
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
  ScanCardView({
    view: {$leaving: leaving, $match: {$exact: {$active: active}}},
  });
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
  state.cleanup();
});

test('ordinary scan cancellation still returns to Safe', async () => {
  const state = mount();
  state.rejectScan(Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}));
  await state.finished;

  assert.equal(state.replacements, 1);
  assert.deepEqual(state.errors, []);
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

test('a completed scan opens Card with every scanned item, including resources without an address', async () => {
  const state = mount();
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
    safe: {id: new Uint8Array([1, 2, 3, 4]), publicKey},
  });
  state.resolveScan();
  await state.finished;

  assert.equal(state.scannedApplet, applet);
  assert.deepEqual(state.cards, [
    {
      card: {
        id: '01020304',
        publicKey: Buffer.from(publicKey).toString('hex'),
        items: state.scannedItems,
      },
    },
  ]);
  assert.equal(state.replacements, 0);
  assert.deepEqual(state.errors, []);
  state.cleanup();
});
