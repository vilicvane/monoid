import assert from 'node:assert/strict';
import {afterEach, mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {observable, runInAction} from 'mobx';

const {parseOTPURI, validateOTPAccountLabel} = await import(
  '../.bld/app/@lib/otp.js'
);

let fixture;
let rendering;
const owners = [];
const PIN = 'Access-42';
const OTP_AID = Uint8Array.from(Buffer.from('f06d6f6e6f69640501', 'hex'));
const bytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'));

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
    jsx: (type, props, key) => ({type, props, key}),
    jsxs: (type, props, key) => ({type, props, key}),
    Fragment: 'fragment',
  },
});
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('lucide-react', {
  namedExports: {
    Broom: 'Broom',
    CreditCardMinus: 'CreditCardMinus',
    Ellipsis: 'Ellipsis',
    ScanLine: 'ScanLine',
  },
});
mock.module('@ionic/react', {
  namedExports: {IonFabButton: 'IonFabButton'},
});
mock.module('styled-components', {
  namedExports: {
    keyframes: () => '',
    styled: new Proxy(component => () => component, {
      get: (_target, tag) => () => `styled-${tag}`,
    }),
  },
});
mock.module('../.bld/app/@components/@animations.js', {
  namedExports: {fadeInAnimationCSS: '', popOutAnimationCSS: ''},
});
mock.module('unmount-animation-clone', {
  namedExports: {UnmountAnimationClone: 'UnmountAnimationClone'},
});
mock.module('../.bld/app/@components/@key/expandable-key-group.js', {
  namedExports: {
    ExpandableKeyGroup: 'ExpandableKeyGroup',
    KeyGroupItem: 'KeyGroupItem',
    keyGroupReveal: '',
  },
});
mock.module('@capacitor/app', {
  namedExports: {
    App: {
      addListener: async (_name, handler) => {
        const owner = fixture;
        owner.background = handler;
        return {
          remove() {
            if (owner.background === handler) owner.background = undefined;
          },
        };
      },
    },
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
mock.module('../.bld/app/@lib/otp-card.js', {
  namedExports: {
    isOTPInstalled: async applet => {
      fixture.events.push('probe');
      return applet.card.installed;
    },
    assertOTPAccounts: async (applet, accounts) => {
      fixture.events.push('verify');
      for (const account of accounts) {
        const actual = applet.card.accounts.find(
          item => item.index === account.index,
        );
        if (
          !actual ||
          ['keyIndex', 'algorithm', 'digits', 'period'].some(
            key => actual[key] !== account[key],
          )
        )
          throw new Error('OTP account does not match');
      }
    },
    readOTPCard: async applet => {
      fixture.events.push('read');
      return applet.card;
    },
    addOTPAccount: async (applet, _account, _signal, onMutation) => {
      fixture.events.push('add');
      onMutation();
      return applet.card.accounts;
    },
    removeOTPAccount: async (
      applet,
      account,
      _signal,
      onMutation,
      installed,
    ) => {
      fixture.events.push('remove');
      fixture.removeInstalled = installed;
      applet.card = {
        ...applet.card,
        accounts: applet.card.accounts.filter(
          item => item.index !== account.index,
        ),
      };
      onMutation();
      return applet.card.accounts;
    },
    authorizeOTPAccounts: async applet => {
      fixture.events.push('authorize');
      return applet.card.accounts;
    },
  },
});
mock.module('../.bld/app/@lib/otp-authority.js', {
  namedExports: {
    getDefaultOTPAuthorityUrl: () => 'https://default.example',
    OTPAuthorityWarmup: class {
      owner = fixture;
      constructor(signal) {
        this.owner.warmupSignal = signal;
      }
      start(value) {
        (this.owner.warmups ??= []).push(value);
      }
      stop() {
        this.owner.warmupStopped = true;
      }
    },
  },
});
mock.module('../.bld/app/@lib/otp.js', {
  namedExports: {
    OTP_AID,
    OTP_MAX_ACCOUNTS: 16,
    validateOTPAccountLabel,
    prepareOTP: async (_applet, indexes, authority, signal, onStage) => {
      fixture.events.push('prepare');
      onStage?.('preparing');
      if (authority !== false) {
        onStage?.('time');
        onStage?.('verifying');
      }
      fixture.prepared = {indexes, authority, signal};
      return fixture.prepared;
    },
    calculatePreparedOTP: async (prepared, _applet, signal) => {
      const owner = fixture;
      owner.events.push('calculate');
      await owner.calculation?.promise;
      signal.throwIfAborted();
      return {
        requestedAt: performance.now(),
        receivedAt: performance.now(),
        time: BigInt(60),
        items: prepared.indexes.map(index => ({
          index: Buffer.from(index).toString('hex'),
          period: 30,
          codes: ['123456', '234567', '345678'],
        })),
      };
    },
    currentOTPCode: (_batch, item) =>
      fixture.codeState?.current ?? {code: item.codes[0], remaining: 20},
    otpCodeState: (_batch, item) =>
      fixture.codeState ?? {
        current: {code: item.codes[0], remaining: 20},
        progress: 2 / 3,
        prefetched: 2,
        exhausted: false,
      },
    parseOTPURI,
  },
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {
    useInputModal: () => [
      'pin-input',
      async options => {
        const owner = fixture;
        owner.events.push('input');
        owner.inputOptions = options;
        return owner.input?.promise ?? PIN;
      },
    ],
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {
    MonoidScanStatePromptContentHighlight: 'highlight',
    MonoidScanRedirectError: class extends Error {
      code = 'CANCELLED';
    },
    useMonoidScanPrompt(options) {
      const owner = fixture;
      return [
        'scan-input',
        (content, callback, validate, signal, authentication) => {
          owner.events.push('scan');
          const scan = {
            options,
            content,
            callback,
            validate,
            signal,
            authentication,
            finished: deferred(),
          };
          owner.scans.push(scan);
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
  ['@key/key-list', ['KeyList', 'KeyListItemContent']],
  ['@key/key-tags', ['KeyDerivationBadge', 'KeyTags']],
  ['@ui/app-icon', ['AppIcon']],
  ['@ui/button', ['Button', 'Buttons']],
  ['@ui/confirm-popup', ['ConfirmPopup']],
  ['@ui/copy-button', ['CopyButton']],
  [
    '@ui/details-popup',
    ['DetailsPopup', 'DetailsPopupDivider', 'DetailsPopupTitle'],
  ],
  [
    '@ui/info-section',
    ['InfoSection', 'InfoSectionHeader', 'InfoSectionItemLabel'],
  ],
  [
    '@ui/list',
    [
      'IconList',
      'ListItem',
      'ListItemButton',
      'ListItemContent',
      'ListItemDescription',
      'ListItemName',
      'ListSectionTitle',
    ],
  ],
  ['@ui/message-content', ['InfoMessage']],
  ['@ui/qr-scan-popup', ['QrScanPopup']],
  ['@ui/remaining-time', ['RemainingTime']],
  ['@ui/swipeable-item', ['SwipeAction', 'SwipeActionIcon', 'SwipeableItem']],
  ['@ui/tag', ['Tag', 'DarkTag', 'WhiteTag']],
  ['@ui/ripple-effect', ['RippleEffect']],
  [
    '@view/index',
    [
      'View',
      'ViewContent',
      'ViewFab',
      'ViewHeader',
      'ViewHeaderButton',
      'ViewHeaderTitle',
      'ViewHeaderTags',
      'ViewPlaceholder',
    ],
  ],
  ['views/otp/otp-account-popup', ['OTPAccountPopup']],
]) {
  mock.module(`../.bld/app/@components/${path}.js`, {
    namedExports: {
      ...Object.fromEntries(names.map(name => [name, name])),
      ...(path === '@view/index' ? {useViewActive, viewHeaderTagCSS: ''} : {}),
    },
  });
}
const {OTPView} = await import('../.bld/app/@components/views/otp-view.js');
const {OTPAccountView} = await import(
  '../.bld/app/@components/views/otp/otp-account-view.js'
);

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return {promise, resolve, reject};
}
function find(node, predicate) {
  if (node == null) return;
  if (predicate(node)) return node;
  if (node.type === 'ExpandableKeyGroup') {
    let state = fixture.groups.get(node.key);
    if (!state) {
      state = {
        expanded: node.props.autoExpand,
        collapsing: false,
        revealing: false,
        expand: () => {
          state.expanded = true;
        },
        collapse: () => {
          state.expanded = false;
        },
      };
      fixture.groups.set(node.key, state);
    }
    return find(node.props.children(state), predicate);
  }
  for (const child of Array.isArray(node)
    ? node
    : [node.props?.children, node.props?.footer, node.props?.actions]) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
function accountRow(tree, label) {
  return find(
    tree,
    node =>
      node.type === 'KeyGroupItem' &&
      find(
        node.props.children,
        child => child.props?.['aria-label'] === `Get codes for ${label}`,
      ),
  );
}
function cachedCard(number, count = 1) {
  return {
    id: number.toString(16).padStart(8, '0'),
    publicKey: `04${number.toString(16).padStart(2, '0').repeat(64)}`,
    installed: true,
    authorized: true,
    accounts: Array.from({length: count}, (_unused, index) => ({
      index: `f201${(number * 100 + index).toString(16).padStart(16, '0')}`,
      keyIndex: `0514${index.toString(16).padStart(16, '0')}`,
      label: `Account ${number}-${index}`,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    })),
  };
}
function mount(cards = [cachedCard(1)], context = {}, importURI) {
  const state = {
    slots: [],
    index: 0,
    events: [],
    errors: [],
    scans: [],
    groups: new Map(),
    mounted: true,
    importURI,
    slot: create => (state.slots[state.index++] ??= create()),
    render() {
      fixture = rendering = state;
      state.index = 0;
      state.tree = (state.accountPage ? OTPAccountView : OTPView)({
        view: state.view,
      });
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
      assert(button, `Expected ${label}`);
      assert.notEqual(button.props.disabled, true);
      button.props.onClick();
    },
    enterAccount() {
      state.slots.splice(0).forEach(slot => slot.cleanup?.());
      state.accountPage = true;
      state.view.index = state.destination.index;
      state.render();
    },
    openAccount(card, index = 0) {
      const button = accountRow(state.render(), card.accounts[index].label);
      assert(button);
      assert.notEqual(button.props.disabled, true);
      button.props.onClick();
      state.enterAccount();
    },
    async tap(card) {
      const scan = state.scans.at(-1);
      const hello = {
        id: bytes(card.id),
        publicKey: bytes(card.publicKey),
        authority: card.authority ?? false,
        pins: {access: 5, secret: 5},
        bundle: false,
        version: 1,
      };
      const applet = {card};
      try {
        scan.signal.throwIfAborted();
        scan.validate(hello);
        await scan.authentication?.prepare(
          applet,
          () => {},
          hello,
          scan.signal,
        );
        scan.signal.throwIfAborted();
        state.events.push('authenticate');
        await scan.callback(applet, () => {}, hello, scan.signal);
        scan.finished.resolve();
      } catch (error) {
        scan.finished.reject(error);
      }
      await state.flush();
    },
    leave() {
      runInAction(() => {
        state.view.$match.$exact.$active = false;
      });
    },
    unmount() {
      state.mounted = false;
      state.slots.splice(0).forEach(slot => slot.cleanup?.());
    },
  };
  const visibility = new Map();
  globalThis.document = {
    hidden: false,
    addEventListener: (name, handler) => visibility.set(name, handler),
    removeEventListener: name => visibility.delete(name),
  };
  state.view = observable({
    ...context,
    $leaving: false,
    $match: {
      $exact: {$active: true},
      $view: () => ({$entries: state.mounted ? [state.view] : []}),
    },
  });
  state.pins = Object.fromEntries(cards.map(card => [card.id, PIN]));
  state.pinSession = {
    clear: mock.fn(),
    getPINs: async () => {
      state.events.push('unlock');
      await state.unlock?.promise;
      return state.pins;
    },
    rememberPIN: (id, pin) => {
      state.events.push('remember');
      state.pins[id] = pin;
    },
  };
  state.entrances = {
    monoidCredentialsStore: {createPINSession: () => state.pinSession},
    cardStore: {forget: () => {}},
    otpStore: {
      takeImport: id => {
        assert.equal(id, context.importId);
        const value = state.importURI;
        state.importURI = undefined;
        return value;
      },
      accounts: [
        ...new Map(
          cards
            .flatMap(card => card.accounts)
            .map(account => [account.index, account]),
        ).values(),
      ],
      save: async accounts => {
        state.events.push('cache');
        state.entrances.otpStore.accounts = [
          ...new Map(
            [...state.entrances.otpStore.accounts, ...accounts].map(account => [
              account.index,
              account,
            ]),
          ).values(),
        ];
      },
      forget: async index => {
        state.entrances.otpStore.accounts =
          state.entrances.otpStore.accounts.filter(
            item => item.index !== index,
          );
      },
    },
    router: {
      otp: {
        account: context => ({
          $push: () => {
            state.destination = context;
          },
        }),
      },
      cardApplets: context => ({
        $push: () => {
          state.destination = context;
        },
      }),
    },
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
afterEach(() => {
  owners.splice(0).forEach(owner => owner.unmount());
  delete globalThis.document;
});

test('OTP uses the main scanner and has no page-specific QR button', () => {
  for (const cards of [[], [cachedCard(1)]]) {
    const state = mount(cards);
    assert.equal(
      find(state.tree, node => node.type === 'IonFabButton'),
      undefined,
    );
    assert.equal(
      find(
        state.tree,
        node =>
          node.type === 'Button' && node.props.children === 'Scan QR code',
      ),
      undefined,
    );
    assert.equal(
      find(state.render(), node => node.type === 'OTPAccountPopup'),
      undefined,
    );
    assert.equal(
      find(state.tree, node => node.type === 'QrScanPopup'),
      undefined,
    );
    assert.equal(state.scans.length, 0);
  }
});

test('a scanned account waits for confirmation then checks OTP before authenticating and writing', async () => {
  const uri =
    'otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const state = mount([], {importId: 'test-import'}, uri);
  const form = find(state.render(), node => node.type === 'OTPAccountPopup');
  assert.equal(form.props.initialURI, uri);
  assert.equal(state.scans.length, 0);
  const account = parseOTPURI(uri);
  form.props.onSave(account);
  await state.flush();
  assert.equal(state.scans.length, 1);
  assert.equal(state.scans[0].authentication.aid, undefined);
  await state.tap(cachedCard(1));
  assert.deepEqual(state.events, [
    'unlock',
    'scan',
    'probe',
    'authenticate',
    'add',
    'cache',
  ]);
  assert(account.secret.every(byte => byte === 0));
  assert.deepEqual(state.errors, []);
});

test('manual entry needs no prior scan and missing OTP prevents authentication and mutation', async () => {
  const state = mount([]);
  find(
    state.render(),
    node => node.type === 'ViewHeaderButton',
  ).props.onClick();
  state.click('Enter manually');
  const form = find(state.render(), node => node.type === 'OTPAccountPopup');
  assert.equal(form.props.initialURI, undefined);
  const account = parseOTPURI(
    'otpauth://totp/Example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  );
  form.props.onSave(account);
  await state.flush();
  await state.tap({...cachedCard(1), installed: false});
  assert.deepEqual(state.events, ['unlock', 'scan', 'probe']);
  assert.match(state.errors[0].message, /OTP is not installed/);
  assert(account.secret.every(byte => byte === 0));
});

test('a scanned import is consumed once and never reopens after background or revisiting', async () => {
  const uri = 'otpauth://totp/Example?secret=MY';
  const state = mount([], {importId: 'test-import'}, uri);
  await state.flush();
  assert(find(state.tree, node => node.type === 'OTPAccountPopup'));
  assert.equal(state.importURI, undefined);
  state.background({isActive: false});
  state.background({isActive: true});
  await state.flush();
  assert.equal(
    find(state.tree, node => node.type === 'OTPAccountPopup'),
    undefined,
  );
  state.leave();
  runInAction(() => {
    state.view.$match.$exact.$active = true;
  });
  assert.equal(
    find(state.render(), node => node.type === 'OTPAccountPopup'),
    undefined,
  );
});

test('account taps use the scanned card Authority mode without APP service configuration', async () => {
  for (const authority of [false, 'https://card-authority.example']) {
    const card = {...cachedCard(1), authority};
    const state = mount([card]);
    state.openAccount(card);
    await state.flush();
    assert.equal(state.scans.length, 1);
    await state.tap(card);
    assert.equal(state.prepared.authority, authority);
    assert.deepEqual(state.warmups, ['https://default.example', authority]);
    assert.equal(state.entrances.otpStore.authorityHint, authority);
    assert.equal(state.warmupStopped, true);
    assert.deepEqual(state.errors, []);
    assert(find(state.tree, node => node.type === 'CopyButton'));
  }
});

test('Authority warm-up starts before biometric unlock and does not gate NFC', async () => {
  const card = {...cachedCard(1), authority: 'https://backup.example'};
  const state = mount([card]);
  state.entrances.otpStore.authorityHint = 'https://previous.example';
  state.unlock = deferred();
  state.openAccount(card);
  await state.flush();
  assert.deepEqual(state.events, ['unlock']);
  assert.deepEqual(state.warmups, ['https://previous.example']);
  assert.equal(state.scans.length, 0);
  state.unlock.resolve();
  await state.flush();
  assert.equal(state.scans.length, 1);
  await state.tap(card);
  assert.deepEqual(state.warmups, ['https://previous.example', card.authority]);
  assert.equal(state.prepared.authority, card.authority);
  assert.equal(state.warmupStopped, true);
});

test('a known phone-time card suppresses the default hint and leaving cancels warm-up', async () => {
  const card = cachedCard(1);
  const state = mount([card]);
  state.entrances.otpStore.authorityHint = false;
  state.openAccount(card);
  await state.flush();
  assert.deepEqual(state.warmups, [false]);
  state.leave();
  await state.flush();
  assert.equal(state.warmupSignal.aborted, true);
});

test('tapping a cached account starts one scan and prepares before authentication', async () => {
  const card = cachedCard(1);
  const state = mount([card]);
  state.openAccount(card);

  await state.flush();
  assert.equal(state.scans.length, 1);
  assert.equal(state.scans[0].options.pinSession, state.pinSession);
  assert.deepEqual(state.scans[0].authentication.aid, OTP_AID);
  await state.tap(card);
  assert.deepEqual(state.events, [
    'unlock',
    'scan',
    'prepare',
    'authenticate',
    'verify',
    'calculate',
  ]);
  assert.deepEqual(state.prepared.indexes, [bytes(card.accounts[0].index)]);
  assert.equal(
    find(state.tree, node => node.type === 'CopyButton').props.value(),
    '123456',
  );
  assert.deepEqual(state.errors, []);
});

test('explicit card management requests a missing PIN after unlocking and before NFC', async () => {
  const card = cachedCard(1);
  const state = mount([card], {card: {id: card.id, publicKey: card.publicKey}});
  state.pins = {};
  state.unlock = deferred();
  state.click('Scan a card');
  await state.flush();
  assert.deepEqual(state.events, ['unlock']);
  state.unlock.resolve();
  await state.flush();
  assert.deepEqual(state.events, ['unlock', 'input', 'remember', 'scan']);
  await state.tap(card);
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.errors, []);
});

test('a backup with a different card identity can retrieve the cached account in one scan', async () => {
  const card = cachedCard(1);
  const state = mount([card]);
  state.openAccount(card);

  await state.flush();
  const backup = {...cachedCard(2), accounts: card.accounts};
  await state.tap(backup);
  assert.equal(state.scans.length, 1);
  assert.deepEqual(state.errors, []);
  assert(find(state.tree, node => node.type === 'CopyButton'));
});

test('only the tapped account is requested and receives its code', async () => {
  const first = cachedCard(1),
    second = cachedCard(2);
  const state = mount([first, second]);
  state.openAccount(second);
  await state.flush();
  await state.tap({
    ...cachedCard(3),
    accounts: [...first.accounts, ...second.accounts],
  });
  assert.deepEqual(state.prepared.indexes, [bytes(second.accounts[0].index)]);
  assert.equal(
    find(state.tree, node => node.type === 'CopyButton').props.label,
    `Copy code for ${second.accounts[0].label}`,
  );
  assert.equal(
    find(
      state.tree,
      node =>
        node.type === 'CopyButton' &&
        node.props.label === `Copy code for ${first.accounts[0].label}`,
    ),
    undefined,
  );
  assert.equal(state.scans.length, 1);
});

test('provider groups expand before scanning an account and collapse from their tags', async () => {
  const card = cachedCard(1, 3);
  card.accounts[0].label = 'GitHub: alice@example.com';
  card.accounts[1].label = 'GitHub: bob:work@example.com';
  card.accounts[2].label = 'Example: alice@example.com';
  const state = mount([card]);
  const summary = find(
    state.tree,
    node => node.props?.['aria-label'] === 'Show 2 GitHub accounts',
  );
  assert(summary);
  assert.equal(accountRow(state.tree, card.accounts[1].label), undefined);
  assert.equal(
    find(state.tree, node => node.type === 'ListItemDescription'),
    undefined,
  );
  summary.props.onExpand();
  state.render();
  assert.equal(state.scans.length, 0);
  const second = accountRow(state.tree, card.accounts[1].label);
  assert(second);
  assert.equal(
    find(second, node => node.type === 'ListItemName').props.children,
    'bob:work@example.com',
  );
  assert.equal(
    find(second, node => node.type === 'WhiteTag').props.children,
    'GitHub',
  );
  second.props.onClick();
  assert.deepEqual(state.destination, {index: card.accounts[1].index});
  assert.equal(state.scans.length, 0);
  const tag = find(
    state.tree,
    node => node.props?.['aria-label'] === 'Collapse GitHub accounts',
  );
  const stopPropagation = mock.fn();
  tag.props.onClick({stopPropagation});
  assert.equal(stopPropagation.mock.callCount(), 1);
  assert(
    find(
      state.render(),
      node => node.props?.['aria-label'] === 'Show 2 GitHub accounts',
    ),
  );
  assert.equal(state.scans.length, 0);
});

test('a sole provider expands by default while labels without providers stay independent', () => {
  const card = cachedCard(1, 2);
  card.accounts[0].label = ' GitHub : alice';
  card.accounts[1].label = 'GitHub: bob';
  const state = mount([card]);
  assert(accountRow(state.tree, card.accounts[0].label));
  assert(accountRow(state.tree, card.accounts[1].label));
  assert.equal(state.groups.size, 1);
  assert.equal(state.groups.get('provider:GitHub').expanded, true);
  const unknown = cachedCard(2, 2);
  const ungrouped = mount([unknown]);
  for (const account of unknown.accounts) {
    const row = accountRow(ungrouped.tree, account.label);
    assert(row);
    assert.equal(
      find(row, node => node.type === 'ListItemName').props.children,
      account.label,
    );
    assert.equal(
      find(row, node => node.type === 'WhiteTag').props.children,
      'OTP',
    );
    assert.equal(row.props.onExpand, undefined);
  }
  assert.equal(ungrouped.groups.size, 2);
});

test('account navigation stores only its index and starts no NFC on the list page', async () => {
  const card = cachedCard(1, 2);
  const state = mount([card]);
  accountRow(state.tree, card.accounts[1].label).props.onClick();
  await state.flush();
  assert.deepEqual(state.destination, {index: card.accounts[1].index});
  assert.equal(state.scans.length, 0);
  state.enterAccount();
  await state.flush();
  assert.equal(state.scans.length, 1);
});

test('backup copies render as one account and scanning a subset keeps other accounts', async () => {
  const first = cachedCard(1),
    second = cachedCard(2);
  const backup = {...cachedCard(3), accounts: first.accounts};
  const state = mount([first, second, backup]);
  assert.equal(state.entrances.otpStore.accounts.length, 2);
  state.click('Scan a card');
  await state.flush();
  await state.tap(backup);
  assert.equal(state.entrances.otpStore.accounts.length, 2);
  assert.equal(
    accountRow(state.tree, second.accounts[0].label).props.disabled,
    false,
  );
});

test('missing or conflicting selected accounts never calculate or display a code', async () => {
  const first = cachedCard(1);
  for (const accounts of [
    [],
    [{...first.accounts[0], keyIndex: `0514${'ff'.repeat(8)}`}],
  ]) {
    const state = mount([first]);
    state.openAccount(first);

    await state.flush();
    await state.tap({...cachedCard(2), accounts});
    assert.equal(state.events.includes('calculate'), false);
    assert.equal(
      find(state.tree, node => node.type === 'CopyButton'),
      undefined,
    );
    assert.match(state.errors[0].message, /OTP account does not match/);
  }
});

test('Get code accepts a backup even when the page was opened from another card', async () => {
  const first = cachedCard(1);
  const state = mount([first], {
    card: {id: first.id, publicKey: first.publicKey},
  });
  state.openAccount(first);

  await state.flush();
  await state.tap({...cachedCard(2), accounts: first.accounts});
  assert.deepEqual(state.errors, []);
  assert(find(state.tree, node => node.type === 'CopyButton'));
});

test('Enable OTP remains an explicit action without a cached card identity', async () => {
  const first = cachedCard(1);
  const state = mount([first]);
  find(
    state.render(),
    node => node.type === 'ViewHeaderButton',
  ).props.onClick();
  state.click('Enable OTP on card');
  await state.flush();
  await state.tap({...cachedCard(2), accounts: first.accounts});
  assert.deepEqual(state.events, [
    'unlock',
    'scan',
    'authenticate',
    'authorize',
    'cache',
  ]);
  assert.deepEqual(state.errors, []);
});

test('Forget removes only the cached entry without NFC', async () => {
  const first = cachedCard(1);
  const state = mount([first]);
  await find(
    state.render(),
    node =>
      node.type === 'SwipeAction' && node.props.children.includes('Forget'),
  ).props.onClick();
  await state.flush();
  assert.equal(state.entrances.otpStore.accounts.length, 0);
  assert.equal(state.scans.length, 0);
  assert.equal(
    find(
      state.tree,
      node => node.type === 'Button' && node.props.children === 'Get code',
    ),
    undefined,
  );
});

test('deleting an account from one backup retains its global cached entry', async () => {
  const first = cachedCard(1);
  const state = mount([first]);
  find(
    state.render(),
    node =>
      node.type === 'SwipeAction' && node.props.children.includes('Delete'),
  ).props.onClick();
  const confirmation = find(
    state.render(),
    node => node.type === 'ConfirmPopup',
  );
  assert.equal(confirmation.props.title, 'Delete from card');
  confirmation.props.onConfirm();
  await state.flush();
  await state.tap({...cachedCard(2), accounts: first.accounts});
  assert.deepEqual(state.entrances.otpStore.accounts, first.accounts);
  assert.equal(state.events.includes('remove'), true);
  assert.deepEqual(state.errors, []);
});

test('deletion detects a backup without OTP and removes its account without reauthorizing', async () => {
  const first = cachedCard(1);
  const state = mount([first]);
  find(
    state.render(),
    node =>
      node.type === 'SwipeAction' && node.props.children.includes('Delete'),
  ).props.onClick();
  find(state.render(), node => node.type === 'ConfirmPopup').props.onConfirm();
  await state.flush();
  await state.tap({
    ...cachedCard(2),
    installed: false,
    accounts: first.accounts,
  });
  assert.deepEqual(state.events, [
    'unlock',
    'scan',
    'probe',
    'authenticate',
    'remove',
    'cache',
    'scan',
  ]);
  assert.equal(state.removeInstalled, false);
  assert.deepEqual(state.entrances.otpStore.accounts, first.accounts);
  assert.deepEqual(state.errors, []);
  assert.equal(state.scans.at(-1).content, 'Scan next card to delete');
});

test('deletion continues on further cards until the next-card prompt is dismissed', async () => {
  const first = cachedCard(1);
  const second = {...cachedCard(2), accounts: first.accounts};
  const state = mount([first]);
  find(
    state.render(),
    node =>
      node.type === 'SwipeAction' && node.props.children.includes('Delete'),
  ).props.onClick();
  find(state.render(), node => node.type === 'ConfirmPopup').props.onConfirm();
  await state.flush();
  await state.tap(first);
  await state.tap(second);
  assert.equal(state.events.filter(event => event === 'remove').length, 2);

  const next = state.scans.at(-1);
  assert.equal(next.content, 'Scan next card to delete');
  assert.throws(
    () =>
      next.validate({
        id: bytes(first.id),
        publicKey: bytes(first.publicKey),
        pins: {access: 5, secret: 5},
      }),
    /Card already done/,
  );
  next.finished.reject(Object.assign(new Error(), {code: 'CANCELLED'}));
  await state.flush();
  assert.equal(state.scans.length, 3);
  assert.deepEqual(state.errors, []);
});

test('leaving during PIN unlock stops before input and NFC', async () => {
  const card = cachedCard(1);
  const state = mount([card]);
  state.pins = {};
  state.unlock = deferred();
  state.openAccount(card);

  await state.flush();
  state.leave();
  state.unlock.resolve();
  await state.flush();
  assert.equal(state.scans.length, 0);
  assert.ok(state.pinSession.clear.mock.callCount() >= 1);
  assert.deepEqual(state.errors, []);
});

test('leaving clears displayed codes without discarding cached accounts', async () => {
  const card = cachedCard(1);
  const state = mount([card]);
  state.openAccount(card);

  await state.flush();
  await state.tap(card);
  assert(find(state.tree, node => node.type === 'CopyButton'));
  state.leave();
  state.render();
  assert.equal(
    find(state.tree, node => node.type === 'CopyButton'),
    undefined,
  );
  assert.equal(state.entrances.otpStore.accounts.length, 1);
});

test('backgrounding clears visible codes', async () => {
  const card = cachedCard(1);
  const state = mount([card]);
  state.openAccount(card);

  await state.flush();
  await state.tap(card);
  state.background({isActive: false});
  await state.flush();
  assert.equal(
    find(state.tree, node => node.type === 'CopyButton'),
    undefined,
  );
});

test('Scan again stays visible, changes color with code availability and preserves a valid code during a retry', async () => {
  const card = cachedCard(1),
    state = mount([card]);
  state.openAccount(card);
  await state.flush();
  const button = () =>
    find(
      state.render(),
      node => node.type === 'Button' && node.props.children === 'Scan again',
    );
  assert.equal(button().props.color, 'primary');
  assert.equal(button().props.disabled, true);
  await state.tap(card);
  assert.equal(button().props.color, 'neutral');
  assert.equal(
    find(state.tree, node => node.type === 'CopyButton').props.showIcon,
    false,
  );
  assert.equal(
    find(state.tree, node => node.props?.['aria-label'] === 'Edit account name')
      .props.children,
    card.accounts[0].label,
  );
  assert.ok(
    find(
      state.tree,
      node => node.props?.['aria-label'] === '3 code windows remaining',
    ),
  );
  state.codeState = {
    current: {code: '345678', remaining: 12},
    progress: 0.4,
    prefetched: 0,
    exhausted: false,
  };
  state.render();
  assert.equal(
    find(state.tree, node => node.type === 'CopyButton').props.children.join(
      '',
    ),
    '345 678',
  );
  assert.ok(
    find(
      state.tree,
      node => node.props?.['aria-label'] === '1 code windows remaining',
    ),
  );
  const retry = button();
  retry.props.onClick();
  retry.props.onClick();
  await state.flush();
  assert.equal(state.scans.length, 2);
  assert.equal(button().props.disabled, true);
  assert.ok(find(state.tree, node => node.type === 'CopyButton'));
  state.scans[1].finished.resolve();
  await state.flush();
  assert.equal(button().props.color, 'neutral');
  state.codeState = {progress: 0, prefetched: 0, exhausted: true};
  state.render();
  assert.equal(button().props.color, 'primary');
  assert.equal(
    find(state.tree, node => node.type === 'CopyButton'),
    undefined,
  );
  assert.equal(
    find(state.tree, node => node.props?.role === 'timer'),
    undefined,
  );
  assert.equal(
    find(state.tree, node => node.props?.['aria-label'] === 'No current code'),
    undefined,
  );
});

test('cancelling the initial scan offers an explicit retry without automatically starting another scan', async () => {
  const card = cachedCard(1),
    state = mount([card]);
  state.openAccount(card);
  await state.flush();
  state.scans[0].finished.resolve();
  await state.flush();
  state.leave();
  runInAction(() => {
    state.view.$match.$exact.$active = true;
  });
  await state.flush();
  assert.equal(state.scans.length, 1);
  state.click('Scan again');
  await state.flush();
  assert.equal(state.scans.length, 2);
});

test('an account enters NFC only once its route becomes active, and a discarded entry does not start it', async () => {
  for (const discard of [false, true]) {
    const card = cachedCard(1),
      state = mount([card]);
    accountRow(state.tree, card.accounts[0].label).props.onClick();
    state.leave();
    state.enterAccount();
    await state.flush();
    assert.equal(state.scans.length, 0);
    if (discard) state.unmount();
    else {
      runInAction(() => {
        state.view.$match.$exact.$active = true;
      });
      await state.flush();
      assert.equal(state.scans.length, 1);
    }
  }
});

test('biometric deactivation on the account page preserves the pending unlock', async () => {
  const card = cachedCard(1),
    state = mount([card]);
  state.unlock = deferred();
  state.openAccount(card);
  await state.flush();
  state.background({isActive: false});
  state.background({isActive: true});
  state.unlock.resolve();
  await state.flush();
  await state.tap(card);
  assert.deepEqual(state.errors, []);
  assert.ok(find(state.tree, node => node.type === 'CopyButton'));
});

test('backgrounding during calculation aborts the operation and never publishes a late code', async () => {
  const card = cachedCard(1);
  const state = mount([card]);
  state.calculation = deferred();
  state.openAccount(card);

  await state.flush();
  const tapping = state.tap(card);
  await setImmediate();
  assert.equal(state.events.at(-1), 'calculate');
  state.background({isActive: false});
  state.calculation.resolve();
  await tapping;
  assert.equal(state.scans[0].signal.aborted, true);
  assert.equal(
    find(state.tree, node => node.type === 'CopyButton'),
    undefined,
  );
  assert.deepEqual(state.errors, []);
});

test('biometric background notification during PIN unlock does not cancel card management input', async () => {
  const card = cachedCard(1);
  const state = mount([card], {card: {id: card.id, publicKey: card.publicKey}});
  state.pins = {};
  state.unlock = deferred();
  state.click('Scan a card');
  await state.flush();
  state.background({isActive: false});
  state.background({isActive: true});
  state.unlock.resolve();
  await state.flush();
  assert.deepEqual(state.events, ['unlock', 'input', 'remember', 'scan']);
  await state.tap(card);
  assert.deepEqual(state.errors, []);
});

test('Card Applets context does not partition the cached account list or its menu', () => {
  const first = cachedCard(1),
    second = cachedCard(2);
  const state = mount([first, second], {
    card: {id: second.id, publicKey: second.publicKey},
  });
  find(
    state.render(),
    node => node.type === 'ViewHeaderButton',
  ).props.onClick();
  assert.equal(
    find(state.render(), node => node.type === 'DetailsPopupTitle').props
      .children,
    'One-time Password',
  );
});

test('an uncached Card Applets context validates its full identity on the first scan', async () => {
  const first = cachedCard(1),
    requested = cachedCard(2);
  const state = mount([first], {
    card: {id: requested.id, publicKey: requested.publicKey},
  });
  state.click('Scan a card');
  await state.flush();
  await state.tap(first);
  assert.deepEqual(state.events, ['unlock', 'input', 'remember', 'scan']);
  assert.match(state.errors[0].message, /Wrong card/);
  assert.equal(state.entrances.otpStore.accounts.length, 1);
});

test('account header renames the card alias, then the cached account', async () => {
  const card = cachedCard(1);
  card.accounts[0].label = 'Example:  alice';
  const state = mount([card]);
  state.openAccount(card);
  await state.flush();
  await state.tap(card);

  state.input = {promise: Promise.resolve('  Example: renamed  ')};
  find(
    state.render(),
    node => node.props?.['aria-label'] === 'Edit account name',
  ).props.onClick();
  await state.flush();
  assert.deepEqual(state.inputOptions.selection, {start: 10, end: 15});

  const scan = state.scans.at(-1);
  assert.equal(scan.content, 'Scan card to save name');
  assert.equal(scan.authentication, undefined);
  const writes = [];
  await scan.callback(
    {set: async request => writes.push(request)},
    () => {},
    undefined,
    scan.signal,
  );
  assert.deepEqual(writes, [
    {index: bytes(card.accounts[0].index), alias: 'Example: renamed'},
  ]);
  assert.equal(state.entrances.otpStore.accounts[0].label, 'Example: renamed');
});

test('tapping the provider tag selects the provider and cancelling starts no scan', async () => {
  const card = cachedCard(1);
  card.accounts[0].label = 'Example:  alice';
  const state = mount([card]);
  state.openAccount(card);
  await state.flush();
  await state.tap(card);
  const scans = state.scans.length;

  state.input = {promise: Promise.resolve(undefined)};
  find(
    state.render(),
    node => node.props?.['aria-label'] === 'Edit account provider',
  ).props.onClick();
  await state.flush();
  assert.deepEqual(state.inputOptions.selection, {start: 0, end: 7});
  assert.equal(state.scans.length, scans);
  assert.equal(state.entrances.otpStore.accounts[0].label, 'Example:  alice');
});
