import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';

import {observable, runInAction, toJS} from 'mobx';

import {
  MonoidCardError,
  MonoidWrongCardError,
} from '../.bld/app/@lib/monoid/card-error.js';
import {getAppletKey} from '../.bld/app/@lib/monoid/get-applet-key.js';
import {
  acceptMatchingItem,
  removeItems,
  setItemAlias,
} from '../.bld/app/@lib/monoid/item-operations.js';
import {CardStore} from '../.bld/app/@services/card-store.js';
import {
  WalletStorageService,
  assertWalletPublicKeys,
  getWalletData,
  getWalletReference,
  matchesWalletReference,
} from '../.bld/app/@services/wallet-storage-service.js';

let fixture;
let rendering;
const owners = [];
const INDEX = '02400000000000000001';
const SECOND_INDEX = '02400000000000000002';
const CREATED_INDEX = '03010000000000000003';
const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const OTHER_PUBLIC_KEY =
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));

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
mock.module('lucide-react', {
  namedExports: {Ellipsis: 'ellipsis'},
});
mock.module('styled-components', {
  namedExports: {
    styled: Object.assign(component => () => component, {
      p: () => 'description',
    }),
  },
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => fixture.entrances},
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {
    assertWalletPublicKeys,
    getWalletData,
    getWalletReference,
    matchesWalletReference,
  },
});
mock.module('../.bld/app/@lib/monoid/index.js', {
  namedExports: {
    getAppletKey,
    MonoidCardError,
    MonoidWrongCardError,
    removeItems,
    setItemAlias,
    acceptMatchingItem,
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanStatePromptProgress: 'progress',
    useMonoidScanPrompt: options => {
      const state = fixture;
      state.scanOptions.push(options);
      return [
        null,
        (label, callback, validate) =>
          state.scan(label, callback, validate, options),
      ];
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
  [
    '@key/address-type-selector',
    {
      ADDRESS_CHAIN_OPTIONS: [
        {value: 'evm', label: 'EVM'},
        {value: 'solana', label: 'Solana'},
        {value: 'bitcoin', label: 'BTC'},
      ],
    },
  ],
  ['@key/key-list', {KeyListPlaceholder: 'placeholder'}],
  ['@key/key-tags', {KeyTypeTag: 'key-type-tag', keyTypeColorsCSS: ''}],
  ['@monoid/pin-input-placeholder', {PINKind: 'pin-kind'}],
  ['@ui/app-icon', {AppIcon: 'icon'}],
  ['@ui/button', {Button: 'popup-button', Buttons: 'buttons'}],
  ['@ui/centered-popup', {CenteredPopup: 'popup'}],
  [
    '@ui/details-popup',
    {
      DetailsPopup: 'popup',
      DetailsPopupTitle: 'popup-title',
      DetailsPopupDivider: 'popup-divider',
    },
  ],
  ['@ui/segmented-control', {SegmentedControl: 'segmented'}],
  [
    '@view/index',
    {
      useViewActive,
      View: 'view',
      ViewActionButton: 'button',
      ViewContent: 'content',
      ViewHeader: 'header',
      ViewHeaderButton: 'header-button',
      ViewHeaderIdentifier: 'identifier',
      ViewHeaderTags: 'header-tags',
      ViewHeaderTitle: 'h1',
      ViewPlaceholder: 'placeholder',
    },
  ],
  [
    'views/safe/@card/@address-type-picker',
    {AddressTypePicker: 'address-type-picker'},
  ],
  ['views/safe/@card/@key-item', {KeyItem: 'key-item'}],
  ['views/safe/@card/card-pin-update', {CardPINUpdate: 'pin-update'}],
  [
    'views/safe/@card/@resource-item',
    {CardResourceItem: 'resource-item', CardResourceList: 'resource-list'},
  ],
]) {
  mock.module(`../.bld/app/@components/${path}.js`, {namedExports: exports});
}

const {CardView} = await import(
  '../.bld/app/@components/views/safe/@card/card-view.js'
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

function textContent(node) {
  if (node == null) return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (node.type === 'pin-kind') return node.props.kind;
  return textContent(node.props?.children);
}

function wallet(number, publicKey = PUBLIC_KEY) {
  return {
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: `m/44'/60'/0'/0/${number}`,
    publicKey,
  };
}

function key(index, wallets, defaultWallet = wallets[0]) {
  return {
    index,
    type: 'seed',
    alias: undefined,
    wallets,
    ...(defaultWallet && {defaultWallet: getWalletReference(defaultWallet)}),
  };
}

function metadata(index, wallets) {
  return {
    index: `0f01${index.slice(4)}`,
    type: 0x0f01,
    metadata: index,
    secret: false,
    derivationRecord: {index, wallets: wallets.map(getWalletReference)},
  };
}

function cardItems(index, wallets, preview = wallets[0] ?? wallet(0)) {
  return [
    {
      index,
      type: 'seed',
      secret: true,
      ref: {...preview, address: getWalletData(preview).address},
      derivations: wallets,
    },
    ...(wallets.length ? [metadata(index, wallets)] : []),
  ];
}

function sparseCardItems(index, wallets, known = [], preview) {
  return [
    {
      index,
      type: 'seed',
      secret: true,
      derivations: known,
      ...(preview && {
        ref: {...preview, address: getWalletData(preview).address},
      }),
    },
    metadata(index, wallets),
  ];
}

function mount({items, keys = []}) {
  const storage = new WalletStorageService({async set() {}}, keys);
  const state = {
    slots: [],
    index: 0,
    scans: [],
    scanOptions: [],
    writes: [],
    aliasWrites: [],
    removals: [],
    creations: [],
    views: [],
    keyViews: [],
    progressUpdates: [],
    errors: [],
    routes: [],
    copies: [],
    setups: [],
    authCount: 0,
    clears: 0,
    storage,
    view: observable({
      card: {
        id: 'aabbccdd',
        publicKey: `04${'12'.repeat(64)}`,
      },
      $leaving: false,
      $match: {$exact: {$active: true}},
    }),
    slot(create) {
      return (this.slots[this.index++] ??= create());
    },
    render() {
      fixture = state;
      rendering = state;
      state.index = 0;
      const outer = CardView({view: state.view});
      const content = find(outer, node => typeof node.type === 'function');
      state.tree = content ? content.type(content.props) : outer;
      rendering = undefined;
      return state.tree;
    },
    item(index) {
      return find(
        state.render(),
        node =>
          (node.type === 'key-item' || node.type === 'resource-item') &&
          node.props.data.index === index,
      );
    },
    rowIndexes() {
      return (
        find(
          state.render(),
          node => node.type === 'resource-list',
        )?.props.children.map(node => node.props.data.index) ?? []
      );
    },
    filter(value) {
      find(state.render(), node => node.type === 'segmented').props.onChange(
        value,
      );
    },
    select(index, selected = true) {
      state.item(index).props.onSelect(selected);
    },
    toggleDirection(index) {
      const change = state.item(index).props.onChangeSyncDirection;
      assert.ok(change, 'sync direction should be switchable');
      change();
    },
    changeAddressType(index, addressType) {
      state.item(index).props.onChangeAddressType();
      find(
        state.render(),
        node => node.type === 'address-type-picker',
      ).props.onChange(addressType);
    },
    button(label) {
      return find(
        state.render(),
        node => node.type === 'button' && node.props.children === label,
      );
    },
    visible(label) {
      return state.button(label)?.props.visible === true;
    },
    click(label) {
      const button = state.button(label);
      assert.equal(button?.props.visible, true, `${label} should be visible`);
      assert.equal(button.props.disabled, false, `${label} should be enabled`);
      button.props.onClick();
      return state.finished;
    },
    menuButton() {
      return find(
        state.render(),
        node =>
          node.type === 'header-button' &&
          node.props['aria-label'] === 'Card actions',
      );
    },
    popup() {
      return find(state.render(), node => node.type === 'popup');
    },
    popupButton(label) {
      return find(
        state.popup(),
        node =>
          node.type === 'popup-button' &&
          (node.props['aria-label'] ?? textContent(node)) === label,
      );
    },
    confirmDelete() {
      state.menuButton().props.onClick();
      state.popupButton('Delete').props.onClick();
      return state.popupButton('Delete').props.onClick;
    },
    createKey(label = 'secp256k1') {
      state.menuButton().props.onClick();
      state.popupButton('Create key').props.onClick();
      state.popupButton(label).props.onClick();
      return state.finished;
    },
    async tap(hello = state.hello) {
      const scan = state.scans.at(-1);
      scan.validate?.(hello);
      state.authCount++;
      await scan.callback(
        state.cardStore.observeApplet(state.applet, hello),
        content => state.progressUpdates.push(content),
        hello,
        scan.controller.signal,
      );
    },
    async finish() {
      state.scans.at(-1).resolve();
      await new Promise(resolve => setImmediate(resolve));
      // Deletion then asks for further cards; close that prompt as a user would.
      const next = state.scans.at(-1);
      if (next.label === 'Scan next card to delete')
        next.reject(Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}));
      await state.finished;
      state.render();
    },
    async dismiss(error = new Error('Scan cancelled')) {
      const scan = state.scans.at(-1);
      scan.controller.abort();
      scan.reject(error);
      await state.finished;
      state.render();
    },
    unmount() {
      state.slots.splice(0).forEach(slot => slot.cleanup?.());
    },
  };
  state.cardStore = new CardStore();
  state.card = state.cardStore.set({...state.view.card, bundle: false, items});
  state.hello = {
    version: 0,
    id: bytes(state.view.card.id),
    publicKey: bytes(state.view.card.publicKey),
    bundle: false,
    authority: false,
    pins: {access: 5, secret: 5},
  };
  state.applet = {
    async createRandomKey(request) {
      state.creations.push(request);
      return {index: bytes(CREATED_INDEX)};
    },
    async view(request) {
      state.views.push(request);
      return {secret: true};
    },
    async viewKey(request) {
      state.keyViews.push(request);
      return {publicKey: bytes(PUBLIC_KEY)};
    },
    async set(request) {
      state.aliasWrites.push(request);
    },
    async remove({index}) {
      state.removals.push(Buffer.from(index).toString('hex'));
      return {removed: true};
    },
  };
  state.scan = (label, callback, validate, options) => {
    const scan = {
      ...deferred(),
      label,
      callback,
      validate,
      options,
      controller: new AbortController(),
    };
    state.scans.push(scan);
    return scan.promise;
  };
  state.write = async (applet, source, wallets, signal, options) => {
    state.writes.push({applet, key: source, wallets, signal, options});
    if (signal.aborted)
      throw Object.assign(new Error('Cancelled'), {code: 'CANCELLED'});
    const previous = state.card.items.find(
      item => item.derivationRecord?.index === source.index,
    )?.derivationRecord?.wallets;
    const merged = options?.mode === 'replace' ? [] : [...(previous ?? [])];
    for (const wallet of wallets) {
      if (!merged.some(entry => matchesWalletReference(entry, wallet))) {
        merged.push(wallet);
      }
    }
    const derivations = merged.map(parameters => ({
      ...parameters,
      publicKey: PUBLIC_KEY,
    }));
    return {...metadata(source.index, merged), derivations};
  };
  state.pinSession = {clear: () => state.clears++};
  state.view.$match.$view = () => ({$entries: [state.view]});
  state.entrances = {
    cardStore: state.cardStore,
    walletStorageService: storage,
    monoidCredentialsStore: {createPINSession: () => state.pinSession},
    router: {
      safe: {
        $exact: {},
        copyItems: options => ({$push: () => state.copies.push(options)}),
        setupCard: options => ({$push: () => state.setups.push(options)}),
      },
      $backTo: () => () => state.routes.push('safe'),
    },
    errorService: {
      catch: callback => () => {
        state.finished = Promise.resolve(callback()).catch(error =>
          state.errors.push(error),
        );
      },
    },
  };
  state.render();
  owners.push(state);
  return state;
}

afterEach(() => owners.splice(0).forEach(owner => owner.unmount()));

test('Create bundle passes the current card identity and starts in bundle mode without scanning', () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  state.menuButton().props.onClick();
  const setup = state.popupButton('Create bundle');
  assert.ok(setup);
  setup.props.onClick();
  assert.deepEqual(state.setups, [
    {
      card: {id: state.card.id, publicKey: state.card.publicKey},
      createBundle: true,
    },
  ]);
  assert.equal(state.popup(), undefined);
  assert.deepEqual(state.scans, []);
  state.select(INDEX);
  state.menuButton().props.onClick();
  assert.equal(state.popupButton('Create bundle'), undefined);
});

test('Card actions remains available without a selection and cancelling deletion never starts a scan', () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  assert.equal(state.menuButton().props.disabled, false);
  state.menuButton().props.onClick();
  assert.ok(state.popupButton('Update Access PIN'));
  assert.ok(state.popupButton('Update Secret PIN'));
  assert.equal(state.popupButton('Delete'), undefined);
  state.popup().props.onDismiss();

  state.select(INDEX);
  assert.equal(state.menuButton().props['aria-haspopup'], 'dialog');
  state.menuButton().props.onClick();
  assert.equal(state.popup().props['aria-label'], 'Card actions');
  assert.equal(state.menuButton().props['aria-expanded'], true);
  assert.equal(state.popupButton('Update Access PIN'), undefined);
  assert.equal(state.popupButton('Update Secret PIN'), undefined);
  state.popupButton('Delete').props.onClick();
  assert.equal(state.popup().props['aria-label'], 'Delete items');
  assert.equal(state.popup().props.initialFocus, 'dialog');
  assert.match(
    find(
      state.popup(),
      node => node.type === 'description',
    ).props.children.join(''),
    /1 item and 1 attached record/,
  );
  state.popupButton('Cancel').props.onClick();

  assert.equal(state.popup(), undefined);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.removals, []);
  state.select(INDEX, false);
  assert.equal(state.menuButton().props.disabled, false);
});

for (const kind of ['Access', 'Secret']) {
  test(`an empty card can open ${kind} PIN settings and keeps the menu disabled until completion`, () => {
    const state = mount({items: []});
    state.menuButton().props.onClick();
    assert.equal(state.popupButton('Delete'), undefined);
    const click = state.popupButton(`Update ${kind} PIN`).props.onClick;
    click();
    click();
    const update = find(state.render(), node => node.type === 'pin-update');
    assert.equal(update.props.kind, kind);
    assert.equal(update.props.card, state.card);
    assert.equal(update.props.pinSession, state.pinSession);
    assert.equal(state.menuButton().props.disabled, true);
    assert.equal(state.popup(), undefined);
    update.props.onFinished();
    assert.equal(state.menuButton().props.disabled, false);
    assert.equal(
      find(state.render(), node => node.type === 'pin-update'),
      undefined,
    );
  });
}

test('deleting a selected group and standalone resource removes companions first and retains phone records', async () => {
  const saved = wallet(0);
  const unknown = {index: '90000000000000000003', type: 0x9000, secret: false};
  const state = mount({
    items: [
      ...cardItems(INDEX, [saved]),
      ...cardItems(SECOND_INDEX, [wallet(1)]),
      unknown,
    ],
    keys: [key(INDEX, [saved])],
  });
  const phoneBefore = toJS(state.storage.keys);
  state.filter('all');
  state.select(INDEX);
  state.select(unknown.index);
  state.confirmDelete()();

  assert.equal(state.scans[0].label, 'Scan card to delete');
  assert.equal(state.menuButton().props.disabled, true);
  assert.equal(state.popup(), undefined);
  assert.equal(state.item(INDEX).props.disabled, true);
  assert.deepEqual(state.removals, []);
  await state.tap();
  await state.finish();

  assert.deepEqual(state.removals, [
    metadata(INDEX, [saved]).index,
    INDEX,
    unknown.index,
  ]);
  assert.deepEqual(state.rowIndexes(), [SECOND_INDEX]);
  assert.deepEqual(
    state.card.snapshot().items,
    cardItems(SECOND_INDEX, [wallet(1)]),
  );
  assert.deepEqual(toJS(state.storage.keys), phoneBefore);
  assert.equal(state.menuButton().props.disabled, false);
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.errors, []);
});

test('deletion continues on further cards with the same indices and rejects a finished card', async () => {
  const state = mount({
    items: cardItems(INDEX, [wallet(0)]),
    keys: [key(INDEX, [wallet(0)])],
  });
  state.select(INDEX);
  state.confirmDelete()();
  await state.tap();
  state.scans.at(-1).resolve();
  await new Promise(resolve => setImmediate(resolve));

  const next = state.scans.at(-1);
  assert.equal(next.label, 'Scan next card to delete');
  assert.throws(() => next.validate(state.hello), /Card already done/);
  const removals = [...state.removals];
  state.removals.length = 0;
  await state.tap({...state.hello, publicKey: bytes('05'.repeat(65))});
  assert.deepEqual(state.removals, removals);
  assert.deepEqual(state.rowIndexes(), []);

  next.resolve();
  await new Promise(resolve => setImmediate(resolve));
  state.scans
    .at(-1)
    .reject(Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}));
  await state.finished;
  state.render();
  assert.equal(state.scans.length, 3);
  assert.equal(state.menuButton().props.disabled, false);
  assert.deepEqual(state.errors, []);
});

test('deletion rejects a mismatched full Safe identity before authentication and permits a correct retry', async () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  state.select(INDEX);
  state.confirmDelete()();

  await assert.rejects(
    state.tap({
      ...state.hello,
      publicKey: bytes(`04${'34'.repeat(64)}`),
    }),
    MonoidWrongCardError,
  );
  assert.equal(state.authCount, 0);
  assert.deepEqual(state.removals, []);
  assert.equal(state.card.items.length, 2);

  await state.tap();
  await state.finish();
  assert.equal(state.authCount, 1);
  assert.deepEqual(state.card.items, []);
  assert.deepEqual(state.rowIndexes(), []);
});

test('an acknowledged companion deletion survives a failed root deletion and reopening retries only the root', async () => {
  const saved = wallet(0);
  const state = mount({
    items: cardItems(INDEX, [saved]),
    keys: [key(INDEX, [saved])],
  });
  const phoneBefore = toJS(state.storage.keys);
  const remove = state.applet.remove;
  let failed = false;
  state.applet.remove = async request => {
    const result = await remove(request);
    if (Buffer.from(request.index).toString('hex') === INDEX && !failed) {
      failed = true;
      throw new Error('Card removed');
    }
    return result;
  };
  state.select(INDEX);
  state.confirmDelete()();
  await assert.rejects(state.tap(), /Card removed/);
  await state.dismiss();

  assert.deepEqual(
    state.card.items.map(item => item.index),
    [INDEX],
  );
  assert.deepEqual(toJS(state.card.items[0].derivations), []);
  assert.equal(state.item(INDEX).props.selected, true);
  assert.equal(state.item(INDEX).props.canWrite, true);
  assert.ok(state.menuButton());
  assert.deepEqual(toJS(state.storage.keys), phoneBefore);

  state.confirmDelete()();
  await state.tap();
  await state.finish();
  assert.deepEqual(state.removals, [
    metadata(INDEX, [saved]).index,
    INDEX,
    INDEX,
  ]);
  assert.deepEqual(state.card.items, []);
  assert.deepEqual(toJS(state.storage.keys), phoneBefore);
  assert.equal(state.menuButton().props.disabled, false);
});

test('two confirmation clicks before rerender start only one deletion scan', async () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  state.select(INDEX);
  const click = state.confirmDelete();
  click();
  const finished = state.finished;
  click();
  assert.equal(state.scans.length, 1);

  await state.tap();
  state.scans[0].resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.scans.length, 2);
  state.scans[1].reject(
    Object.assign(new Error('Cancelled'), {code: 'CANCELLED'}),
  );
  await finished;
  assert.deepEqual(state.removals, [metadata(INDEX, [wallet(0)]).index, INDEX]);
  assert.deepEqual(state.card.items, []);
});

test('dismissing an in-flight delete keeps actions blocked until its ACK is published without updating the closed prompt', async () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  const release = deferred();
  const remove = state.applet.remove;
  state.applet.remove = async request => {
    const result = await remove(request);
    await release.promise;
    return result;
  };
  state.select(INDEX);
  const clickDelete = state.confirmDelete();
  clickDelete();
  const rejected = assert.rejects(
    state.tap(),
    error => error.name === 'AbortError' || error.code === 'CANCELLED',
  );
  assert.equal(state.removals.length, 1);
  assert.equal(state.progressUpdates.length, 1);

  let dismissed = false;
  const dismissing = state.dismiss().then(() => {
    dismissed = true;
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(dismissed, false);
  assert.equal(state.menuButton().props.disabled, true);
  assert.equal(state.popup(), undefined);
  assert.equal(state.item(INDEX).props.disabled, true);
  assert.equal(state.button('Import').props.disabled, true);
  assert.equal(state.button('Copy').props.disabled, true);
  clickDelete();
  assert.equal(state.scans.length, 1);
  assert.equal(state.card.items.length, 2);

  release.resolve();
  await Promise.all([rejected, dismissing]);

  assert.equal(dismissed, true);
  assert.deepEqual(state.removals, [metadata(INDEX, [wallet(0)]).index]);
  assert.deepEqual(
    state.card.items.map(item => item.index),
    [INDEX],
  );
  assert.deepEqual(toJS(state.card.items[0].derivations), []);
  assert.equal(state.progressUpdates.length, 1);
  assert.equal(state.item(INDEX).props.disabled, false);
  assert.ok(state.menuButton());
});

for (const cancellation of ['route leave', 'scan cancellation']) {
  test(`${cancellation} during deletion preserves an acknowledged command and prevents subsequent deletes`, async () => {
    const state = mount({
      items: [
        ...cardItems(INDEX, [wallet(0)]),
        ...cardItems(SECOND_INDEX, [wallet(1)]),
      ],
      keys: [key(INDEX, [wallet(0)])],
    });
    const phoneBefore = toJS(state.storage.keys);
    const release = deferred();
    const remove = state.applet.remove;
    state.applet.remove = async request => {
      const result = await remove(request);
      await release.promise;
      return result;
    };
    state.select(INDEX);
    state.select(SECOND_INDEX);
    state.confirmDelete()();
    const tapping = state.tap();
    const rejected = assert.rejects(
      tapping,
      error => error.name === 'AbortError' || error.code === 'CANCELLED',
    );
    assert.equal(state.removals.length, 1);

    if (cancellation === 'route leave') {
      runInAction(() => {
        state.view.$leaving = true;
      });
    } else {
      state.scans[0].controller.abort();
    }
    release.resolve();
    await rejected;
    await state.dismiss();

    assert.deepEqual(state.removals, [metadata(INDEX, [wallet(0)]).index]);
    assert.deepEqual(
      state.card.items.map(item => item.index),
      [INDEX, SECOND_INDEX, metadata(SECOND_INDEX, [wallet(1)]).index],
    );
    assert.deepEqual(toJS(state.card.items[0].derivations), []);
    assert.deepEqual(toJS(state.storage.keys), phoneBefore);
    assert.equal(state.popup(), undefined);
    assert.deepEqual(state.routes, []);
    if (cancellation === 'route leave') assert.ok(state.clears > 0);
  });
}

test('All groups linked derivation records with their key and keeps orphan and unknown resources selectable', async () => {
  const saved = wallet(0);
  const orphan = metadata(SECOND_INDEX, [wallet(1)]);
  const unknown = {index: '90000000000000000003', type: 0x9000, secret: false};
  const state = mount({
    items: [...cardItems(INDEX, [saved]), orphan, unknown],
  });
  const filter = find(state.render(), node => node.type === 'segmented');

  assert.deepEqual(filter.props.options, [
    {value: 'keys', label: 'Keys · 1'},
    {value: 'all', label: 'All · 3'},
  ]);
  assert.deepEqual(state.rowIndexes(), [INDEX]);

  state.filter('all');

  assert.deepEqual(state.rowIndexes(), [INDEX, orphan.index, unknown.index]);
  assert.equal(state.item(metadata(INDEX, [saved]).index), undefined);
  state.select(INDEX);
  assert.equal(state.visible('Import'), true);

  await state.click('Import');

  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [saved]);
  assert.deepEqual(state.card.snapshot().items.slice(-2), [orphan, unknown]);
});

test('Copy passes selected logical key indexes with their full card snapshot for companion expansion', () => {
  const items = [
    ...cardItems(INDEX, [wallet(0)]),
    ...cardItems(SECOND_INDEX, [wallet(1)]),
  ];
  const state = mount({items});

  assert.equal(
    find(state.render(), node => node.type === 'segmented'),
    undefined,
  );
  assert.deepEqual(state.rowIndexes(), [INDEX, SECOND_INDEX]);
  state.select(INDEX);
  state.click('Copy');

  assert.equal(state.copies.length, 1);
  assert.deepEqual(state.copies[0].sourceIndexes, [INDEX]);
  assert.deepEqual(state.copies[0].sourceCard, state.card.snapshot());
  assert.deepEqual(toJS(state.copies[0].sourceCard.items), items);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.writes, []);
});

test('Copy opens distinct flows in HTTP WebViews without crypto.randomUUID', t => {
  const webCrypto = globalThis.crypto;
  t.mock.getter(globalThis, 'crypto', () => ({
    getRandomValues: webCrypto.getRandomValues.bind(webCrypto),
  }));
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  state.select(INDEX);

  state.click('Copy');
  state.click('Copy');

  assert.equal(state.copies.length, 2);
  for (const copy of state.copies) {
    assert.equal(typeof copy.copyId, 'string');
    assert.ok(copy.copyId.length > 0);
    assert.deepEqual(copy.sourceIndexes, [INDEX]);
    assert.deepEqual(copy.sourceCard, state.card.snapshot());
  }
  assert.notEqual(state.copies[0].copyId, state.copies[1].copyId);
  assert.deepEqual(state.scans, []);
});

test('orphan derivations and unknown resources retain independent Copy selection across filters', () => {
  const orphan = metadata(SECOND_INDEX, [wallet(1)]);
  const unknown = {index: '90000000000000000003', type: 0x9000, secret: false};
  const state = mount({
    items: [...cardItems(INDEX, [wallet(0)]), orphan, unknown],
  });
  state.filter('all');
  state.select(orphan.index);
  state.select(unknown.index);
  assert.equal(state.visible('Import'), false);

  state.filter('keys');

  assert.deepEqual(state.rowIndexes(), [INDEX]);
  const hidden = find(state.render(), node => node.props?.role === 'status');
  assert.equal(
    hidden.props.children.join(''),
    '2 selected items are hidden by this filter.',
  );
  state.click('Copy');

  assert.deepEqual(state.copies[0].sourceIndexes, [
    orphan.index,
    unknown.index,
  ]);
  assert.deepEqual(toJS(state.copies[0].sourceCard.items).slice(-2), [
    orphan,
    unknown,
  ]);
});

test('divergent derivations merge into the phone before offering the merged card update', async () => {
  const common = wallet(0);
  const cardOnly = wallet(1);
  const phoneOnly = wallet(2);
  const state = mount({
    items: cardItems(INDEX, [common, cardOnly]),
    keys: [key(INDEX, [common, phoneOnly], phoneOnly)],
  });
  state.select(INDEX);
  assert.equal(state.item(INDEX).props.state, 'outdated');
  assert.equal(state.item(INDEX).props.canWrite, false);
  assert.equal(state.visible('Update'), true);
  assert.equal(state.visible('Update card'), false);

  await state.click('Update');

  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [
    common,
    phoneOnly,
    cardOnly,
  ]);
  assert.deepEqual(
    toJS(state.storage.keys[0].defaultWallet),
    getWalletReference(phoneOnly),
  );
  assert.equal(state.item(INDEX).props.state, 'up-to-date');
  assert.equal(state.item(INDEX).props.canWrite, true);
  assert.equal(state.visible('Update card'), true);

  state.click('Update card');
  assert.equal(state.scans[0].label, 'Scan card to update');
  await state.tap();
  await state.finish();

  assert.deepEqual(
    state.writes[0].wallets.map(entry => entry.path),
    [common.path, phoneOnly.path, cardOnly.path],
  );
  assert.equal(state.item(INDEX).props.state, 'up-to-date');
  assert.equal(state.item(INDEX).props.canWrite, false);
  assert.equal(state.visible('Update card'), false);
  assert.deepEqual(state.routes, []);
});

test('a sparse card preview uses the matching Safe default address without reading the card', () => {
  const first = wallet(7);
  const preferred = wallet(9, OTHER_PUBLIC_KEY);
  const state = mount({
    items: sparseCardItems(INDEX, [first, preferred]),
    keys: [key(INDEX, [first, preferred], preferred)],
  });

  assert.equal(state.item(INDEX).props.empty, false);
  assert.equal(state.item(INDEX).props.path, preferred.path);
  assert.equal(
    state.item(INDEX).props.address,
    getWalletData(preferred).address,
  );
  assert.equal(state.visible('Derive'), false);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.keyViews, []);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [first, preferred]);
});

test('switching networks prefers a Safe custom-path address over a cached preview and leaves missing networks un-derived', () => {
  const evm = wallet(7);
  const localSegwit = {
    ...wallet(5, OTHER_PUBLIC_KEY),
    addressType: 'bitcoin-segwit',
    path: "m/84'/0'/3'/0/5",
  };
  const cachedSegwit = {
    ...wallet(0),
    addressType: 'bitcoin-segwit',
    path: "m/84'/0'/0'/0/0",
  };
  const state = mount({
    items: sparseCardItems(INDEX, [evm, localSegwit], [cachedSegwit], evm),
    keys: [key(INDEX, [evm, localSegwit])],
  });

  state.changeAddressType(INDEX, 'bitcoin-segwit');
  assert.equal(state.item(INDEX).props.path, localSegwit.path);
  assert.equal(
    state.item(INDEX).props.address,
    getWalletData(localSegwit).address,
  );
  assert.equal(state.visible('Derive'), false);

  state.changeAddressType(INDEX, 'solana');
  assert.equal(state.item(INDEX).props.address, undefined);
  assert.equal(state.visible('Derive'), true);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.keyViews, []);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [evm, localSegwit]);
});

test('a sparse recorded list stays downloadable and reads only its missing address after explicit Update', async () => {
  const common = wallet(0);
  const cardOnly = wallet(7);
  const state = mount({
    items: sparseCardItems(INDEX, [common, cardOnly], [common], common),
    keys: [key(INDEX, [common])],
  });
  const beforeRecord = toJS(state.card.items[1].derivationRecord);
  state.select(INDEX);
  assert.equal(state.item(INDEX).props.empty, false);
  assert.equal(state.item(INDEX).props.state, 'outdated');
  assert.equal(state.item(INDEX).props.syncDirection, 'download');
  assert.equal(state.visible('Update'), true);
  assert.deepEqual(state.scans, []);

  state.click('Update');
  assert.equal(state.scans.length, 1);
  assert.equal(state.scans[0].label, 'Scan card to import');
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [common]);
  await state.tap();
  await state.finish();

  assert.deepEqual(state.keyViews, [
    getAppletKey({type: 'seed', index: INDEX}, 'evm', cardOnly.path),
  ]);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [common, cardOnly]);
  assert.deepEqual(toJS(state.card.items[1].derivationRecord), beforeRecord);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.aliasWrites, []);
  assert.deepEqual(state.errors, []);
});

test('Import resolves the complete recorded list without silently importing its unrecorded default preview', async () => {
  const first = wallet(7);
  const second = wallet(9);
  const preview = wallet(0);
  const state = mount({
    items: sparseCardItems(INDEX, [first, second], [], preview),
  });
  state.select(INDEX);
  assert.equal(state.item(INDEX).props.empty, false);
  assert.equal(state.visible('Import'), true);
  state.click('Import');
  await state.tap();
  await state.finish();

  assert.deepEqual(state.keyViews, [
    getAppletKey({type: 'seed', index: INDEX}, 'evm', first.path),
    getAppletKey({type: 'seed', index: INDEX}, 'evm', second.path),
  ]);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [first, second]);
  assert.equal(state.item(INDEX).props.path, preview.path);
  assert.equal(
    state.visible('Update'),
    true,
    'preview import remains a separate action',
  );
  assert.equal(state.visible('Back to Safe'), false);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.errors, []);
});

test('a sparse card cache can download an alias using all recorded addresses already known in Safe without scanning', async () => {
  const common = wallet(0);
  const known = wallet(7);
  const items = sparseCardItems(INDEX, [common, known], [common], common);
  items[0].alias = 'Card alias';
  const local = {...key(INDEX, [common, known]), alias: 'Phone alias'};
  const state = mount({items, keys: [local]});
  state.select(INDEX);

  await state.click('Update');

  assert.equal(state.storage.keys[0].alias, 'Card alias');
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [common, known]);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.keyViews, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.errors, []);
});

test('a failed deferred address read does not import a partial recorded list or mutate its metadata', async () => {
  const common = wallet(0);
  const first = wallet(7);
  const second = wallet(9);
  const state = mount({
    items: sparseCardItems(INDEX, [common, first, second], [common], common),
    keys: [key(INDEX, [common])],
  });
  const beforeRecord = toJS(state.card.items[1].derivationRecord);
  const viewKey = state.applet.viewKey;
  state.applet.viewKey = async request => {
    const result = await viewKey(request);
    if (state.keyViews.length === 2) throw new Error('Address read failed');
    return result;
  };
  state.select(INDEX);
  state.click('Update');
  await assert.rejects(state.tap(), /Address read failed/);
  await state.dismiss();

  assert.deepEqual(toJS(state.storage.keys[0].wallets), [common]);
  assert.deepEqual(toJS(state.card.items[1].derivationRecord), beforeRecord);
  assert.deepEqual(state.writes, []);
  assert.equal(state.item(INDEX).props.state, 'outdated');
  assert.equal(state.visible('Update'), true);
});

test('a batch imports missing recorded addresses and persists another selected preview in one scan', async () => {
  const common = wallet(0);
  const cardOnly = wallet(7);
  const preview = wallet(3);
  const state = mount({
    items: [
      ...sparseCardItems(INDEX, [common, cardOnly], [common], common),
      ...cardItems(SECOND_INDEX, [], preview),
    ],
    keys: [key(INDEX, [common])],
  });
  state.select(INDEX);
  state.select(SECOND_INDEX);
  state.click('Import');
  assert.equal(state.scans.length, 1);
  await state.tap();
  await state.finish();

  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.keyViews, [
    getAppletKey({type: 'seed', index: INDEX}, 'evm', cardOnly.path),
  ]);
  assert.deepEqual(
    state.writes.map(write => write.key.index),
    [SECOND_INDEX],
  );
  assert.deepEqual(toJS(state.storage.indexToKeyMap.get(INDEX).wallets), [
    common,
    cardOnly,
  ]);
  assert.deepEqual(
    toJS(state.storage.indexToKeyMap.get(SECOND_INDEX).wallets),
    [preview],
  );
  assert.deepEqual(state.errors, []);
});

test('a pending download does not block an independent upload in the selected batch', async () => {
  const state = mount({
    items: [
      ...cardItems(INDEX, [wallet(0), wallet(1)]),
      ...cardItems(SECOND_INDEX, [wallet(0)]),
    ],
    keys: [
      key(INDEX, [wallet(0), wallet(2)]),
      key(SECOND_INDEX, [wallet(0), wallet(3)]),
    ],
  });
  state.select(INDEX);
  state.select(SECOND_INDEX);

  assert.equal(state.visible('Update'), true);
  assert.equal(state.visible('Update card'), true);
  await state.click('Update');

  assert.deepEqual(state.scans, []);
  assert.equal(state.visible('Update card'), true);
  assert.deepEqual(
    state.storage.indexToKeyMap
      .get(SECOND_INDEX)
      .wallets.map(item => item.path),
    [wallet(0).path, wallet(3).path],
  );
});

test('switching a card-only difference to upload propagates a local deletion without changing the selection', async () => {
  const retained = wallet(0);
  const removed = wallet(1);
  const state = mount({
    items: cardItems(INDEX, [retained, removed]),
    keys: [key(INDEX, [retained])],
  });
  state.select(INDEX);

  assert.equal(state.item(INDEX).props.syncDirection, 'download');
  state.toggleDirection(INDEX);
  assert.equal(state.item(INDEX).props.selected, true);
  assert.equal(state.item(INDEX).props.syncDirection, 'upload');
  assert.equal(state.visible('Update'), false);
  assert.equal(state.visible('Update card'), true);
  assert.deepEqual(state.writes, []);
  assert.equal(state.card.items[0].derivations.length, 2);

  state.click('Update card');
  await state.tap();
  await state.finish();

  assert.deepEqual(state.writes[0].options, {
    mode: 'replace',
    expected: [retained, removed].map(getWalletReference),
  });
  assert.deepEqual(toJS(state.card.items[0].derivations), [retained]);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [retained]);
  assert.equal(state.item(INDEX).props.syncDirection, undefined);
  assert.equal(state.visible('Update card'), false);
});

test('manual upload replaces equal-length divergent lists instead of silently merging them', async () => {
  const state = mount({
    items: cardItems(INDEX, [wallet(0), wallet(1)]),
    keys: [key(INDEX, [wallet(0), wallet(2)])],
  });
  state.select(INDEX);
  state.toggleDirection(INDEX);
  state.click('Update card');
  await state.tap();
  await state.finish();

  assert.deepEqual(toJS(state.card.items[0].derivations), [
    wallet(0),
    wallet(2),
  ]);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [wallet(0), wallet(2)]);
});

test('a single update exposes address progress and counts completion only after the write acknowledgement', async () => {
  const state = mount({
    items: cardItems(INDEX, [wallet(0)]),
    keys: [key(INDEX, [wallet(0), wallet(1)])],
  });
  const release = deferred();
  const write = state.write;
  state.write = async (...args) => {
    const progress = args[5];
    progress({stage: 'checking', current: 0, total: 1});
    progress({stage: 'reading', current: 0, total: 2});
    progress({stage: 'reading', current: 1, total: 2});
    progress({stage: 'reading', current: 2, total: 2});
    progress({stage: 'writing', current: 0, total: 1});
    await release.promise;
    progress({stage: 'writing', current: 1, total: 1});
    return write(...args);
  };
  state.select(INDEX);
  state.click('Update card');
  const tapping = state.tap();
  const renderProgress = node =>
    typeof node.type === 'function' ? node.type(node.props) : node;
  const reading = state.progressUpdates
    .map(renderProgress)
    .filter(node => node.props?.children === 'Reading addresses');
  assert.deepEqual(
    reading.map(node => [node.props.current, node.props.total]),
    [
      [0, 2],
      [1, 2],
      [2, 2],
    ],
  );
  assert.equal(state.progressUpdates.at(-1).props.current, 0);
  assert.equal(state.progressUpdates.at(-1).props.total, 1);
  release.resolve();
  await tapping;
  await state.finish();
  assert.equal(state.progressUpdates.at(-1).props.current, 1);
});

test('a single derived address remains at zero until its read finishes', async () => {
  const state = mount({items: [{index: INDEX, type: 'seed', secret: true}]});
  const release = deferred();
  const read = state.applet.viewKey;
  state.applet.viewKey = async request => {
    await release.promise;
    return read(request);
  };
  state.select(INDEX);
  state.click('Derive');
  const tapping = state.tap();
  assert.equal(state.progressUpdates.at(-1).props.current, 0);
  assert.equal(state.progressUpdates.at(-1).props.total, 1);
  release.resolve();
  await tapping;
  await state.finish();
  assert.equal(state.progressUpdates.at(-1).props.current, 1);
});

test('switching an unselected key network exposes Derive even before its recorded addresses are imported', async () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  state.changeAddressType(INDEX, 'bitcoin-segwit');

  assert.equal(state.item(INDEX).props.selected, false);
  assert.equal(state.item(INDEX).props.address, undefined);
  assert.equal(state.visible('Derive'), true);
  assert.equal(state.visible('Import'), false);
  state.click('Derive');
  await state.tap();
  await state.finish();

  assert.equal(state.item(INDEX).props.path, "m/84'/0'/0'/0/0");
  assert.ok(state.item(INDEX).props.address);
  assert.equal(state.item(INDEX).props.selected, false);
  assert.equal(state.visible('Derive'), false);
  assert.deepEqual(toJS(state.card.items[0].derivations), [wallet(0)]);
  assert.deepEqual(toJS(state.card.items[1].derivationRecord.wallets), [
    getWalletReference(wallet(0)),
  ]);
  assert.deepEqual(state.storage.keys, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.aliasWrites, []);
});

test('Derive previews every missing row without selection and Import persists only the selected key', async () => {
  const state = mount({
    items: [...cardItems(INDEX, []), ...cardItems(SECOND_INDEX, [])],
  });
  state.changeAddressType(INDEX, 'bitcoin-segwit');
  state.changeAddressType(SECOND_INDEX, 'bitcoin-segwit');
  state.click('Derive');
  await state.tap();
  await state.finish();

  assert.deepEqual(
    state.keyViews.map(({index}) => Buffer.from(index).toString('hex')),
    [INDEX, SECOND_INDEX],
  );
  for (const index of [INDEX, SECOND_INDEX]) {
    assert.ok(state.item(index).props.address);
    assert.equal(state.item(index).props.selected, false);
  }
  assert.equal(state.visible('Derive'), false);
  assert.equal(state.visible('Import'), false);
  assert.deepEqual(state.storage.keys, []);
  assert.deepEqual(state.writes, []);
  assert.equal(state.card.items.length, 2);

  state.select(SECOND_INDEX);
  state.click('Import');
  await state.tap();
  await state.finish();

  assert.deepEqual(
    state.writes.map(({key}) => key.index),
    [SECOND_INDEX],
  );
  assert.deepEqual(
    state.storage.keys.map(({index}) => index),
    [SECOND_INDEX],
  );
  assert.equal(state.storage.keys[0].wallets[0].addressType, 'bitcoin-segwit');
  assert.equal(
    state.card.items.find(item => item.derivationRecord)?.derivationRecord
      .index,
    SECOND_INDEX,
  );
});

test('an unselected missing preview does not block importing or copying selected ready keys', async () => {
  const state = mount({
    items: [
      ...cardItems(INDEX, [wallet(0)]),
      {index: SECOND_INDEX, type: 'seed', secret: true},
    ],
  });
  state.select(INDEX);
  assert.equal(state.visible('Derive'), true);
  assert.equal(state.visible('Copy'), true);
  await state.click('Import');

  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(
    state.storage.keys.map(({index}) => index),
    [INDEX],
  );
  assert.equal(state.item(SECOND_INDEX).props.selected, false);
  assert.equal(state.item(SECOND_INDEX).props.address, undefined);
  assert.equal(state.visible('Derive'), true);
});

test('uploading an empty phone list preserves an empty companion, the key and copy availability', async () => {
  const state = mount({
    items: cardItems(INDEX, [wallet(0)]),
    keys: [key(INDEX, [])],
  });
  state.select(INDEX);
  state.toggleDirection(INDEX);
  state.click('Update card');
  await state.tap();
  await state.finish();

  assert.deepEqual(state.writes[0].wallets, []);
  assert.deepEqual(state.writes[0].options.expected, [
    getWalletReference(wallet(0)),
  ]);
  assert.deepEqual(toJS(state.card.items[0].derivations), []);
  assert.deepEqual(toJS(state.card.items[0].refs), {});
  assert.deepEqual(toJS(state.card.items[1].derivationRecord.wallets), []);
  assert.equal(state.storage.keys.length, 1);
  assert.equal(state.item(INDEX).props.empty, true);
  assert.equal(state.item(INDEX).props.syncDirection, undefined);
  assert.equal(state.visible('Derive'), false);
  assert.equal(state.visible('Import'), false);
  assert.equal(state.visible('Update'), false);
  state.click('Copy');
  assert.deepEqual(
    state.copies[0].sourceCard.items[1].derivationRecord.wallets,
    [],
  );
});

test('a fresh phone can import an explicit empty card list without deriving or writing any address', async () => {
  const state = mount({
    items: [
      {index: INDEX, type: 'seed', secret: true, derivations: []},
      metadata(INDEX, []),
    ],
  });
  state.select(INDEX);
  assert.equal(state.item(INDEX).props.onChangeSyncDirection, undefined);
  assert.equal(state.item(INDEX).props.empty, true);
  assert.equal(state.visible('Derive'), false);
  assert.equal(state.visible('Update card'), false);
  await state.click('Import');

  assert.deepEqual(state.scans, []);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), []);
  assert.equal(state.storage.keys[0].defaultWallet, undefined);
  assert.equal(state.visible('Back to Safe'), true);
});

test('an explicit empty record ignores a cached default preview until the user asks to preview an address', async () => {
  const state = mount({
    items: [...cardItems(INDEX, []), metadata(INDEX, [])],
    keys: [key(INDEX, [])],
  });
  state.select(INDEX);
  assert.equal(state.item(INDEX).props.empty, true);
  assert.equal(state.visible('Update'), false);
  assert.equal(state.visible('Derive'), false);

  state.changeAddressType(INDEX, 'evm');
  assert.equal(state.item(INDEX).props.empty, false);
  assert.equal(state.visible('Update'), true);
  state.click('Update');
  await state.tap();
  await state.finish();
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [wallet(0)]);
});

test('mixed directions update only their chosen keys and an empty upload does not block downloading another key', async () => {
  const state = mount({
    items: [
      ...cardItems(INDEX, [wallet(0)]),
      ...cardItems(SECOND_INDEX, [wallet(1)]),
    ],
    keys: [key(INDEX, [])],
  });
  state.select(INDEX);
  state.select(SECOND_INDEX);
  state.toggleDirection(INDEX);
  assert.equal(state.visible('Import'), true);
  assert.equal(state.visible('Update card'), true);

  state.click('Update card');
  await state.tap();
  await state.finish();
  assert.deepEqual(
    state.writes.map(write => write.key.index),
    [INDEX],
  );
  assert.equal(state.storage.indexToKeyMap.has(SECOND_INDEX), false);
  assert.equal(state.visible('Derive'), false);
  await state.click('Import');
  assert.deepEqual(toJS(state.storage.indexToKeyMap.get(INDEX).wallets), []);
  assert.deepEqual(
    toJS(state.storage.indexToKeyMap.get(SECOND_INDEX).wallets),
    [wallet(1)],
  );
});

test('card alias clearing downloads as an explicit empty value and phone alias clearing uploads', async () => {
  const local = {...key(INDEX, [wallet(0)]), alias: 'Phone name'};
  const state = mount({items: cardItems(INDEX, [wallet(0)]), keys: [local]});
  state.select(INDEX);
  await state.click('Update');
  assert.equal(state.storage.keys[0].alias, '');
  assert.deepEqual(state.scans, []);

  runInAction(() => {
    state.card.items[0].alias = 'Card name';
  });
  state.toggleDirection(INDEX);
  state.click('Update card');
  await state.tap();
  await state.finish();
  assert.deepEqual(state.aliasWrites, [{index: bytes(INDEX), alias: ''}]);
  assert.equal(state.card.items[0].alias, '');
  assert.equal(state.storage.keys[0].alias, '');
});

test('a card change after choosing upload retains the chosen snapshot and leaves the stored snapshot untouched on failure', async () => {
  const initial = [wallet(0), wallet(1)];
  const state = mount({
    items: cardItems(INDEX, initial),
    keys: [key(INDEX, [wallet(0)])],
  });
  state.select(INDEX);
  state.toggleDirection(INDEX);
  const failure = new Error('Card addresses changed, scan card again');
  state.write = async (_applet, _key, _wallets, _signal, options) => {
    assert.deepEqual(options, {
      mode: 'replace',
      expected: initial.map(getWalletReference),
    });
    throw failure;
  };
  state.click('Update card');
  await assert.rejects(state.tap(), failure);
  await state.dismiss(failure);
  assert.deepEqual(toJS(state.card.items[0].derivations), initial);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [wallet(0)]);
});

test('native addresses have the same explicit replacement semantics as derived addresses', async () => {
  const index = '03010000000000000004';
  const evm = {
    addressType: 'evm',
    seed: undefined,
    curve: undefined,
    path: undefined,
    publicKey: PUBLIC_KEY,
  };
  const segwit = {...evm, addressType: 'bitcoin-segwit'};
  const state = mount({
    items: [
      {
        index,
        type: 'secp256k1',
        secret: true,
        ref: {...evm, address: getWalletData(evm).address},
        derivations: [evm, segwit],
      },
      metadata(index, [evm, segwit]),
    ],
    keys: [{index, type: 'secp256k1', alias: undefined, wallets: [evm]}],
  });
  state.select(index);
  state.toggleDirection(index);
  state.click('Update card');
  await state.tap();
  await state.finish();

  assert.deepEqual(state.writes[0].options, {
    mode: 'replace',
    expected: [evm, segwit].map(getWalletReference),
  });
  assert.deepEqual(toJS(state.card.items[0].derivations), [evm]);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [evm]);
  assert.equal(state.item(index).props.syncDirection, undefined);
});

test('dismissal during an upload waits for the write acknowledgement and never restores deleted addresses', async () => {
  const state = mount({
    items: cardItems(INDEX, [wallet(0), wallet(1)]),
    keys: [key(INDEX, [wallet(0)])],
  });
  const release = deferred();
  const write = state.write;
  state.write = async (...args) => {
    const result = await write(...args);
    await release.promise;
    return result;
  };
  state.select(INDEX);
  state.toggleDirection(INDEX);
  state.click('Update card');
  const tapping = state.tap();
  let dismissed = false;
  const dismissing = state.dismiss().then(() => {
    dismissed = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dismissed, false);
  assert.equal(state.item(INDEX).props.disabled, true);
  assert.equal(state.writes.length, 1);
  const progressBefore = state.progressUpdates.length;

  release.resolve();
  await Promise.all([tapping, dismissing]);
  assert.equal(state.item(INDEX).props.disabled, false);
  assert.deepEqual(toJS(state.card.items[0].derivations), [wallet(0)]);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [wallet(0)]);
  assert.equal(state.progressUpdates.length, progressBefore);
});

test('importing a preview does not save unrelated phone records to the card or import newly discovered card records', async () => {
  const known = wallet(0);
  const phoneOnly = wallet(1);
  const preview = wallet(2);
  const discovered = wallet(3);
  const state = mount({
    items: cardItems(INDEX, [known], preview),
    keys: [key(INDEX, [known, phoneOnly])],
  });
  const write = state.write;
  state.write = async (...args) => {
    await write(...args);
    return {
      ...metadata(INDEX, [known, preview, discovered]),
      derivations: [known, preview, discovered],
    };
  };
  state.select(INDEX);
  state.click('Update');
  await state.tap();
  await state.finish();

  assert.deepEqual(state.writes[0].wallets, [getWalletReference(preview)]);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [
    known,
    phoneOnly,
    preview,
  ]);
  assert.deepEqual(toJS(state.card.items[0].derivations), [
    known,
    preview,
    discovered,
  ]);
  assert.equal(state.visible('Update'), true);
  assert.equal(state.visible('Back to Safe'), false);
});

test('a recorded derivation with a different public key cannot silently overwrite local data in either direction', async () => {
  const saved = wallet(0);
  const state = mount({
    items: cardItems(INDEX, [saved]),
    keys: [key(INDEX, [wallet(0, OTHER_PUBLIC_KEY), wallet(1)])],
  });
  state.select(INDEX);
  assert.equal(state.visible('Update'), true);
  assert.equal(state.visible('Update card'), false);
  assert.equal(state.item(INDEX).props.canWrite, false);

  await state.click('Update');

  assert.deepEqual(state.scans, []);
  assert.equal(state.storage.keys[0].wallets[0].publicKey, OTHER_PUBLIC_KEY);
  assert.match(state.errors[0].message, /public key does not match/);
  state.toggleDirection(INDEX);
  await state.click('Update card');
  assert.deepEqual(state.scans, []);
  assert.equal(state.errors.length, 2);
  assert.match(state.errors[1].message, /public key does not match/);
});

test('an unrecorded preview does not turn the first card-to-phone merge into a card write', async () => {
  const common = wallet(0);
  const cardOnly = wallet(1);
  const phoneOnly = wallet(2);
  const preview = wallet(3);
  const state = mount({
    items: cardItems(INDEX, [common, cardOnly], preview),
    keys: [key(INDEX, [common, phoneOnly], phoneOnly)],
  });
  state.select(INDEX);

  await state.click('Update');

  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(toJS(state.storage.keys[0].wallets), [
    common,
    phoneOnly,
    cardOnly,
  ]);
  assert.equal(state.item(INDEX).props.path, preview.path);
  assert.equal(state.visible('Update'), true);
  assert.equal(state.visible('Back to Safe'), false);
});

test('an acknowledged first import remains saved and the second can retry after dismissing a failed batch', async () => {
  const state = mount({
    items: [...cardItems(INDEX, []), ...cardItems(SECOND_INDEX, [])],
  });
  state.select(INDEX);
  state.select(SECOND_INDEX);
  const write = state.write;
  let failed = false;
  state.write = async (...args) => {
    const result = await write(...args);
    if (args[1].index === SECOND_INDEX && !failed) {
      failed = true;
      throw new Error('Card write failed');
    }
    return result;
  };

  state.click('Import');
  assert.equal(state.storage.keys.length, 0);
  await assert.rejects(state.tap(), /Card write failed/);
  assert.deepEqual(
    state.storage.keys.map(item => item.index),
    [INDEX],
  );
  await state.dismiss();

  assert.equal(state.item(INDEX).props.selected, true);
  assert.equal(state.item(SECOND_INDEX).props.selected, true);
  assert.equal(state.visible('Import'), true);
  state.click('Import');
  await state.tap();
  await state.finish();

  assert.deepEqual(
    state.writes.map(request => request.key.index),
    [INDEX, SECOND_INDEX, SECOND_INDEX],
  );
  assert.deepEqual(
    state.storage.keys.map(item => item.index),
    [INDEX, SECOND_INDEX],
  );
  assert.equal(state.visible('Back to Safe'), true);
  assert.ok(
    state.scanOptions.every(
      options => options.allowSetup && options.pinSession === state.pinSession,
    ),
  );
});

test('card update rejects a different full Safe identity before authentication', async () => {
  const state = mount({
    items: cardItems(INDEX, [wallet(0)]),
    keys: [key(INDEX, [wallet(0), wallet(1)])],
  });
  state.select(INDEX);
  state.click('Update card');

  await assert.rejects(
    state.tap({
      ...state.hello,
      publicKey: bytes(`04${'34'.repeat(64)}`),
    }),
    MonoidWrongCardError,
  );
  assert.equal(state.authCount, 0);
  assert.deepEqual(state.writes, []);
  await state.tap();
  await state.finish();
  assert.equal(state.writes.length, 1);
});

test('two clicks before rerender start only one card update', async () => {
  const state = mount({
    items: cardItems(INDEX, [wallet(0)]),
    keys: [key(INDEX, [wallet(0), wallet(1)])],
  });
  state.select(INDEX);
  const click = state.button('Update card').props.onClick;
  click();
  const finished = state.finished;
  click();

  assert.equal(state.scans.length, 1);
  await state.tap();
  state.scans[0].resolve();
  await finished;
  assert.equal(state.writes.length, 1);
});

for (const source of ['card', 'phone']) {
  test(`an equivalent ${source} derivation skips the preview scan but imports SegWit as a separate record after writing`, async () => {
    const known = {...wallet(0), path: "m/84'/0'/0'/0/0"};
    const segwit = {...known, addressType: 'bitcoin-segwit'};
    const state = mount({
      items: cardItems(INDEX, source === 'card' ? [known] : []),
      keys: source === 'phone' ? [key(INDEX, [known])] : [],
    });
    state.select(INDEX);
    state.changeAddressType(INDEX, 'bitcoin-segwit');

    assert.equal(state.item(INDEX).props.addressType, 'bitcoin-segwit');
    assert.equal(state.item(INDEX).props.path, known.path);
    assert.equal(
      state.item(INDEX).props.address,
      getWalletData(segwit).address,
    );
    assert.equal(state.visible('Derive'), false);
    assert.deepEqual(state.scans, []);
    assert.equal(
      state.storage.indexToKeyMap
        .get(INDEX)
        ?.wallets.some(entry => entry.addressType === 'bitcoin-segwit') ??
        false,
      false,
    );

    if (source === 'card') {
      await state.click('Import');
      assert.deepEqual(state.scans, []);
      assert.deepEqual(toJS(state.storage.indexToKeyMap.get(INDEX).wallets), [
        known,
      ]);
    }
    state.click('Update');
    assert.equal(state.scans.length, 1);
    assert.equal(state.scans[0].label, 'Scan card to import');
    assert.deepEqual(state.writes, []);
    await state.tap();
    await state.finish();

    assert.deepEqual(toJS(state.storage.indexToKeyMap.get(INDEX).wallets), [
      known,
      segwit,
    ]);
    assert.deepEqual(state.writes[0].wallets, [getWalletReference(segwit)]);
    assert.equal(state.item(INDEX).props.state, 'up-to-date');
    assert.equal(state.visible('Back to Safe'), true);
    assert.deepEqual(state.errors, []);
  });
}

test('a new raw key records and imports only the previewed address before showing completion', async () => {
  const index = '03010000000000000003';
  const ref = {addressType: 'evm', publicKey: PUBLIC_KEY};
  const state = mount({
    items: [
      {
        index,
        type: 'secp256k1',
        secret: true,
        ref: {...ref, address: getWalletData(ref).address},
      },
    ],
  });
  state.select(index);

  state.click('Import');
  await state.tap();
  await state.finish();

  assert.equal(state.scans.length, 1);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(
    state.storage.indexToKeyMap
      .get(index)
      .wallets.map(wallet => wallet.addressType),
    ['evm'],
  );
  assert.equal(state.item(index).props.state, 'up-to-date');
  assert.equal(state.visible('Back to Safe'), true);
  assert.deepEqual(state.errors, []);
});

test('Create key offers a dismissible second menu on an empty card without a Back button', () => {
  const state = mount({items: []});
  state.menuButton().props.onClick();
  state.popupButton('Create key').props.onClick();

  for (const label of ['seed', 'secp256k1', 'secp256r1', 'ed25519']) {
    assert.ok(state.popupButton(label), `${label} should be available`);
  }
  assert.equal(state.popupButton('Back'), undefined);
  assert.equal(state.popupButton('master'), undefined);
  state.popup().props.onDismiss();
  assert.equal(state.popup(), undefined);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.creations, []);
});

test('the optional network filter limits key types without creating anything and resets when reopened', () => {
  const state = mount({items: []});
  state.menuButton().props.onClick();
  state.popupButton('Create key').props.onClick();
  const network = () =>
    find(
      state.popup(),
      node =>
        node.type === 'segmented' && node.props['aria-label'] === 'Key network',
    );
  const available = () =>
    ['seed', 'secp256k1', 'secp256r1', 'ed25519'].filter(label =>
      state.popupButton(label),
    );

  assert.equal(network().props.value, undefined);
  assert.equal(network().props.allowDeselect, true);
  assert.deepEqual(available(), ['seed', 'secp256k1', 'secp256r1', 'ed25519']);
  for (const chain of ['evm', 'bitcoin']) {
    network().props.onChange(chain);
    assert.equal(network().props.value, chain);
    assert.deepEqual(available(), ['seed', 'secp256k1']);
  }
  network().props.onChange('solana');
  assert.deepEqual(available(), ['seed', 'ed25519']);
  network().props.onChange(undefined);
  assert.deepEqual(available(), ['seed', 'secp256k1', 'secp256r1', 'ed25519']);

  network().props.onChange('solana');
  state.popup().props.onDismiss();
  state.menuButton().props.onClick();
  state.popupButton('Create key').props.onClick();
  assert.equal(network().props.value, undefined);
  assert.ok(state.popupButton('secp256r1'));
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.creations, []);
});

test('creating a seed through the Solana filter reads its Solana address immediately', async () => {
  const state = mount({items: []});
  const publicKey = '12'.repeat(32);
  state.applet.viewKey = async request => {
    state.keyViews.push(request);
    return {publicKey: bytes(publicKey)};
  };
  state.menuButton().props.onClick();
  state.popupButton('Create key').props.onClick();
  find(
    state.popup(),
    node =>
      node.type === 'segmented' && node.props['aria-label'] === 'Key network',
  ).props.onChange('solana');
  state.popupButton('seed').props.onClick();
  await state.tap();
  await state.finish();

  assert.deepEqual(state.creations, [{type: 'seed', length: 64}]);
  assert.deepEqual(state.keyViews, [
    {
      type: 'seed',
      index: bytes(CREATED_INDEX),
      derivation: {
        type: 'slip10',
        curve: 'ed25519',
        path: bytes('8000002c800001f58000000080000000'),
      },
    },
  ]);
  const created = state.card.items[0];
  assert.equal(created.ref.addressType, 'solana');
  assert.equal(created.ref.path, "m/44'/501'/0'/0'");
  assert.equal(created.ref.publicKey, publicKey);
  assert.equal(state.item(CREATED_INDEX).props.addressType, 'solana');
  assert.equal(state.item(CREATED_INDEX).props.address, created.ref.address);
  assert.equal(state.storage.keys.length, 0);
});

test('creating a key on an empty card reads it and adds the canonical and displayed item without importing it', async () => {
  const state = mount({items: []});
  state.createKey();
  const scan = state.scans[0];

  assert.equal(state.menuButton().props.disabled, true);
  assert.equal(scan.options.retryOnError, false);
  assert.equal(scan.options.pinSession, state.pinSession);
  assert.equal(scan.options.allowSetup, true);
  assert.equal(scan.options.auth, 'access');
  await state.tap();
  assert.equal(state.item(CREATED_INDEX).props.selected, false);
  await state.finish();

  assert.deepEqual(state.creations, [{type: 'secp256k1'}]);
  assert.deepEqual(state.views, [{index: bytes(CREATED_INDEX)}]);
  assert.deepEqual(state.keyViews, [
    {type: 'secp256k1', index: bytes(CREATED_INDEX)},
  ]);
  assert.deepEqual(state.rowIndexes(), [CREATED_INDEX]);
  const created = state.card.items[0];
  assert.equal(created.type, 'secp256k1');
  assert.equal(created.secret, true);
  assert.equal(created.ref.publicKey, PUBLIC_KEY);
  assert.equal(state.item(CREATED_INDEX).type, 'key-item');
  assert.equal(state.item(CREATED_INDEX).props.address, created.ref.address);
  assert.equal(state.item(CREATED_INDEX).props.state, 'new');
  assert.equal(state.item(CREATED_INDEX).props.selected, true);
  assert.equal(state.storage.keys.length, 0);

  state.click('Copy');
  assert.deepEqual(state.copies[0].sourceIndexes, [CREATED_INDEX]);
  assert.deepEqual(state.copies[0].sourceCard, state.card.snapshot());
  assert.equal(state.copies[0].sourceCard.items[0].ref.publicKey, PUBLIC_KEY);
});

for (const [label, request, addressType] of [
  ['seed', {type: 'seed', length: 64}, 'evm'],
  ['ed25519', {type: 'ed25519'}, 'solana'],
]) {
  test(`creating ${label} reads its default address with the matching key type`, async () => {
    const state = mount({items: []});
    const publicKey = addressType === 'solana' ? '12'.repeat(32) : PUBLIC_KEY;
    state.applet.viewKey = async input => {
      state.keyViews.push(input);
      return {publicKey: bytes(publicKey)};
    };
    state.createKey(label);
    await state.tap();
    await state.finish();

    assert.deepEqual(state.creations, [request]);
    assert.equal(state.keyViews.length, 1);
    assert.equal(state.keyViews[0].type, request.type);
    const created = state.card.items[0];
    assert.equal(created.type, request.type);
    assert.equal(created.ref.addressType, addressType);
    assert.equal(created.ref.publicKey, publicKey);
    assert.equal(state.item(CREATED_INDEX).props.address, created.ref.address);
    assert.equal(state.item(CREATED_INDEX).props.selected, true);
    assert.equal(state.storage.keys.length, 0);
  });
}

test('adding a key preserves existing selections, the resource filter and a switched address preview', async () => {
  const existingIndex = '03010000000000000001';
  const ref = {addressType: 'evm', publicKey: PUBLIC_KEY};
  const unknown = {index: '90000000000000000003', type: 0x9000, secret: false};
  const state = mount({
    items: [
      {
        index: existingIndex,
        type: 'secp256k1',
        secret: true,
        ref: {...ref, address: getWalletData(ref).address},
      },
      unknown,
    ],
  });
  state.filter('all');
  state.select(existingIndex);
  state.select(unknown.index);
  state.changeAddressType(existingIndex, 'bitcoin-segwit');
  const preview = state.item(existingIndex).props.address;

  state.createKey();
  await state.tap();
  await state.finish();

  assert.deepEqual(state.rowIndexes(), [
    existingIndex,
    unknown.index,
    CREATED_INDEX,
  ]);
  assert.equal(state.item(existingIndex).props.selected, true);
  assert.equal(state.item(unknown.index).props.selected, true);
  assert.equal(state.item(CREATED_INDEX).props.selected, true);
  assert.equal(state.item(existingIndex).props.addressType, 'bitcoin-segwit');
  assert.equal(state.item(existingIndex).props.address, preview);
  assert.equal(
    find(state.render(), node => node.type === 'segmented').props.value,
    'all',
  );
  state.click('Copy');
  assert.deepEqual(state.copies[0].sourceIndexes, [
    existingIndex,
    unknown.index,
    CREATED_INDEX,
  ]);
  assert.equal(state.copies[0].sourceCard.items.length, 3);
  assert.equal(state.keyViews.length, 1);
});

test('an acknowledged key survives a failed View and callback reentry never creates it again', async () => {
  const state = mount({items: []});
  const failure = new Error('View failed');
  state.applet.view = async request => {
    state.views.push(request);
    throw failure;
  };
  state.createKey();
  await assert.rejects(state.tap(), failure);
  await assert.rejects(state.tap(), failure);
  await state.dismiss(failure);

  assert.equal(state.creations.length, 1);
  assert.equal(state.views.length, 1);
  assert.deepEqual(state.rowIndexes(), [CREATED_INDEX]);
  assert.equal(state.card.items[0].index, CREATED_INDEX);
  assert.equal(state.item(CREATED_INDEX).type, 'key-item');
  assert.equal(state.item(CREATED_INDEX).props.address, undefined);
  assert.equal(state.item(CREATED_INDEX).props.selected, false);
  assert.equal(state.menuButton().props.disabled, false);
});

test('a failed public-key read retains the created key without changing existing selections', async () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  state.select(INDEX);
  const failure = new Error('Public-key read failed');
  state.applet.viewKey = async request => {
    state.keyViews.push(request);
    throw failure;
  };
  state.createKey();
  await assert.rejects(state.tap(), failure);
  await state.dismiss(failure);

  assert.equal(state.creations.length, 1);
  assert.equal(state.views.length, 1);
  assert.equal(state.keyViews.length, 1);
  assert.equal(state.item(INDEX).props.selected, true);
  assert.equal(state.item(CREATED_INDEX).props.selected, false);
  assert.equal(state.item(CREATED_INDEX).props.address, undefined);
});

test('leaving after key reads finish does not automatically select the new key', async () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  state.select(INDEX);
  state.createKey();
  await state.tap();
  runInAction(() => {
    state.view.$leaving = true;
  });
  await state.finish();

  assert.equal(state.item(INDEX).props.selected, true);
  assert.equal(state.item(CREATED_INDEX).props.selected, false);
  assert.equal(
    state.item(CREATED_INDEX).props.address,
    getWalletData({addressType: 'evm', publicKey: PUBLIC_KEY}).address,
  );
});

test('Create key rejects another full Safe identity before authentication or mutation', async () => {
  const state = mount({items: []});
  state.createKey('seed');
  await assert.rejects(
    state.tap({
      ...state.hello,
      publicKey: bytes(`04${'34'.repeat(64)}`),
    }),
    MonoidWrongCardError,
  );
  await state.dismiss();

  assert.equal(state.authCount, 0);
  assert.deepEqual(state.creations, []);
  assert.deepEqual(state.card.snapshot().items, []);
});

test('cancelling during Create retains its eventual acknowledgement and skips further card reads', async () => {
  const state = mount({items: []});
  const response = deferred();
  state.applet.createRandomKey = async request => {
    state.creations.push(request);
    return response.promise;
  };
  state.createKey();
  const cancelled = assert.rejects(
    state.tap(),
    error => error.name === 'AbortError' || error.code === 'CANCELLED',
  );
  const dismissed = state.dismiss();
  response.resolve({index: bytes(CREATED_INDEX)});
  await cancelled;
  await dismissed;

  assert.equal(state.creations.length, 1);
  assert.deepEqual(state.views, []);
  assert.deepEqual(state.keyViews, []);
  assert.deepEqual(state.rowIndexes(), [CREATED_INDEX]);
  assert.equal(state.card.items[0].index, CREATED_INDEX);
  assert.equal(state.item(CREATED_INDEX).props.selected, false);
  assert.equal(state.menuButton().props.disabled, false);
});

test('creating secp256r1 reads its public key and keeps it available as a card resource', async () => {
  const state = mount({items: []});
  const publicKey = `04${'12'.repeat(64)}`;
  state.applet.viewKey = async request => {
    state.keyViews.push(request);
    return {publicKey: bytes(publicKey)};
  };
  state.createKey('secp256r1');
  await state.tap();
  await state.finish();

  assert.deepEqual(state.creations, [{type: 'secp256r1'}]);
  assert.deepEqual(state.keyViews, [
    {type: 'secp256r1', index: bytes(CREATED_INDEX)},
  ]);
  assert.deepEqual(state.rowIndexes(), [CREATED_INDEX]);
  assert.equal(state.item(CREATED_INDEX).type, 'resource-item');
  assert.equal(state.card.items[0].publicKey, publicKey);
  assert.equal(state.item(CREATED_INDEX).props.selected, true);
  assert.equal(state.visible('Import'), false);
  assert.equal(state.visible('Derive'), false);
  state.click('Copy');
  assert.deepEqual(state.copies[0].sourceIndexes, [CREATED_INDEX]);
});

test('returning to the same card reads new keys and address choices from the global store', async () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  state.changeAddressType(INDEX, 'bitcoin-segwit');
  state.menuButton().props.onClick();
  state.popupButton('Create key').props.onClick();
  state.popupButton('secp256k1').props.onClick();
  await state.tap();
  await state.finish();

  state.unmount();
  state.render();

  assert.deepEqual(Object.keys(state.view.card), ['id', 'publicKey']);
  assert.equal(state.item(INDEX).props.addressType, 'bitcoin-segwit');
  assert.equal(
    state.item(CREATED_INDEX).props.address,
    getWalletData({
      addressType: 'evm',
      publicKey: PUBLIC_KEY,
    }).address,
  );
  assert.equal(state.cardStore.get(state.view.card), state.card);
});

test('an unacknowledged creation stops without inventing an item or resending the command', async () => {
  const state = mount({items: []});
  state.applet.createRandomKey = async request => {
    state.creations.push(request);
    throw Object.assign(new Error('Response lost'), {code: 'TAG_LOST'});
  };
  state.menuButton().props.onClick();
  state.popupButton('Create key').props.onClick();
  state.popupButton('secp256k1').props.onClick();

  await assert.rejects(state.tap(), /Creation not confirmed/);
  await assert.rejects(state.tap(), /Creation not confirmed/);
  assert.equal(state.creations.length, 1);
  assert.deepEqual(state.card.snapshot().items, []);
  assert.equal(state.cardStore.get(state.view.card), undefined);
  await state.dismiss();
  assert.ok(state.menuButton(), 'the active page retains its working copy');
  runInAction(() => {
    state.view.$match.$exact.$active = false;
  });
  state.render();
  runInAction(() => {
    state.view.$match.$exact.$active = true;
  });
  assert.equal(state.menuButton(), undefined);
  assert.ok(find(state.render(), node => node.type === 'placeholder'));
});
