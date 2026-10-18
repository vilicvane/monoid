import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';

import {observable, runInAction, toJS} from 'mobx';

import {MonoidWrongCardError} from '../.bld/app/@lib/monoid/card-error.js';
import {getAppletKey} from '../.bld/app/@lib/monoid/get-applet-key.js';
import {
  getWalletData,
  getWalletReference,
  matchesWalletReference,
  WalletStorageService,
} from '../.bld/app/@services/wallet-storage-service.js';

let fixture;
let rendering;
const owners = [];
const INDEX = '02400000000000000001';
const SECOND_INDEX = '02400000000000000002';
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
  namedExports: {styled: {p: () => 'description'}},
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
for (const [path, exports] of [
  ['@key/key-list', {KeyListPlaceholder: 'placeholder'}],
  ['@monoid/pin-input-placeholder', {PINKind: 'pin-kind'}],
  ['@ui/app-icon', {AppIcon: 'icon'}],
  ['@ui/button', {Button: 'popup-button', Buttons: 'buttons'}],
  ['@ui/centered-popup', {CenteredPopup: 'popup'}],
  ['@ui/details-popup', {DetailsPopupTitle: 'popup-title'}],
  ['@ui/segmented-control', {SegmentedControl: 'segmented'}],
  [
    '@view/index',
    {
      View: 'view',
      ViewActionButton: 'button',
      ViewContent: 'content',
      ViewHeader: 'header',
      ViewHeaderButton: 'header-button',
      ViewHeaderIdentifier: 'identifier',
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
    defaultWallet: getWalletReference(defaultWallet),
  };
}

function metadata(index, wallets) {
  return {
    index: `0f01${index.slice(4)}`,
    type: 0x0f01,
    key: index,
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
    progressUpdates: [],
    errors: [],
    routes: [],
    copies: [],
    authCount: 0,
    clears: 0,
    storage,
    view: observable({
      card: {
        id: 'aabbccdd',
        publicKey: `04${'12'.repeat(64)}`,
        items,
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
      state.tree = content.type(content.props);
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
        node => node.type === 'popup-button' && textContent(node) === label,
      );
    },
    confirmDelete() {
      state.menuButton().props.onClick();
      state.popupButton('Delete').props.onClick();
      return state.popupButton('Delete').props.onClick;
    },
    async tap(hello = state.hello) {
      const scan = state.scans.at(-1);
      scan.validate?.(hello);
      state.authCount++;
      await scan.callback(
        state.applet,
        content => state.progressUpdates.push(content),
        hello,
        scan.controller.signal,
      );
    },
    async finish() {
      state.scans.at(-1).resolve();
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
  state.hello = {
    safe: {
      id: bytes(state.view.card.id),
      publicKey: bytes(state.view.card.publicKey),
    },
  };
  state.applet = {
    async set(request) {
      state.aliasWrites.push(request);
    },
    async remove({index}) {
      state.removals.push(Buffer.from(index).toString('hex'));
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
  state.write = async (applet, source, wallets, signal) => {
    state.writes.push({applet, key: source, wallets, signal});
    if (signal.aborted)
      throw Object.assign(new Error('Cancelled'), {code: 'CANCELLED'});
    const derivations = wallets.map(parameters => ({
      ...parameters,
      publicKey: PUBLIC_KEY,
    }));
    return {...metadata(source.index, wallets), derivations};
  };
  state.pinSession = {clear: () => state.clears++};
  state.entrances = {
    walletStorageService: storage,
    monoidCredentialsStore: {createPINSession: () => state.pinSession},
    router: {
      safe: {
        $exact: {},
        copyItems: options => ({$push: () => state.copies.push(options)}),
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

test('Card actions remains available without a selection and cancelling deletion never starts a scan', () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  assert.equal(state.menuButton().props.disabled, false);
  state.menuButton().props.onClick();
  assert.ok(state.popupButton('Update Access PIN'));
  assert.ok(state.popupButton('Update Safe PIN'));
  assert.equal(state.popupButton('Delete'), undefined);
  state.popup().props.onDismiss();

  state.select(INDEX);
  assert.equal(state.menuButton().props['aria-haspopup'], 'dialog');
  state.menuButton().props.onClick();
  assert.equal(state.popup().props['aria-label'], 'Card actions');
  assert.equal(state.menuButton().props['aria-expanded'], true);
  assert.equal(state.popupButton('Update Access PIN'), undefined);
  assert.equal(state.popupButton('Update Safe PIN'), undefined);
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

for (const kind of ['Access', 'Safe']) {
  test(`an empty card can open ${kind} PIN settings and keeps the menu disabled until completion`, () => {
    const state = mount({items: []});
    state.menuButton().props.onClick();
    assert.equal(state.popupButton('Delete'), undefined);
    const click = state.popupButton(`Update ${kind} PIN`).props.onClick;
    click();
    click();
    const update = find(state.render(), node => node.type === 'pin-update');
    assert.equal(update.props.kind, kind);
    assert.equal(update.props.card, state.view.card);
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
    toJS(state.view.card.items),
    cardItems(SECOND_INDEX, [wallet(1)]),
  );
  assert.deepEqual(toJS(state.storage.keys), phoneBefore);
  assert.equal(state.menuButton().props.disabled, false);
  assert.deepEqual(state.routes, []);
  assert.deepEqual(state.errors, []);
});

test('deletion rejects a mismatched full Safe identity before authentication and permits a correct retry', async () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  state.select(INDEX);
  state.confirmDelete()();

  await assert.rejects(
    state.tap({
      safe: {...state.hello.safe, publicKey: bytes(`04${'34'.repeat(64)}`)},
    }),
    MonoidWrongCardError,
  );
  assert.equal(state.authCount, 0);
  assert.deepEqual(state.removals, []);
  assert.equal(state.view.card.items.length, 2);

  await state.tap();
  await state.finish();
  assert.equal(state.authCount, 1);
  assert.deepEqual(state.view.card.items, []);
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
    await remove(request);
    if (Buffer.from(request.index).toString('hex') === INDEX && !failed) {
      failed = true;
      throw new Error('Card removed');
    }
  };
  state.select(INDEX);
  state.confirmDelete()();
  await assert.rejects(state.tap(), /Card removed/);
  await state.dismiss();

  assert.deepEqual(
    state.view.card.items.map(item => item.index),
    [INDEX],
  );
  assert.deepEqual(toJS(state.view.card.items[0].derivations), []);
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
  assert.deepEqual(state.view.card.items, []);
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
  await finished;
  assert.deepEqual(state.removals, [metadata(INDEX, [wallet(0)]).index, INDEX]);
  assert.deepEqual(state.view.card.items, []);
});

test('dismissing an in-flight delete keeps actions blocked until its ACK is published without updating the closed prompt', async () => {
  const state = mount({items: cardItems(INDEX, [wallet(0)])});
  const release = deferred();
  const remove = state.applet.remove;
  state.applet.remove = async request => {
    await remove(request);
    await release.promise;
  };
  state.select(INDEX);
  const clickDelete = state.confirmDelete();
  clickDelete();
  const rejected = assert.rejects(
    state.tap(),
    error => error.code === 'CANCELLED',
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
  assert.equal(state.view.card.items.length, 2);

  release.resolve();
  await Promise.all([rejected, dismissing]);

  assert.equal(dismissed, true);
  assert.deepEqual(state.removals, [metadata(INDEX, [wallet(0)]).index]);
  assert.deepEqual(
    state.view.card.items.map(item => item.index),
    [INDEX],
  );
  assert.deepEqual(toJS(state.view.card.items[0].derivations), []);
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
      await remove(request);
      await release.promise;
    };
    state.select(INDEX);
    state.select(SECOND_INDEX);
    state.confirmDelete()();
    const tapping = state.tap();
    const rejected = assert.rejects(
      tapping,
      error => error.code === 'CANCELLED',
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
      state.view.card.items.map(item => item.index),
      [INDEX, SECOND_INDEX, metadata(SECOND_INDEX, [wallet(1)]).index],
    );
    assert.deepEqual(toJS(state.view.card.items[0].derivations), []);
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
  assert.deepEqual(toJS(state.view.card.items).slice(-2), [orphan, unknown]);
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
  assert.equal(state.copies[0].sourceCard, state.view.card);
  assert.deepEqual(toJS(state.copies[0].sourceCard.items), items);
  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.writes, []);
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

test('one pending card merge takes priority over phone-only changes elsewhere in the selected batch', async () => {
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
  assert.equal(state.visible('Update card'), false);
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

test('a recorded derivation with a different public key must update the phone before writing the card', async () => {
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
  assert.equal(state.storage.keys[0].wallets[0].publicKey, saved.publicKey);
  assert.equal(state.visible('Update card'), true);
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
      options => options.safe && options.pinSession === state.pinSession,
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
      safe: {
        ...state.hello.safe,
        publicKey: bytes(`04${'34'.repeat(64)}`),
      },
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

    state.click(source === 'phone' ? 'Update' : 'Import');
    assert.equal(state.scans.length, 1);
    assert.equal(state.scans[0].label, 'Scan card to import');
    assert.deepEqual(state.writes, []);
    await state.tap();
    await state.finish();

    assert.deepEqual(toJS(state.storage.indexToKeyMap.get(INDEX).wallets), [
      known,
      segwit,
    ]);
    assert.deepEqual(state.writes[0].wallets, [
      getWalletReference(known),
      getWalletReference(segwit),
    ]);
    assert.equal(state.item(INDEX).props.state, 'up-to-date');
    assert.equal(state.visible('Back to Safe'), true);
    assert.deepEqual(state.errors, []);
  });
}

test('a new raw key imports directly and shows completion using the newly stored key', async () => {
  const index = '04010000000000000003';
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

  await state.click('Import');

  assert.deepEqual(state.scans, []);
  assert.deepEqual(state.writes, []);
  assert.equal(state.storage.indexToKeyMap.get(index).publicKey, PUBLIC_KEY);
  assert.equal(state.item(index).props.state, 'up-to-date');
  assert.equal(state.visible('Back to Safe'), true);
  assert.deepEqual(state.errors, []);
});
