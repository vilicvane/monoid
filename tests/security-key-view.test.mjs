import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {p256} from '@noble/curves/nist';
import {observable, runInAction} from 'mobx';

import '../.bld/app/@components/views/safe/@card/card-backup-session.js';
import {AppletNotFoundError} from '../.bld/app/@lib/applet.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {MonoidCardError} from '../.bld/app/@lib/monoid/card-error.js';

let fixture;
let rendering;
const owners = [];
const PIN = 'Access-42';
const seedIndex = Uint8Array.from([2, 64, 1, 2, 3, 4, 5, 6, 7, 8]);
const seedHex = Buffer.from(seedIndex).toString('hex');

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
  namedExports: {Ellipsis: 'Ellipsis', KeyRound: 'KeyRound'},
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
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {
    useInputModal: () =>
      assert.fail('Security Key delegates PIN prompts to the shared scanner'),
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanStatePromptContentHighlight: 'highlight',
    MonoidScanRedirectError: class extends Error {
      code = 'CANCELLED';
    },
    useMonoidScanPrompt(options) {
      const state = fixture;
      return [
        'shared-scan-content',
        (content, callback, validate, signal) => {
          const scan = {
            options,
            content,
            callback,
            validate,
            signal,
            controller: new AbortController(),
            finished: deferred(),
          };
          state.scans.push(scan);
          return scan.finished.promise;
        },
      ];
    },
  },
});
const {useViewActive} = await import(
  '../.bld/app/@components/@view/use-view-active.js'
);
for (const [path, names] of [
  ['@monoid/card-preview', ['CardPreview']],
  ['@ui/app-icon', ['AppIcon']],
  ['@ui/button', ['Button', 'Buttons']],
  ['@ui/confirm-popup', ['ConfirmPopup']],
  [
    '@ui/details-popup',
    ['DetailsPopup', 'DetailsPopupDivider', 'DetailsPopupTitle'],
  ],
  [
    '@ui/info-section',
    [
      'InfoSection',
      'InfoSectionDivider',
      'InfoSectionHeader',
      'InfoSectionItem',
      'InfoSectionItemContent',
      'InfoSectionItemLabel',
    ],
  ],
  [
    '@ui/list',
    [
      'IconList',
      'ListItemButton',
      'ListItemContent',
      'ListItemDescription',
      'ListItemName',
      'ListSectionTitle',
    ],
  ],
  ['@ui/message-content', ['InfoMessage', 'WarningMessage']],
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
  ['views/card/card-management-content', ['CardScanPlaceholder']],
  ['views/safe/@card/@resource-item', ['CardResourceItem', 'CardResourceList']],
]) {
  mock.module(`../.bld/app/@components/${path}.js`, {
    namedExports: {
      ...Object.fromEntries(names.map(name => [name, name])),
      ...(path === '@view/index' ? {useViewActive} : {}),
    },
  });
}
const {SecurityKeyView} = await import(
  '../.bld/app/@components/views/security-key-view.js'
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
  if (node == null) return;
  if (predicate(node)) return node;
  for (const child of Array.isArray(node)
    ? node
    : [node.props?.children, node.props?.footer]) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
function card(number) {
  const state = {
    hello: {
      version: 1,
      id: Uint8Array.of(0, 0, 0, number),
      publicKey: p256.getPublicKey(BigInt(number), false),
      bundle: false,
      authority: false,
      pins: {access: 5, secret: 5},
    },
    authentications: [],
    writes: [],
    grants: [],
    items: [{index: seedIndex, secret: true, alias: 'Security Key'}],
  };
  state.applet = {
    hello: async () => state.hello,
    authenticate: async request => {
      state.authentications.push(request);
      if (state.authFailure)
        throw new CBORAppletError({code: 'INVALID_PIN', tries: 4});
      await state.authPending?.promise;
    },
    listAppletGrants: async () => ({grants: state.grants}),
    list: async () => ({items: state.items}),
    viewKey: async () => ({publicKey: p256.getPublicKey(1n, true)}),
    sendRawCommand: async () => new TextEncoder().encode('FIDO_2_0'),
    createRandomKey: async () => {
      state.writes.push('create');
      if (state.createFailure) throw new Error('Unknown create result');
      return {index: seedIndex};
    },
    set: async () => {
      state.writes.push('alias');
      return {};
    },
    setAppletGrant: async grant => {
      state.writes.push('grant');
      state.grants = [{...grant, tokenHash: new Uint8Array(32)}];
      return {};
    },
  };
  return state;
}
function mount() {
  const state = {
    slots: [],
    index: 0,
    scans: [],
    errors: [],
    forgotten: [],
    backups: [],
    mounted: true,
    slot: create => (state.slots[state.index++] ??= create()),
    render() {
      fixture = rendering = state;
      state.index = 0;
      state.tree = SecurityKeyView({view: state.view});
      rendering = undefined;
      return state.tree;
    },
    async flush() {
      await setImmediate();
      if (state.mounted) state.render();
      await setImmediate();
    },
    click(label) {
      const button = find(
        state.render(),
        node => node.type === 'Button' && node.props.children === label,
      );
      assert.ok(button, `Expected ${label}`);
      assert.notEqual(button.props.disabled, true);
      button.props.onClick();
    },
    configure(create = false) {
      state.click('Enable Security Key on card');
      if (create) state.click('Create dedicated Seed');
      else
        find(
          state.render(),
          node =>
            node.type === 'CardResourceItem' &&
            node.props.data.index === seedHex,
        ).props.onOpen();
    },
    async tap(current) {
      const scan = state.scans.at(-1);
      try {
        // The shared scanner validates Hello before sending the saved Access
        // PIN, then calls the page only after authentication succeeds.
        scan.signal.throwIfAborted();
        scan.validate(current.hello);
        assert.equal(scan.options.auth, 'access');
        assert.equal(scan.options.ensureSetup, false);
        await current.applet.authenticate({pin: current.pin ?? PIN});
        scan.signal.throwIfAborted();
        await scan.callback(
          current.applet,
          () => {},
          current.hello,
          scan.controller.signal,
        );
        scan.finished.resolve();
      } catch (error) {
        scan.finished.reject(error);
      }
      await state.flush();
    },
    async read(current) {
      state.click('Scan a card');
      await state.flush();
      await state.tap(current);
    },
    leave() {
      runInAction(() => {
        state.view.$match.$exact.$active = false;
      });
    },
    return() {
      runInAction(() => {
        state.view.$match.$exact.$active = true;
      });
      state.render();
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
  });
  state.entrances = {
    monoidCredentialsStore: {
      createPINSession: mock.fn(() => ({clear: mock.fn()})),
    },
    cardStore: {forget: identity => state.forgotten.push(identity)},
    securityKeyBackupStore: {
      save: async snapshot => {
        state.backups.push(snapshot);
        await state.backupPending?.promise;
        if (state.backupFailure) throw state.backupFailure;
      },
    },
    router: {cardApplets: () => ({$push() {}})},
    errorService: {
      catch(value) {
        const handle = promise =>
          promise.catch(error => state.errors.push(error));
        return typeof value === 'function'
          ? (...args) => handle(Promise.resolve().then(() => value(...args)))
          : handle(value);
      },
    },
  };
  owners.push(state);
  state.render();
  return state;
}
afterEach(() => owners.splice(0).forEach(owner => owner.unmount()));

test('reading then configuring reuses one page-owned Access PIN session and authenticates once per scan', async () => {
  const state = mount();
  const first = card(1);
  await state.read(first);
  const pinSession = state.scans[0].options.pinSession;
  state.configure();
  await state.flush();
  assert.equal(state.scans.length, 2);
  assert.equal(state.scans[1].options.pinSession, pinSession);
  assert.equal(pinSession.clear.mock.callCount(), 0);
  await state.tap(first);
  assert.deepEqual(first.authentications, [{pin: PIN}, {pin: PIN}]);
  assert.deepEqual(first.writes, ['grant']);
  assert.equal(state.forgotten.length, 1);
  assert.equal(
    state.entrances.monoidCredentialsStore.createPINSession.mock.callCount(),
    1,
  );
  assert.equal(
    pinSession.clear.mock.callCount(),
    1,
    'completed configuration releases its scope',
  );
  const second = card(2);
  second.pin = 'Other-42';
  await state.read(second);
  assert.deepEqual(second.authentications, [{pin: 'Other-42'}]);
  assert.deepEqual(state.errors, []);
});

test('configuration validates the full identity before shared Access PIN authentication', async () => {
  for (const change of ['identity', 'bundle']) {
    const state = mount();
    const first = card(1);
    await state.read(first);
    state.configure();
    await state.flush();
    const wrong = card(change === 'identity' ? 2 : 1);
    if (change === 'bundle') wrong.hello.bundle = new Uint8Array(32).fill(2);
    await state.tap(wrong);
    assert.deepEqual(wrong.authentications, []);
    assert.deepEqual(wrong.writes, []);
    assert.match(state.errors[0].message, /Wrong card/);
  }
});

test('failed shared authentication never invokes or retries the configuration', async () => {
  const state = mount();
  const first = card(1);
  await state.read(first);
  first.authFailure = true;
  state.configure();
  await state.flush();
  await state.tap(first);
  assert.equal(first.authentications.length, 2);
  assert.deepEqual(first.writes, []);
  assert.equal(state.scans.length, 2);
  state.click('Continue');
  await state.flush();
  first.authFailure = false;
  first.pin = 'Changed-42';
  await state.tap(first);
  assert.deepEqual(first.authentications.at(-1), {pin: 'Changed-42'});
  assert.deepEqual(first.writes, ['grant']);
});

test('leaving aborts the shared scan before a late tap can authenticate and releases the PIN session', async () => {
  const state = mount();
  state.click('Scan a card');
  await state.flush();
  const scan = state.scans.at(-1);
  const first = card(1);
  state.leave();
  state.return();
  assert.equal(scan.signal.aborted, true);
  assert.equal(scan.options.pinSession.clear.mock.callCount(), 1);
  await state.tap(first);
  assert.deepEqual(first.authentications, []);
  assert.deepEqual(state.errors, []);
});

test('leaving while shared authentication is pending prevents a late configuration or snapshot', async () => {
  const state = mount();
  const first = card(1);
  await state.read(first);
  state.configure();
  await state.flush();
  first.authPending = deferred();
  const tap = state.tap(first);
  await setImmediate();
  state.leave();
  state.return();
  first.authPending.resolve();
  await tap;
  assert.deepEqual(first.writes, []);
  assert.equal(
    find(state.tree, node => node.type === 'CardPreview'),
    undefined,
  );
  assert.deepEqual(state.errors, []);
});

test('an unknown write requires a fresh read and never replays Seed creation', async () => {
  const state = mount();
  const first = card(1);
  await state.read(first);
  first.createFailure = true;
  state.configure(true);
  await state.flush();
  await state.tap(first);
  assert.deepEqual(first.writes, ['create']);
  assert.equal(
    find(
      state.tree,
      node => node.type === 'Button' && node.props.children === 'Continue',
    ),
    undefined,
  );
  await state.read(first);
  assert.deepEqual(first.writes, ['create']);
  assert.match(state.errors[0].message, /Unknown create result/);
});

for (const kind of ['access', 'secret']) {
  test(`a card without ${kind} PIN offers Card Applets before requesting authentication`, async () => {
    const state = mount();
    const first = card(1);
    first.hello.pins[kind] = false;
    await state.read(first);
    assert.deepEqual(first.authentications, []);
    assert.ok(
      find(
        state.tree,
        node =>
          node.type === 'Button' && node.props.children === 'Open Card Applets',
      ),
    );
    assert.ok(
      find(
        state.tree,
        node =>
          node.type === 'InfoMessage' &&
          node.props.children === 'Set up PINs in Card Applets',
      ),
    );
    assert.deepEqual(state.errors, []);
  });
}

test('a missing Monoid applet preserves an actionable Card Applets entry', async () => {
  const state = mount();
  state.click('Scan a card');
  await state.flush();
  state.scans.at(-1).finished.reject(
    new MonoidCardError('Monoid not installed', {
      cause: new AppletNotFoundError(new Uint8Array()),
    }),
  );
  await state.flush();
  assert.ok(
    find(
      state.tree,
      node =>
        node.type === 'Button' && node.props.children === 'Open Card Applets',
    ),
  );
  assert.ok(
    find(
      state.tree,
      node =>
        node.type === 'InfoMessage' &&
        node.props.children === 'Install Monoid Applet in Card Applets',
    ),
  );
  assert.deepEqual(state.errors, []);
});

for (const kind of ['access', 'secret']) {
  test(`a blocked ${kind} PIN stops before shared authentication with the precise error`, async () => {
    const state = mount();
    const first = card(1);
    first.hello.pins[kind] = 0;
    await state.read(first);
    assert.deepEqual(first.authentications, []);
    assert.deepEqual(first.writes, []);
    assert.equal(
      state.errors[0].message,
      `${kind === 'access' ? 'Access' : 'Secret'} PIN blocked`,
    );
  });
}

test('each completed read is backed up without delaying the scan or failing the page', async () => {
  const state = mount();
  const first = card(1);
  state.backupPending = deferred();
  await state.read(first);
  assert.equal(state.backups.length, 1);
  assert.equal(state.backups[0].hello, first.hello);
  assert.ok(
    find(
      state.render(),
      node =>
        node.type === 'Button' &&
        node.props.children === 'Enable Security Key on card',
    ),
    'the snapshot is shown while the backup is still pending',
  );

  state.backupPending.resolve();
  await state.flush();
  assert.deepEqual(state.errors, []);
  state.backupFailure = new Error('Backup unavailable');
  await state.read(first);
  assert.equal(state.backups.length, 2);
  assert.deepEqual(state.errors, [state.backupFailure]);
  assert.ok(
    find(
      state.render(),
      node =>
        node.type === 'Button' &&
        node.props.children === 'Enable Security Key on card',
    ),
  );
});
