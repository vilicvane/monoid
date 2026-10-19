import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';

import {observable, runInAction, toJS} from 'mobx';

import {getAppletKey} from '../.bld/app/@lib/monoid/get-applet-key.js';
import {MonoidWrongCardError} from '../.bld/app/@lib/monoid/card-error.js';
import {CardStore} from '../.bld/app/@services/card-store.js';
import {
  getWalletData,
  getWalletReference,
  matchesWalletReference,
  WalletStorageService,
} from '../.bld/app/@services/wallet-storage-service.js';

let fixture;
let rendering;
const owners = [];
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const INDEX = '02400000000000000001';
const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const FRESH_PUBLIC_KEY =
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const PATH = "m/44'/60'/0'/0/7";

mock.method(console, 'info', () => {});
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
    useRef(initial) {
      return rendering.slot(() => ({current: initial}));
    },
    useMemo(compute) {
      return rendering.slot(() => ({value: compute()})).value;
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
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {getWalletData, getWalletReference, matchesWalletReference},
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {getAppletKey, MonoidWrongCardError},
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanStatePromptProgress: 'progress',
    useMonoidScanPrompt: options => {
      fixture.scanOptions.push(options);
      return [null, fixture.scan];
    },
  },
});
mock.module('../.bld/app/@components/views/safe/card-derivations.js', {
  namedExports: {
    writeCardDerivations: (...args) => fixture.write(...args),
  },
});
const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);
for (const [path, exports] of [
  ['@key/address-type-selector', {AddressTypeSelector: 'selector'}],
  ['@ui/button', {Button: 'button'}],
  ['@ui/input', {ResettableInput: 'input'}],
  ['@ui/interactive-address', {InteractiveAddress: 'address'}],
  ['@ui/step', {Steps: 'steps', Step: 'step'}],
  [
    '@view/index',
    {
      useViewActive,
      View: 'view',
      ViewContent: 'content',
      ViewHeader: 'header',
      ViewHeaderIdentifier: 'identifier',
      ViewHeaderTitle: 'h1',
    },
  ],
]) {
  mock.module(`../.bld/app/@components/${path}.js`, {namedExports: exports});
}

const {DeriveKeyView} = await import(
  '../.bld/app/@components/views/safe/@safe/derivable-key/derive-key-view.js'
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
    const match = find(child, predicate);
    if (match) return match;
  }
}

function mount() {
  const previous = {
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: "m/44'/60'/0'/0/0",
    publicKey: PUBLIC_KEY,
  };
  const storage = new WalletStorageService({async set() {}}, [
    {
      index: INDEX,
      type: 'seed',
      wallets: [previous],
      defaultWallet: getWalletReference(previous),
    },
  ]);
  const state = {
    slots: [],
    index: 0,
    scans: [],
    scanOptions: [],
    writes: [],
    errors: [],
    routes: [],
    authCount: 0,
    clears: 0,
    storage,
    cardStore: new CardStore(),
    hello: {
      id: bytes('aabbccdd'),
      publicKey: bytes(`04${'12'.repeat(64)}`),
      bundle: false,
    },
    view: observable({
      index: INDEX,
      $leaving: false,
      $match: {$exact: {$active: true}},
    }),
    applet: {
      async viewKey() {
        return {publicKey: bytes(PUBLIC_KEY)};
      },
    },
    slot(create) {
      return (this.slots[this.index++] ??= create());
    },
    render() {
      fixture = state;
      rendering = state;
      state.index = 0;
      state.tree = DeriveKeyView({view: state.view});
      rendering = undefined;
      return state.tree;
    },
    button(label) {
      return find(
        state.render(),
        node => node.type === 'button' && node.props.children === label,
      );
    },
    click(label) {
      state.button(label).props.onClick();
      return state.finished;
    },
    async tap(hello = state.hello) {
      const scan = state.scans.at(-1);
      scan.validate?.(hello);
      state.authCount++;
      await scan.callback(
        state.applet,
        () => {},
        hello,
        scan.controller.signal,
      );
    },
    async finish() {
      state.scans.at(-1).resolve();
      await state.finished;
      state.render();
    },
    unmount() {
      state.slots.splice(0).forEach(slot => slot.cleanup?.());
    },
  };
  state.scan = (label, callback, validate) => {
    const scan = {
      ...deferred(),
      label,
      callback,
      validate,
      controller: new AbortController(),
    };
    state.scans.push(scan);
    return scan.promise;
  };
  state.write = async (applet, key, wallets, signal) => {
    state.writes.push({applet, key, wallets, signal});
    if (signal.aborted)
      throw Object.assign(new Error('Cancelled'), {code: 'CANCELLED'});
    return {
      index: '0f010000000000000001',
      type: 0x0f01,
      key: INDEX,
      secret: false,
      derivationRecord: {index: INDEX, wallets},
      derivations: wallets.map(wallet => ({
        ...wallet,
        publicKey:
          wallet.path === previous.path ? PUBLIC_KEY : FRESH_PUBLIC_KEY,
      })),
    };
  };
  state.pinSession = {clear: () => state.clears++};
  state.view.$match.$view = () => ({$entries: [state.view]});
  state.entrances = {
    cardStore: state.cardStore,
    walletStorageService: storage,
    monoidCredentialsStore: {createPINSession: () => state.pinSession},
    router: {$back: () => state.routes.push('back')},
    errorService: {
      catch: callback => () => {
        state.finished = Promise.resolve(callback()).catch(error =>
          state.errors.push(error),
        );
      },
    },
  };
  state.render();
  find(state.tree, node => node.type === 'input').props.onChange({
    target: {value: PATH},
  });
  owners.push(state);
  return state;
}

async function derive(state) {
  const importedCount = state.storage.keys[0].wallets.length;
  state.click('Scan card');
  await state.tap();
  await state.finish();
  assert.equal(state.storage.keys[0].wallets.length, importedCount);
}

afterEach(() => owners.splice(0).forEach(owner => owner.unmount()));

test('Import scans again, appends only the requested address, and commits its fresh public key before leaving', async () => {
  const state = mount();
  await derive(state);
  const originalDefault = toJS(state.storage.keys[0].defaultWallet);

  state.click('Import');
  assert.deepEqual(
    state.scans.map(scan => scan.label),
    ['Scan card to derive', 'Scan card to import'],
  );
  assert.equal(state.storage.keys[0].wallets.length, 1);
  assert.equal(state.button('Import').props.disabled, true);
  assert.equal(state.button('Import').props.loading, true);
  assert.ok(
    state.scanOptions.every(
      options => options.allowSetup && options.pinSession === state.pinSession,
    ),
  );

  await state.tap();
  assert.equal(state.writes.length, 1);
  assert.deepEqual(
    state.writes[0].wallets.map(wallet => wallet.path),
    [PATH],
  );
  assert.equal(state.storage.keys[0].wallets[1].publicKey, FRESH_PUBLIC_KEY);
  assert.deepEqual(toJS(state.storage.keys[0].defaultWallet), originalDefault);
  assert.deepEqual(state.routes, []);

  await state.finish();
  assert.equal(state.view.expandedChain, 'evm');
  assert.deepEqual(state.routes, ['back']);
});

test('a wrong Safe with the same short ID is rejected before authentication or writing', async () => {
  const state = mount();
  await derive(state);
  state.click('Import');

  await assert.rejects(
    state.tap({
      ...state.hello,
      publicKey: bytes(`04${'34'.repeat(64)}`),
    }),
    MonoidWrongCardError,
  );
  assert.equal(state.authCount, 1);
  assert.equal(state.writes.length, 0);
  assert.equal(state.storage.keys[0].wallets.length, 1);

  await state.tap();
  await state.finish();
  assert.equal(state.storage.keys[0].wallets.length, 2);
});

test('a cancelled second scan leaves local wallets untouched and does not navigate', async () => {
  const state = mount();
  await derive(state);
  state.click('Import');
  const scan = state.scans.at(-1);
  scan.controller.abort();
  scan.reject(Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}));
  await state.finished;

  assert.equal(state.storage.keys[0].wallets.length, 1);
  assert.equal(state.writes.length, 0);
  assert.deepEqual(state.routes, []);
  assert.equal(state.button('Import').props.disabled, false);
});

test('an acknowledged write is committed even when the scan is cancelled during the write', async () => {
  const state = mount();
  await derive(state);
  const write = state.write;
  state.write = async (...args) => {
    const result = await write(...args);
    state.scans.at(-1).controller.abort();
    return result;
  };
  state.click('Import');
  await state.tap();
  await state.finish();

  assert.equal(state.storage.keys[0].wallets.length, 2);
  assert.equal(state.storage.keys[0].wallets[1].publicKey, FRESH_PUBLIC_KEY);
  assert.deepEqual(state.routes, []);
  assert.equal(state.view.expandedChain, undefined);
});

test('a failed write keeps the preview and can retry without importing locally first', async () => {
  const state = mount();
  await derive(state);
  const write = state.write;
  let attempts = 0;
  state.write = async (...args) => {
    if (++attempts === 1) throw new Error('Card write failed');
    return write(...args);
  };
  state.click('Import');

  await assert.rejects(state.tap(), /Card write failed/);
  assert.equal(state.storage.keys[0].wallets.length, 1);
  assert.deepEqual(state.routes, []);

  await state.tap();
  await state.finish();
  assert.equal(attempts, 2);
  assert.equal(state.storage.keys[0].wallets.length, 2);
  assert.deepEqual(state.routes, ['back']);
});

test('leaving during the scan aborts writes, clears cached PINs, and prevents navigation', async () => {
  const state = mount();
  await derive(state);
  state.click('Import');
  runInAction(() => {
    state.view.$leaving = true;
  });

  await assert.rejects(state.tap(), {code: 'CANCELLED'});
  await state.finish();
  assert.equal(state.storage.keys[0].wallets.length, 1);
  assert.equal(state.clears, 1);
  assert.deepEqual(state.routes, []);
});

test('a second click before rerender cannot start a concurrent import scan', async () => {
  const state = mount();
  await derive(state);
  const click = state.button('Import').props.onClick;
  click();
  const finished = state.finished;
  click();

  assert.equal(state.scans.length, 2);
  await state.tap();
  state.scans.at(-1).resolve();
  await finished;
  assert.equal(state.writes.length, 1);
  assert.equal(state.storage.keys[0].wallets.length, 2);
});

function selectDerivation(state, addressType, path) {
  find(state.render(), node => node.type === 'selector').props.onChange(
    addressType,
  );
  find(state.render(), node => node.type === 'input').props.onChange({
    target: {value: path},
  });
}

test('a known equivalent path previews without scanning but Import still verifies the root and writes the distinct record', async () => {
  const state = mount();
  const previous = toJS(state.storage.keys[0].wallets[0]);
  selectDerivation(state, 'bitcoin-segwit', previous.path);
  await state.click('Continue');

  assert.equal(state.scans.length, 0);
  assert.equal(state.storage.keys[0].wallets.length, 1);
  assert.ok(state.button('Import'));

  let reads = 0;
  state.applet.viewKey = async () => {
    reads++;
    return {publicKey: bytes(PUBLIC_KEY)};
  };
  state.click('Import');
  assert.equal(state.scans.length, 1);
  assert.equal(state.scans[0].label, 'Scan card to import');
  assert.equal(state.writes.length, 0);

  await state.tap();
  await state.finish();
  assert.equal(reads, 1);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(
    state.writes[0].wallets.map(wallet => wallet.addressType),
    ['bitcoin-segwit'],
  );
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [
    previous,
    {
      ...previous,
      addressType: 'bitcoin-segwit',
      publicKey: PUBLIC_KEY,
    },
  ]);
  assert.deepEqual(state.routes, ['back']);
});

test('local preview refuses a different derived key before any metadata write and permits a correct retry', async () => {
  const state = mount();
  selectDerivation(
    state,
    'bitcoin-segwit',
    state.storage.keys[0].wallets[0].path,
  );
  await state.click('Continue');
  state.click('Import');
  state.applet.viewKey = async () => ({publicKey: bytes(FRESH_PUBLIC_KEY)});

  await assert.rejects(state.tap(), /Key does not match/);
  assert.equal(state.writes.length, 0);
  assert.equal(state.storage.keys[0].wallets.length, 1);

  state.applet.viewKey = async () => ({publicKey: bytes(PUBLIC_KEY)});
  await state.tap();
  await state.finish();
  assert.equal(state.writes.length, 1);
  assert.equal(state.storage.keys[0].wallets.length, 2);
});

test('a verified local preview binds the complete card identity across a write retry', async () => {
  const state = mount();
  selectDerivation(
    state,
    'bitcoin-segwit',
    state.storage.keys[0].wallets[0].path,
  );
  await state.click('Continue');
  state.click('Import');
  const write = state.write;
  state.write = async () => {
    throw new Error('Card disconnected');
  };
  await assert.rejects(state.tap(), /Card disconnected/);

  await assert.rejects(
    state.tap({
      ...state.hello,
      publicKey: bytes(`04${'34'.repeat(64)}`),
    }),
    MonoidWrongCardError,
  );
  assert.equal(state.authCount, 1);
  assert.equal(state.writes.length, 0);

  state.write = write;
  await state.tap();
  await state.finish();
  assert.equal(state.storage.keys[0].wallets.length, 2);
});

test('a matching path still scans when its output needs the Taproot tweak', async () => {
  const state = mount();
  selectDerivation(
    state,
    'bitcoin-taproot',
    state.storage.keys[0].wallets[0].path,
  );
  assert.ok(state.button('Scan card'));
  assert.equal(state.button('Continue'), undefined);
});

test('single-address Import preserves card-only records without restoring them to the phone', async () => {
  const state = mount();
  await derive(state);
  const originalDefault = toJS(state.storage.keys[0].defaultWallet);
  const cardOnly = ['evm', 'bitcoin-segwit'].map(addressType => ({
    addressType,
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: "m/44'/60'/0'/0/9",
    publicKey: PUBLIC_KEY,
  }));
  const write = state.write;
  state.write = async (...args) => {
    const result = await write(...args);
    return {...result, derivations: [...result.derivations, ...cardOnly]};
  };
  state.click('Import');
  await state.tap();
  await state.finish();

  assert.equal(state.storage.keys[0].wallets.length, 2);
  assert.ok(
    state.storage.keys[0].wallets.every(
      wallet => wallet.path !== cardOnly[0].path,
    ),
  );
  assert.deepEqual(toJS(state.storage.keys[0].defaultWallet), originalDefault);
  assert.equal(state.view.expandedChain, 'evm');
  assert.deepEqual(state.routes, ['back']);
});

test('deleting an address then importing another updates the card snapshot without restoring the deleted address', async () => {
  const state = mount();
  await derive(state);
  const deleted = toJS(state.storage.keys[0].wallets[0]);
  state.storage.deleteWallet(INDEX, deleted);
  const cached = state.cardStore.set({
    id: Buffer.from(state.hello.id).toString('hex'),
    publicKey: Buffer.from(state.hello.publicKey).toString('hex'),
    bundle: false,
    items: [{index: INDEX, type: 'seed', secret: true, derivations: [deleted]}],
  });
  const write = state.write;
  state.write = async (...args) => {
    const result = await write(...args);
    return {
      ...result,
      derivationRecord: {
        index: INDEX,
        wallets: [
          getWalletReference(deleted),
          ...result.derivationRecord.wallets,
        ],
      },
      derivations: [deleted, ...result.derivations],
    };
  };
  state.click('Import');
  await state.tap();
  await state.finish();

  assert.deepEqual(
    state.storage.keys[0].wallets.map(wallet => wallet.path),
    [PATH],
  );
  assert.equal(state.storage.keys[0].defaultWallet, undefined);
  assert.deepEqual(
    cached.items[0].derivations.map(wallet => wallet.path),
    [deleted.path, PATH],
  );
  assert.equal(cached.items[1].derivationRecord.wallets.length, 2);
});

test('importing after an empty card record refreshes the card address preview', async () => {
  const state = mount();
  const previous = toJS(state.storage.keys[0].wallets[0]);
  state.storage.deleteWallet(INDEX, previous);
  const cached = state.cardStore.set({
    id: Buffer.from(state.hello.id).toString('hex'),
    publicKey: Buffer.from(state.hello.publicKey).toString('hex'),
    bundle: false,
    items: [{index: INDEX, type: 'seed', secret: true, derivations: []}],
  });
  await derive(state);
  state.click('Import');
  await state.tap();
  await state.finish();

  assert.equal(cached.items[0].ref.path, PATH);
  assert.equal(cached.items[0].addressType, 'evm');
  assert.deepEqual(
    cached.items[0].derivations.map(wallet => wallet.path),
    [PATH],
  );
  assert.deepEqual(
    state.storage.keys[0].wallets.map(wallet => wallet.path),
    [PATH],
  );
});
