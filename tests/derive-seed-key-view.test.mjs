import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {ed25519} from '@noble/curves/ed25519';
import {p256} from '@noble/curves/nist';
import {toJS} from 'mobx';

import {assertSameCard} from '../.bld/app/@lib/monoid/card-identity.js';
import {
  decodeCardKeyDerivationRecord,
  writeCardKeyDerivationRecord,
} from '../.bld/app/@lib/monoid/card-key-derivations.js';
import {CardStore} from '../.bld/app/@services/card-store.js';
import {WalletStorageService} from '../.bld/app/@services/wallet-storage-service.js';

const INDEX = '02400000000000000001';
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
let current;
mock.method(console, 'info', () => {});
mock.module('react', {
  namedExports: {
    useEffect() {},
    useRef: value => current.slot(() => ({current: value})),
    useState(value) {
      const slot = current.slot(() => ({
        value: typeof value === 'function' ? value() : value,
      }));
      return [
        slot.value,
        value => {
          slot.value = value;
        },
      ];
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
  namedExports: {useEntrances: () => current.entrances},
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {assertSameCard, writeCardKeyDerivationRecord},
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    scanCardPrompt: () => 'Save key',
    useMonoidScanPrompt: options => {
      current.scanOptions.push(options);
      return [null, current.scan];
    },
  },
});
for (const [path, namedExports] of [
  ['@ui/button', {Button: 'button'}],
  ['@ui/input', {ResettableInput: 'input'}],
  ['@ui/segmented-control', {SegmentedControl: 'selector'}],
  ['@ui/step', {Steps: 'steps', Step: 'step'}],
  ['@ui/message-content', {InfoMessage: 'info'}],
  [
    '@ui/info-section',
    {
      InfoSection: 'section',
      InfoSectionItemLabel: 'label',
      InfoSectionRow: 'row',
    },
  ],
  ['@key/key-wallet-list', {KeyWalletList: 'wallets'}],
  ['@key/derived-key-list', {DerivedKeyList: 'derived-keys'}],
  ['views/safe/@safe/@key-header', {KeyHeader: 'key-header'}],
  [
    '@view/index',
    {
      View: 'view',
      ViewContent: 'content',
      ViewPlaceholder: 'placeholder',
      ViewHeader: 'header',
      ViewHeaderTitle: 'title',
      ViewHeaderIdentifier: 'identifier',
      useViewActive: () => () => current.active,
    },
  ],
])
  mock.module(`../.bld/app/@components/${path}.js`, {namedExports});

const {DeriveSeedKeyView} = await import(
  '../.bld/app/@components/views/safe/@safe/derivable-key/derive-seed-key-view.js'
);
const {DerivableKeyView} = await import(
  '../.bld/app/@components/views/safe/@safe/derivable-key/derivable-key-view.js'
);

function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of Array.isArray(node)
    ? node
    : [node.props?.children, node.props?.footer]) {
    const result = find(child, predicate);
    if (result) return result;
  }
}

async function mount(curve = 'ed25519', input = '  fixture:密钥  ') {
  const snapshots = new Map();
  const storage = {
    async get(name) {
      return snapshots.get(name);
    },
    async set(name, value) {
      snapshots.set(name, structuredClone(value));
    },
  };
  const walletStorageService = new WalletStorageService(storage, [
    {index: INDEX, type: 'seed', alias: 'Seed', wallets: []},
  ]);
  const cardStore = new CardStore();
  const hello = {
    id: bytes('01020304'),
    publicKey: bytes(`04${'12'.repeat(64)}`),
  };
  const card = cardStore.set({
    id: hex(hello.id),
    publicKey: hex(hello.publicKey),
    alias: false,
    authority: false,
    bundle: false,
    allowPeerExtension: false,
    items: [{index: INDEX, type: 'seed', secret: true}],
  });
  const publicKey =
    curve === 'ed25519'
      ? ed25519.getPublicKey(new Uint8Array(32).fill(7))
      : p256.getPublicKey(7n);
  const state = {
    active: true,
    slots: [],
    cursor: 0,
    backs: 0,
    records: [],
    keyReads: 0,
    references: [],
    scanOptions: [],
    scans: [],
    snapshots,
    storage,
    slot(create) {
      return (this.slots[this.cursor++] ??= create());
    },
    hello,
    card,
    walletStorageService,
    applet: {
      async viewKey(reference) {
        state.keyReads++;
        state.references.push(reference);
        return {publicKey};
      },
      async view() {
        return {secret: true};
      },
      async list() {
        return {items: state.records.map(({data: _data, ...item}) => item)};
      },
      async get() {
        return {data: state.records[0].data};
      },
      async create(request) {
        state.records.push({...request, type: 0x0f02});
        state.afterWrite?.();
      },
      async set(request) {
        state.records[0].data = request.data;
        state.afterWrite?.();
      },
    },
    render() {
      current = state;
      state.cursor = 0;
      return DeriveSeedKeyView({
        view: {index: INDEX},
        purposeSelector: () => null,
      });
    },
    button() {
      return find(state.render(), node => node.type === 'button');
    },
    async click() {
      await state.button().props.onClick();
    },
  };
  state.scan = async (_title, callback, validate) => {
    const controller = new AbortController();
    state.scans.push(controller);
    validate?.(state.hello);
    await callback(state.applet, () => {}, state.hello, controller.signal);
  };
  state.entrances = {
    walletStorageService,
    cardStore,
    router: {$back: () => state.backs++, safe: {$reset() {}}},
    monoidCredentialsStore: {createPINSession: () => ({clear() {}})},
    errorService: {catch: fn => fn},
  };
  const tree = state.render();
  find(tree, node => node.type === 'selector').props.onChange(curve);
  find(state.render(), node => node.type === 'input').props.onChange({
    target: {value: input},
  });
  return state;
}

for (const curve of ['ed25519', 'secp256r1']) {
  test(`${curve}: preview, save and return to the Seed page with a generic public key`, async () => {
    const state = await mount(curve);
    await state.click();
    assert.equal(state.button().props.children, 'Import');
    assert.equal(state.walletStorageService.keys[0].derivedKeys, undefined);
    await state.click();
    assert.equal(state.keyReads, 2);
    assert.equal(state.records.length, 1);
    const expected = {type: 'monoid-001', curve, context: '  fixture:密钥  '};
    assert.deepEqual(state.walletStorageService.keys[0].wallets, []);
    assert.ok(
      state.references.every(
        reference => reference.derivation.type === 'monoid-001',
      ),
    );
    assert.ok(
      state.references.every(
        reference =>
          new TextDecoder().decode(reference.derivation.context) ===
          expected.context,
      ),
    );
    assert.deepEqual(
      decodeCardKeyDerivationRecord(state.records[0].data).derivations,
      [expected],
    );
    assert.equal(state.backs, 1);
    assert.equal(state.snapshots.get('walletKeys')[0].derivedKeys.length, 1);
    assert.deepEqual(
      toJS(state.walletStorageService.keys[0].derivedKeys[0].derivation),
      expected,
    );
    assert.deepEqual(
      toJS(state.card.items[0].derivedKeys[0].derivation),
      expected,
    );
    assert.equal(state.card.items[1].keyDerivationRecord.derivations.length, 1);
    assert.ok(
      state.scanOptions.every(
        options => options.auth === 'access' && !options.retryOnError,
      ),
    );
    current = state;
    const seedPage = DerivableKeyView({view: {index: INDEX}});
    assert.deepEqual(
      toJS(find(seedPage, node => node.type === 'derived-keys').props.keys),
      toJS(state.walletStorageService.keys[0].derivedKeys),
    );
    assert.equal(
      find(seedPage, node => node.type === 'wallets'),
      undefined,
    );
  });
}

test('changed Seed key or wrong card cannot save the previewed generic key', async () => {
  const state = await mount();
  await state.click();
  const original = state.hello;
  state.hello = {...original, publicKey: bytes(`04${'34'.repeat(64)}`)};
  await assert.rejects(state.click());
  assert.equal(state.keyReads, 1);
  state.hello = original;
  state.applet.viewKey = async () => ({
    publicKey: ed25519.getPublicKey(new Uint8Array(32).fill(8)),
  });
  await assert.rejects(state.click(), /no longer matches/);
  assert.equal(state.records.length, 0);
  assert.equal(state.walletStorageService.keys[0].derivedKeys, undefined);
  assert.equal(state.backs, 0);
});

test('a card write acknowledged after cancellation remains imported without navigation', async () => {
  const state = await mount();
  await state.click();
  state.afterWrite = () => state.scans.at(-1).abort();
  await state.click();
  assert.equal(state.records.length, 1);
  assert.equal(state.snapshots.get('walletKeys')[0].derivedKeys.length, 1);
  assert.equal(state.walletStorageService.keys[0].derivedKeys.length, 1);
  assert.equal(state.backs, 0);
});

test('failed card writes keep the preview and do not import or navigate', async () => {
  const state = await mount();
  await state.click();
  state.applet.create = async () => {
    throw new Error('Reader disconnected');
  };
  await assert.rejects(state.click(), /Reader disconnected/);
  assert.equal(state.button().props.children, 'Import');
  assert.equal(state.walletStorageService.keys[0].derivedKeys, undefined);
  assert.equal(state.backs, 0);
});

test('Import waits for phone persistence and keeps the acknowledged card record after a storage failure', async () => {
  const state = await mount();
  await state.click();
  let failWrite;
  let started;
  const writeStarted = new Promise(resolve => (started = resolve));
  const pendingWrite = new Promise((_, reject) => (failWrite = reject));
  const failingStorage = mock.method(state.storage, 'set', async () => {
    started();
    await pendingWrite;
  });
  const importing = state.click();
  await writeStarted;
  assert.equal(state.backs, 0);
  assert.equal(state.records.length, 1);
  assert.equal(state.card.items[1].keyDerivationRecord.derivations.length, 1);
  assert.equal(state.button().props.disabled, true);
  failWrite(new Error('Phone storage unavailable'));
  await assert.rejects(importing, /Phone storage unavailable/);
  assert.equal(state.backs, 0);
  assert.equal(state.button().props.children, 'Import');
  assert.equal(state.button().props.disabled, false);
  assert.equal(state.card.items[0].derivedKeys.length, 1);
  failingStorage.mock.restore();
  await state.click();
  assert.equal(state.backs, 1);
  assert.equal(state.records.length, 1);
  assert.equal(state.snapshots.get('walletKeys')[0].derivedKeys.length, 1);
});

for (const curve of ['ed25519', 'secp256r1']) {
  test(`${
    curve
  }: empty context is valid and persists exactly without creating a wallet`, async () => {
    const state = await mount(curve, '');
    const input = find(state.render(), node => node.type === 'input');
    assert.equal(input.props.value, '');
    assert.equal(input.props.placeholder, 'Context (optional)');
    assert.equal(input.props['aria-label'], 'Derivation context');
    assert.equal(state.button().props.disabled, false);
    await state.click();
    const preview = find(state.render(), node => node.type === 'derived-keys')
      .props.keys[0];
    assert.deepEqual(preview.derivation, {
      type: 'monoid-001',
      curve,
      context: '',
    });
    assert.match(
      preview.publicKey,
      curve === 'ed25519' ? /^[0-9a-f]{64}$/ : /^04[0-9a-f]{128}$/,
    );
    assert.equal('account' in preview, false);
    await state.click();
    assert.deepEqual(
      decodeCardKeyDerivationRecord(state.records[0].data).derivations,
      [{type: 'monoid-001', curve, context: ''}],
    );
    assert.deepEqual(state.walletStorageService.keys[0].wallets, []);
  });
}

test('context inputs retain separate values for each curve and reset to a valid empty context', async () => {
  const state = await mount('ed25519', '  Ed25519 context  ');
  const select = curve =>
    find(state.render(), node => node.type === 'selector').props.onChange(
      curve,
    );
  const input = () => find(state.render(), node => node.type === 'input');
  select('secp256r1');
  assert.equal(input().props.value, '');
  input().props.onChange({target: {value: '\ufeffP-256 密钥  '}});
  select('ed25519');
  assert.equal(input().props.value, '  Ed25519 context  ');
  input().props.onReset();
  assert.equal(input().props.value, '');
  assert.equal(state.button().props.disabled, false);
  select('secp256r1');
  assert.equal(input().props.value, '\ufeffP-256 密钥  ');
});

test('a path-looking value remains literal UTF-8 context while invalid Unicode cannot start NFC', async () => {
  const state = await mount('ed25519', '\ud800');
  assert.equal(state.button().props.disabled, true);
  await state.click();
  assert.equal(state.scans.length, 0);
  find(state.render(), node => node.type === 'input').props.onChange({
    target: {value: "m/0'/7'"},
  });
  assert.equal(state.button().props.disabled, false);
  await state.click();
  const preview = find(state.render(), node => node.type === 'derived-keys')
    .props.keys[0];
  assert.deepEqual(preview.derivation, {
    type: 'monoid-001',
    curve: 'ed25519',
    context: "m/0'/7'",
  });
  assert.equal(
    new TextDecoder().decode(state.references[0].derivation.context),
    "m/0'/7'",
  );
});
