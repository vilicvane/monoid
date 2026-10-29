import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';

import {runInAction, toJS} from 'mobx';

import {
  WalletStorageService,
  getWalletData,
} from '../.bld/app/@services/wallet-storage-service.js';

const INDEX = '05010000000000000001';
const PUBLIC_KEY =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
let current;
const fixtures = [];
mock.method(console, 'info', () => {});
mock.method(console, 'error', () => {});
mock.module('react', {
  namedExports: {
    useState(initial) {
      const slot = current.slot(() => ({value: initial}));
      return [
        slot.value,
        value => {
          slot.value = value;
        },
      ];
    },
    useRef(initial) {
      return current.slot(() => ({current: initial}));
    },
    useEffect(effect) {
      current.slot(() => ({cleanup: effect()}));
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
  namedExports: {useEntrances: () => current.entries},
});
for (const [path, exports] of [
  ['@ui/button', {Button: 'button'}],
  ['@ui/interactive-address', {InteractiveAddress: 'address'}],
  ['@ui/step', {Step: 'step', Steps: 'steps'}],
  [
    '@view/index',
    {
      View: 'view',
      ViewContent: 'content',
      ViewHeader: 'header',
      ViewHeaderIdentifier: 'identifier',
      ViewHeaderTitle: 'title',
      useViewActive: () => {
        const fixture = current;
        return () => fixture.active;
      },
    },
  ],
])
  mock.module(`../.bld/app/@components/${path}.js`, {namedExports: exports});
const {DeriveNativeAddressView} = await import(
  '../.bld/app/@components/views/safe/@safe/derive-native-address-view.js'
);

function find(node, type) {
  if (!node) return;
  if (node.type === type) return node;
  for (const child of Array.isArray(node)
    ? node
    : [node.props?.children, node.props?.footer]) {
    const match = find(child, type);
    if (match) return match;
  }
}

function mount() {
  const state = {
    slots: [],
    index: 0,
    active: true,
    writes: [],
    errors: [],
    back: 0,
    view: {index: INDEX},
    async persist() {},
    slot(create) {
      return (this.slots[this.index++] ??= create());
    },
    render() {
      current = this;
      this.index = 0;
      return DeriveNativeAddressView({view: this.view});
    },
    button() {
      return find(this.render(), 'button');
    },
    click() {
      return this.button().props.onClick();
    },
  };
  state.storage = new WalletStorageService(
    {
      async set(_name, value) {
        state.writes.push(structuredClone(value));
        await state.persist();
      },
    },
    [
      {
        index: INDEX,
        type: 'ed25519',
        alias: 'Native key',
        rawPublicKey: PUBLIC_KEY,
        wallets: [],
      },
    ],
  );
  state.entries = {
    walletStorageService: state.storage,
    router: {
      $back: () => {
        state.back++;
      },
    },
    errorService: {
      catch: action => async () => {
        try {
          await action();
        } catch (error) {
          state.errors.push(error);
        }
      },
    },
  };
  for (const name of ['monoidCredentialsStore', 'cardStore']) {
    Object.defineProperty(state.entries, name, {
      get() {
        return assert.fail(
          'Native address derivation must not access card services',
        );
      },
    });
  }
  fixtures.push(state);
  return state;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0))
    for (const slot of fixture.slots) slot.cleanup?.();
});

test('native address preview is local and only Import persists a Solana wallet', async () => {
  const state = mount();
  assert.equal(
    find(state.render(), 'address').props.children,
    getWalletData({addressType: 'solana', publicKey: PUBLIC_KEY}).address,
  );
  assert.deepEqual(toJS(state.storage.keys[0].wallets), []);
  assert.deepEqual(state.writes, []);
  await state.click();
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [
    {
      addressType: 'solana',
      seed: undefined,
      curve: undefined,
      path: undefined,
      publicKey: PUBLIC_KEY,
    },
  ]);
  assert.equal(state.storage.keys[0].rawPublicKey, PUBLIC_KEY);
  assert.equal(state.writes.length, 1);
  assert.equal(state.back, 1);
  assert.deepEqual(state.errors, []);
});

test('double clicks share one save and leaving waits for persistence without navigating', async () => {
  const state = mount();
  let release;
  state.persist = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const first = state.click();
  const second = state.click();
  assert.equal(state.button().props.disabled, true);
  assert.equal(state.writes.length, 1);
  state.active = false;
  release();
  await Promise.all([first, second]);
  assert.equal(state.back, 0);
  state.active = true;
  assert.equal(
    state.button().props.disabled,
    false,
    'returning to a mounted page clears the busy state',
  );
  assert.equal(state.storage.keys[0].wallets.length, 1);
});

test('a failed save stays on the preview and a retry persists the same address once', async () => {
  const state = mount();
  state.persist = async () => {
    throw new Error('Storage unavailable');
  };
  await state.click();
  assert.equal(state.back, 0);
  assert.match(state.errors[0].message, /Storage unavailable/);
  state.persist = async () => {};
  await state.click();
  assert.equal(state.back, 1);
  assert.equal(state.storage.keys[0].wallets.length, 1);
  assert.equal(state.writes.length, 2);
});

test('a changed native key cannot import an address from an earlier preview', async () => {
  const state = mount();
  const click = state.button().props.onClick;
  runInAction(() => {
    state.storage.keys[0].rawPublicKey =
      '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c';
  });
  await state.storage.flush();
  const writesBeforeImport = structuredClone(state.writes);
  await click();
  assert.match(state.errors[0].message, /key changed/i);
  assert.deepEqual(state.writes, writesBeforeImport);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), []);
});
