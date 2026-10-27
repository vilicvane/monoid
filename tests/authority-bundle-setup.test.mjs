import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {observable, runInAction} from 'mobx';

import {AuthorityBundleSession} from '../.bld/app/@components/views/safe/@card/authority-bundle-session.js';
import {
  AuthorityError,
  validateAuthorityBundleName,
} from '../.bld/app/@lib/authority-client.js';

mock.module('styled-components', {
  namedExports: {
    styled: Object.assign(type => () => type, {
      p: () => 'p',
      span: () => 'span',
    }),
  },
});
mock.module('lucide-react', {
  namedExports: {
    List: 'list-icon',
    Mail: 'mail-icon',
    UserRound: 'user-icon',
    Wallet: 'wallet-icon',
  },
});
let current;
const element = (type, props) =>
  typeof type === 'function' ? type(props) : {type, props};
mock.module('react/jsx-runtime', {
  namedExports: {jsx: element, jsxs: element, Fragment: 'fragment'},
});
mock.module('react', {
  namedExports: {
    useRef(value) {
      const slot = (current.slots[current.index++] ??= {current: value});
      return slot;
    },
    useCallback(callback) {
      current.index++;
      return callback;
    },
    useState(initial) {
      const owner = current;
      const index = owner.index++;
      const slot = (owner.slots[index] ??= {
        value: typeof initial === 'function' ? initial() : initial,
      });
      return [
        slot.value,
        value => {
          if (!Object.is(slot.value, value)) {
            slot.value = value;
            owner.dirty = true;
          }
        },
      ];
    },
    useEffect(effect, deps) {
      const owner = current;
      const slot = (owner.slots[owner.index++] ??= {});
      if (slot.deps?.every((value, index) => Object.is(value, deps[index])))
        return;
      owner.effects.push(() => {
        slot.cleanup?.();
        slot.deps = deps;
        slot.cleanup = effect();
      });
    },
  },
});
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {useEntrances: () => current.entrances},
});
for (const [path, names] of [
  ['app-icon', ['AppIcon']],
  ['button', ['Button', 'Buttons']],
  [
    'details-popup',
    ['DetailsPopup', 'DetailsPopupTitle', 'DetailsPopupDivider'],
  ],
  [
    'info-section',
    [
      'InfoSection',
      'InfoSectionHeader',
      'InfoSectionItemLabel',
      'InfoFieldset',
      'InfoLegend',
    ],
  ],
  ['operation-complete', ['OperationComplete']],
  ['input', ['InputWithAction']],
  ['address', ['Address']],
  ['ellipsis-in-middle', ['EllipsisInMiddle']],
  ['symbol', ['Symbol']],
  [
    'list',
    [
      'List',
      'IconList',
      'ListItem',
      'ListItemButton',
      'ListItemContent',
      'ListItemName',
      'ListItemDescription',
    ],
  ],
  ['ripple-effect', ['RippleEffect']],
  ['toggle', ['Toggle']],
  ['message-content', ['InfoMessage']],
  ['segmented-control', ['SegmentedControl']],
])
  mock.module(`../.bld/app/@components/@ui/${path}.js`, {
    namedExports: Object.fromEntries(names.map(name => [name, name])),
  });
mock.module('../.bld/app/@components/@ui/step.js', {
  namedExports: {
    Steps: 'Steps',
    OperationSteps: 'OperationSteps',
    Step: props => ({
      type: 'Step',
      props: {
        ...props,
        children:
          props.numero === props.activeNumero ||
          (props.keepExpanded && props.numero < props.activeNumero)
            ? props.children
            : undefined,
      },
    }),
  },
});
mock.module('../.bld/app/@components/@view/index.js', {
  namedExports: {
    ViewContent: 'ViewContent',
    useViewActive: () => current.isActive,
  },
});
mock.module('../.bld/app/@components/@monoid/card-preview.js', {
  namedExports: {
    CardGrid: 'CardGrid',
    CardPreview: 'CardPreview',
    CardPreviewButton: 'CardPreviewButton',
    CardPlaceholder: 'CardPlaceholder',
  },
});
mock.module('../.bld/app/@components/@monoid/monoid-scan-prompt.js', {
  namedExports: {scanCardPrompt: card => `Scan card ${card.id}`},
});
mock.module('../.bld/app/@components/@monoid/pin-input-placeholder.js', {
  namedExports: {
    getPINInputPlaceholder: () => ({placeholder: 'Enter Secret PIN'}),
  },
});
mock.module('../.bld/app/@components/@monoid/use-isodep-scan-prompt.js', {
  namedExports: {
    useIsoDepScanPrompt: () => async (_prompt, callback) =>
      callback('test', () => {}, new AbortController().signal),
  },
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {useInputModal: () => [undefined, async () => 'Secret-42']},
});
mock.module(
  '../.bld/app/@components/views/safe/@card/use-bundle-card-addition.js',
  {
    namedExports: {
      useBundleCardAddition: options => {
        current.addition = options;
        return {
          busy: false,
          content: undefined,
          acceptCard: async hello => {
            await options.onAdded(hello);
            return true;
          },
          resume: async () => {},
        };
      },
    },
  },
);
const {AuthorityBundleSetup} = await import(
  '../.bld/app/@components/views/safe/@card/authority-bundle-setup.js'
);
const owners = [
  {source: 'reown', id: 'personal', displayName: 'Personal'},
  {source: 'wallet', id: 'wallet', displayName: 'Wallet'},
  {source: 'github-organization', id: 'team', displayName: 'Team'},
];
const bundles = [
  {name: 'Daily wallet', allowPeerExtension: true, createdAt: 1},
  {name: 'Recovery', allowPeerExtension: false, createdAt: 2},
];
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...nodes(node.props?.children), ...nodes(node.props?.footer)];
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node?.props ? text(node.props.children) : '';
}
function fixture(
  t,
  {
    signedIn = true,
    children,
    namespaces = owners,
    groups = bundles,
    sourceCard,
    flow,
  } = {},
) {
  const state = {slots: [], effects: [], errors: [], calls: [], dirty: true};
  state.active = observable.box(true);
  state.isActive = () => state.active.get();
  state.logouts = 0;
  state.flow = flow ?? {};
  state.flow.authority ??= new AuthorityBundleSession(
    'https://authority.monoid.app/',
    sourceCard,
  );
  state.view = {bundleId: 'flow'};
  const account = observable.box(
    signedIn
      ? {
          id: 'account',
          login: 'embedded-address',
          method: 'email',
          email: 'test@example.com',
        }
      : undefined,
    {deep: false},
  );
  const service = {
    get account() {
      return account.get();
    },
    set account(value) {
      runInAction(() => account.set(value));
    },
    get signedIn() {
      return !!account.get();
    },
    authorityUrl: 'https://authority.monoid.app/',
    signInState: {status: 'idle'},
    namespaces: async () => namespaces,
    groups: async owner => {
      state.calls.push(owner);
      return groups;
    },
    signOut: async () => {
      if (service.account) state.logouts++;
      service.account = undefined;
    },
  };
  state.entrances = {
    router: {
      $backTo: () => () => state.calls.push('back'),
      safe: {$exact: 'safe', card: {$exact: 'card'}},
      cardApplets: args => ({$push: () => state.calls.push(args)}),
    },
    cardStore: {get: () => undefined},
    monoidApplet: {openSession: async () => state.applet},
    authorityService: service,
    errorService: {
      catch: task => {
        const capture = async (...args) => {
          try {
            await (typeof task === 'function' ? task(...args) : task);
          } catch (error) {
            state.errors.push(error);
          }
        };
        return typeof task === 'function' ? capture : capture();
      },
    },
  };
  state.render = () => {
    do {
      current = state;
      state.index = 0;
      state.dirty = false;
      state.tree = AuthorityBundleSetup({
        children,
        session: state.flow.authority,
        view: state.view,
      });
      state.effects.splice(0).forEach(effect => effect());
    } while (state.dirty);
    return state.tree;
  };
  state.flush = async () => {
    for (let i = 0; i < 5; i++) {
      await setImmediate();
      state.render();
    }
  };
  state.find = (type, label) =>
    nodes(state.render()).find(
      node =>
        node.type === type && (label === undefined || text(node) === label),
    );
  state.click = async (type, label) => {
    const node = state.find(type, label);
    assert.ok(node, label);
    await node.props.onClick();
    await state.flush();
  };
  state.unmount = () => {
    state.slots.forEach(slot => slot?.cleanup?.());
    state.slots = [];
  };
  t.after(() => state.unmount());
  state.render();
  return state;
}

test('Authority bundle names use UTF-8 bytes, NFC and exact surrounding whitespace', () => {
  assert.equal(validateAuthorityBundleName('e\u0301'), 'é');
  for (const name of ['a', 'é', '😀'.repeat(32), 'a'.repeat(128)])
    assert.doesNotThrow(() => validateAuthorityBundleName(name));
  for (const name of [
    '',
    ' x',
    'x ',
    'a\n',
    'x\u200dy',
    '😀'.repeat(33),
    'a'.repeat(129),
  ])
    assert.throws(() => validateAuthorityBundleName(name));
});

function prepared(id = 1) {
  return {
    id: id.toString(16).padStart(8, '0'),
    publicKey: `04${id.toString(16).padStart(2, '0').repeat(64)}`,
    bundle: false,
    authority: 'https://authority.monoid.app/',
    alias: `Long alias for card ${id}`,
    allowPeerExtension: false,
  };
}

test('prepared and mixed cards use one next ring, pending labels, and acknowledged joins update the cache', async t => {
  const state = fixture(t, {sourceCard: prepared()});
  await state.flush();
  await state.click('Button', 'Continue');
  const session = state.flow.authority;
  assert.ok(session instanceof AuthorityBundleSession);
  session.addPrepared(prepared(2));
  session.addPrepared(prepared(3));
  let previews = nodes(state.render()).filter(
    node => node.type === 'CardPreview',
  );
  assert.deepEqual(
    previews.map(node => [node.props.$scan, node.props.description]),
    [
      ['next', 'pending'],
      ['pending', 'join later'],
      ['pending', 'join later'],
    ],
  );
  const hello = {
    version: 1,
    id: Uint8Array.of(0, 0, 0, 1),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(1)),
    bundle: false,
    authority: prepared().authority,
    alias: prepared().alias,
    allowPeerExtension: false,
    pins: {access: 5, secret: 5},
  };
  const hash = new Uint8Array(32).fill(42);
  state.applet = {
    hello: async () => hello,
    authenticate: async () => {},
    joinBundle: async () => ({bundle: hash}),
  };
  state.entrances.authorityService.issueBundle = async () => ({
    publicKey: hello.publicKey,
    data: new Uint8Array(),
    bundle: hash,
    allowPeerExtension: false,
  });
  const cached = prepared();
  state.entrances.cardStore = {
    get: () => cached,
    set: card => assert.equal(card, cached),
  };
  await state.click('Button', 'Scan card to join');
  assert.deepEqual(state.errors, []);
  assert.equal(cached.bundle, '2a'.repeat(32));
  previews = nodes(state.render()).filter(node => node.type === 'CardPreview');
  assert.deepEqual(
    previews.map(node => [node.props.$scan, node.props.description]),
    [
      ['ready', 'joined'],
      ['next', 'pending'],
      ['pending', 'join later'],
    ],
  );
  assert.equal(text(steps(state)[1].props.title), 'Add cards1/3');
  assert.ok(state.find('Button', 'Scan next card to join'));
  assert.equal(state.find('Button', 'Change bundle'), undefined);
});

test('Done exits the grid and steps before showing only completion and its neutral back button', async t => {
  const state = fixture(t, {sourceCard: prepared()});
  state.view.card = prepared();
  await state.flush();
  await state.click('Button', 'Continue');
  state.flow.authority.cards[0].joined = true;
  assert.equal(
    state.find('Button', 'Scan next card to join').props.color,
    undefined,
  );
  await state.click('Button', 'Done');
  assert.equal(state.logouts, 1);
  assert.equal(state.entrances.authorityService.signedIn, false);
  const exiting = state.find('OperationSteps');
  assert.equal(exiting.props.$exiting, true);
  assert.ok(state.find('CardGrid'));
  assert.equal(state.find('OperationComplete'), undefined);
  const target = {};
  exiting.props.onAnimationEnd({target: {}, currentTarget: target});
  assert.ok(state.find('OperationSteps'));
  exiting.props.onAnimationEnd({target, currentTarget: target});
  assert.ok(state.find('OperationComplete'));
  assert.equal(state.find('CardGrid'), undefined);
  assert.equal(state.find('OperationSteps'), undefined);
  assert.equal(state.find('Button', 'Back to Card').props.color, 'neutral');
});

for (const leaving of ['inactive', 'unmount']) {
  test(`${leaving} signs out the Authority flow and retains its cards`, async t => {
    const state = fixture(t, {sourceCard: prepared()});
    await state.flush();
    await state.click('Button', 'Continue');
    const session = state.flow.authority;
    if (leaving === 'inactive') runInAction(() => state.active.set(false));
    else state.unmount();
    assert.equal(state.logouts, 1);
    assert.equal(state.entrances.authorityService.signedIn, false);
    assert.equal(session.cards.length, 1);
    assert.equal(session.choice.name, 'Recovery');
  });
}

test('a mid-flow session end returns to Choose bundle signed out and resumes the retained cards after one sign-in', async t => {
  const state = fixture(t, {sourceCard: prepared()});
  await state.flush();
  await state.click('Button', 'Continue');
  const session = state.flow.authority;
  session.addPrepared(prepared(2));
  runInAction(() => {
    session.cards[0].joined = true;
  });
  const account = state.entrances.authorityService.account;
  await state.entrances.authorityService.signOut();
  await state.flush();
  assert.ok(state.find('Button', 'Sign in'));
  assert.equal(steps(state)[0].props.activeNumero, 1);
  assert.equal(session.cards.length, 2);
  assert.equal(session.joinedCount, 1);
  assert.equal(session.choice.name, 'Recovery');
  let signIns = 0;
  state.entrances.authorityService.signIn = async () => {
    signIns++;
    state.entrances.authorityService.account = account;
  };
  await state.click('Button', 'Sign in');
  assert.equal(signIns, 1);
  assert.ok(state.find('Button', 'Scan next card to join'));
  assert.equal(state.flow.authority, session);
  assert.equal(session.nextCard.id, prepared(2).id);
});

test('an installation detour signs out and retains the returned card until sign-in', async t => {
  const state = fixture(t, {sourceCard: prepared()});
  await state.flush();
  await state.click('Button', 'Continue');
  const account = state.entrances.authorityService.account;
  state.addition.onNeedsInstall({id: 'chip'});
  runInAction(() => state.active.set(false));
  assert.equal(state.logouts, 1);
  const installed = {
    ...prepared(2),
    id: Uint8Array.of(0, 0, 0, 2),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(2)),
  };
  runInAction(() => {
    state.flow.authority.installedCard = installed;
    state.active.set(true);
  });
  await state.flush();
  assert.equal(state.flow.authority.installedCard, installed);
  assert.equal(state.flow.authority.cards.length, 1);
  state.entrances.authorityService.account = account;
  await state.flush();
  assert.equal(state.flow.authority.installedCard, undefined);
  assert.equal(state.flow.authority.cards.length, 2);
});

test('401 during issuance returns to Sign in and retains cards and the chosen bundle', async t => {
  const state = fixture(t, {sourceCard: prepared()});
  await state.flush();
  await state.click('Button', 'Continue');
  const card = prepared();
  state.applet = {
    hello: async () => ({
      version: 1,
      ...card,
      id: Uint8Array.of(0, 0, 0, 1),
      publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(1)),
      pins: {access: 5, secret: 5},
    }),
    authenticate: async () => {},
    joinBundle: async () => assert.fail('Join after 401'),
  };
  state.entrances.authorityService.issueBundle = async () => {
    state.entrances.authorityService.account = undefined;
    throw new AuthorityError('unauthorized');
  };
  await state.click('Button', 'Scan card to join');
  assert.equal(state.errors.at(-1).code, 'unauthorized');
  assert.ok(state.find('Button', 'Sign in'));
  assert.equal(state.flow.authority.cards.length, 1);
  assert.equal(state.flow.authority.choice.name, 'Recovery');
});

test('the install redirect carries the flow ID and returns through the addition hook', async t => {
  const state = fixture(t, {sourceCard: prepared()});
  await state.flush();
  await state.click('Button', 'Continue');
  state.addition.onNeedsInstall({id: 'chip'});
  assert.deepEqual(state.calls.at(-1), {
    cardInformation: {id: 'chip'},
    returnTo: 'bundle',
    bundleId: 'flow',
  });
  const session = state.flow.authority;
  const restored = fixture(t, {flow: state.flow});
  await restored.flush();
  assert.equal(restored.flow.authority, session);
  assert.equal(steps(restored)[1].props.activeNumero, 2);
  assert.equal(session.choice.name, 'Recovery');
  assert.equal(session.cards.length, 1);
});

function steps(state) {
  return nodes(state.render()).filter(node => node.type === 'Step');
}
function input(state, value) {
  state.find('InputWithAction').props.onChange({target: {value}});
  state.render();
}

test('Sign in names the Authority in an InfoMessage; pending state and cancellation stay service-owned', async t => {
  const state = fixture(t, {signedIn: false});
  assert.equal(
    text(state.find('InfoMessage')),
    'Bundles are issued by authority.monoid.app.',
  );
  assert.deepEqual(
    steps(state).map(step => [
      typeof step.props.title === 'string'
        ? step.props.title
        : text(step.props.title),
      step.props.activeNumero,
    ]),
    [
      ['Choose bundle', 1],
      ['Add cards', 1],
    ],
  );
  const authority = state.entrances.authorityService;
  authority.signInState = {status: 'pending'};
  assert.equal(state.find('Button', 'Sign in').props.loading, true);
  authority.signInState = {status: 'idle'};
  authority.signIn = async () => {
    throw new AuthorityError('cancelled');
  };
  await state.click('Button', 'Sign in');
  assert.deepEqual(state.errors, []);
  assert.equal(state.find('Button', 'Sign in').props.loading, false);
  authority.signIn = async () => {
    throw new AuthorityError('network_error');
  };
  await state.click('Button', 'Sign in');
  assert.equal(state.errors.at(-1).code, 'network_error');
});

test('signed-in entry starts at Choose bundle, prefills the most recent bundle, and Continue produces summaries', async t => {
  const state = fixture(t, {groups: [bundles[1], bundles[0]]});
  await state.flush();
  assert.equal(steps(state)[0].props.summary, undefined);
  assert.equal(steps(state)[0].props.activeNumero, 1);
  assert.equal(state.find('InputWithAction').props.value, 'Recovery');
  assert.equal(state.find('Toggle').props.checked, false);
  assert.equal(state.find('Toggle').props.disabled, true);
  assert.equal(
    text(state.find('InfoFieldset')),
    'Signed in astest@example.comEmail',
  );
  assert.equal(state.find('Button', 'Continue').props.disabled, false);
  await state.click('Button', 'Continue');
  assert.deepEqual(
    steps(state).map(step => [
      typeof step.props.title === 'string' ? step.props.title : 'Add cards',
      step.props.summary && text(step.props.summary),
      step.props.activeNumero,
    ]),
    [
      ['Choose bundle', 'Account / Recovery', 2],
      ['Add cards', undefined, 2],
    ],
  );
  assert.ok(state.find('CardGrid'));
  assert.equal(state.find('Button', 'Change bundle').props.color, 'neutral');
  assert.ok(state.find('Button', 'Scan card to join'));
  await state.click('Button', 'Change bundle');
  assert.equal(state.find('InputWithAction').props.value, 'Recovery');
});

for (const owner of [
  {source: 'reown', id: 'personal', displayName: 'Personal'},
  {
    source: 'wallet',
    id: 'wallet-namespace',
    displayName: '0x58E61234567890abcdef1234567890abcdef06531',
  },
  {source: 'github-user', id: 'github-id', displayName: 'octocat'},
]) {
  test(`Choose bundle summary retains the ${owner.source} owner across remounts`, async t => {
    const state = fixture(t, {namespaces: [owner]});
    await state.flush();
    const name = 'a'.repeat(128);
    input(state, name);
    await state.click('Button', 'Continue');
    const expected = `${owner.source === 'reown' ? 'Account' : owner.displayName} / ${name}`;
    assert.equal(text(steps(state)[0].props.summary), expected);
    assert.deepEqual({...state.flow.authority.choice.owner}, owner);
    const wallet = nodes(steps(state)[0].props.summary).find(
      node => node.type === 'EllipsisInMiddle',
    );
    assert.equal(
      wallet?.props.children,
      owner.source === 'wallet' ? owner.displayName : undefined,
    );
    state.unmount();
    const restored = fixture(t, {flow: state.flow, namespaces: [owner]});
    await restored.flush();
    assert.equal(text(steps(restored)[0].props.summary), expected);
  });
}

test('owner selector uses source labels, excludes organizations and loads the newly selected owner', async t => {
  const state = fixture(t, {
    namespaces: [
      ...owners,
      {source: 'github-user', id: 'github', displayName: 'Github user'},
    ],
  });
  await state.flush();
  const selector = state.find('SegmentedControl');
  assert.deepEqual(
    selector.props.options.map(option => option.label),
    ['Account', 'Wallet', 'GitHub'],
  );
  state.entrances.authorityService.groups = async owner => {
    state.calls.push(owner);
    return [{name: 'Wallet bundle', allowPeerExtension: true, createdAt: 3}];
  };
  selector.props.onChange('1');
  await state.flush();
  assert.deepEqual(state.calls.at(-1), {source: 'wallet', id: 'wallet'});
  assert.equal(state.find('InputWithAction').props.value, 'Wallet bundle');
});

test('Choose bundle orders mode, account, owner and bundle controls', async t => {
  const mode = {type: 'mode-capsules', props: {}};
  const state = fixture(t, {children: mode});
  await state.flush();
  const controls = nodes(steps(state)[0]).filter(node =>
    [
      'mode-capsules',
      'InfoFieldset',
      'SegmentedControl',
      'InputWithAction',
      'Toggle',
    ].includes(node.type),
  );
  assert.deepEqual(
    controls.map(node => node.type),
    [
      'mode-capsules',
      'InfoFieldset',
      'SegmentedControl',
      'InputWithAction',
      'Toggle',
    ],
  );
});

for (const method of ['email', 'social', 'wallet']) {
  for (const email of [undefined, 'person@example.com']) {
    test(`${method} sign-in ${email ? 'with' : 'without'} email uses its actual sign-in identity`, async t => {
      const state = fixture(t, {namespaces: [owners[0]]});
      state.entrances.authorityService.account = {
        id: 'account',
        login: '0x1234567890abcdef1234567890abcdef12345678',
        method,
        email,
        provider: method === 'social' ? 'github' : undefined,
      };
      await state.flush();
      const fieldset = state.find('InfoFieldset');
      assert.equal(text(state.find('InfoLegend')), 'Signed in as');
      assert.ok(state.find('Symbol'));
      assert.equal(fieldset.props.onClick, undefined);
      assert.equal(state.find('ListItem').props.onClick, undefined);
      assert.equal(state.find('ListItemButton'), undefined);
      if (method === 'wallet') {
        assert.equal(
          state.find('Address').props.children,
          state.entrances.authorityService.account.login,
        );
        assert.equal(
          state.find('Address').props.title,
          state.entrances.authorityService.account.login,
        );
        assert.doesNotMatch(text(fieldset), /person@example/);
      } else {
        assert.equal(
          text(state.find('ListItemName')),
          email ?? (method === 'social' ? 'GitHub account' : 'Signed in.'),
        );
        assert.equal(state.find('Address'), undefined);
        assert.doesNotMatch(text(fieldset), /0x123456/);
      }
      assert.equal(
        text(state.find('ListItemDescription')),
        method === 'wallet'
          ? 'Wallet'
          : method === 'email'
            ? 'Email'
            : 'GitHub',
      );
      assert.equal(
        state.find('AppIcon').props.icon,
        method === 'wallet'
          ? 'wallet-icon'
          : method === 'email'
            ? 'mail-icon'
            : 'user-icon',
      );
    });
  }
}

test('social sign-in without provider metadata never falls back to the embedded address', async t => {
  const state = fixture(t);
  state.entrances.authorityService.account = {
    id: 'account',
    login: 'embedded-address',
    method: 'social',
  };
  await state.flush();
  assert.equal(text(state.find('ListItemName')), 'Social account');
  assert.equal(text(state.find('ListItemDescription')), 'Social');
  assert.doesNotMatch(text(state.find('InfoFieldset')), /embedded-address/);
});

test('one eligible namespace has no owner selector; no bundles has no picker action', async t => {
  const state = fixture(t, {namespaces: [owners[0], owners[2]], groups: []});
  await state.flush();
  assert.equal(state.find('SegmentedControl'), undefined);
  assert.equal(state.find('InputWithAction').props.action, undefined);
  assert.equal(state.find('InputWithAction').props.autoFocus, undefined);
  assert.equal(state.find('Button', 'Continue').props.disabled, true);
  assert.equal(state.find('Toggle').props.checked, true);
  assert.equal(state.find('Toggle').props.disabled, false);
  assert.match(
    nodes(state.render())
      .filter(node => node.type === 'InfoMessage')
      .map(text)
      .join(' '),
    /A new bundle's policy can't be changed/,
  );
  input(state, 'Family');
  assert.equal(state.find('Button', 'Continue').props.disabled, false);
});

test('picker has a divider and plain rows; a row fills the input without advancing, and Cancel preserves it', async t => {
  const state = fixture(t);
  await state.flush();
  state.find('InputWithAction').props.action.onClick();
  assert.ok(state.find('DetailsPopupDivider'));
  assert.ok(state.find('List'));
  assert.equal(state.find('Button', 'Cancel').props.color, 'neutral');
  await state.click('ListItemButton', 'Daily walletMembers can add cards');
  assert.equal(state.find('DetailsPopup'), undefined);
  assert.equal(state.find('InputWithAction').props.value, 'Daily wallet');
  assert.equal(steps(state)[0].props.activeNumero, 1);
  state.find('InputWithAction').props.action.onClick();
  await state.click('Button', 'Cancel');
  assert.equal(state.find('InputWithAction').props.value, 'Daily wallet');
});

test('typing an existing normalized name locks its policy; a new name has editable policy and a notice', async t => {
  const state = fixture(t, {
    groups: [
      ...bundles,
      {name: '\u00e9', allowPeerExtension: false, createdAt: 0},
    ],
  });
  await state.flush();
  input(state, 'e\u0301');
  assert.equal(state.find('InputWithAction').props.value, '\u00e9');
  assert.equal(state.find('Toggle').props.checked, false);
  assert.equal(state.find('Toggle').props.disabled, true);
  assert.equal(
    nodes(state.render()).filter(node => node.type === 'InfoMessage').length,
    0,
  );
  await state.click('Button', 'Continue');
  assert.equal(text(steps(state)[0].props.summary), 'Account / \u00e9');
  await state.click('Button', 'Change bundle');
  input(state, 'New family');
  assert.equal(state.find('Toggle').props.checked, true);
  assert.equal(state.find('Toggle').props.disabled, false);
  state.find('Toggle').props.onChange(false);
  assert.equal(state.find('Toggle').props.checked, false);
  assert.ok(state.find('InfoMessage'));
  for (const invalid of [' bad', 'x\u200dy', 'a'.repeat(129)]) {
    input(state, invalid);
    assert.equal(state.find('Button', 'Continue').props.disabled, true);
  }
});

test('a new decomposed name is normalized in the input and the completed summary', async t => {
  const state = fixture(t, {groups: []});
  await state.flush();
  input(state, 'Cafe\u0301');
  assert.equal(state.find('InputWithAction').props.value, 'Caf\u00e9');
  await state.click('Button', 'Continue');
  assert.equal(text(steps(state)[0].props.summary), 'Account / Caf\u00e9');
});

test('loading uses Step processing; a 401 clears selection and returns to Sign in without stale results', async t => {
  const state = fixture(t);
  let reject;
  state.entrances.authorityService.groups = () =>
    new Promise((_, fail) => {
      reject = fail;
    });
  await state.flush();
  assert.equal(steps(state)[0].props.processing, true);
  assert.equal(state.find('Button', 'Continue').props.disabled, true);
  state.entrances.authorityService.account = undefined;
  reject(new AuthorityError('unauthorized'));
  await state.flush();
  assert.equal(steps(state)[0].props.activeNumero, 1);
  assert.ok(state.find('Button', 'Sign in'));
  assert.equal(state.find('InputWithAction'), undefined);
  assert.equal(state.errors.at(-1).code, 'unauthorized');
});

test('an old owner response cannot overwrite the selected owner input', async t => {
  const state = fixture(t);
  let resolve;
  state.entrances.authorityService.groups = () =>
    new Promise(accept => {
      resolve = accept;
    });
  await state.flush();
  state.entrances.authorityService.groups = async () => [];
  state.find('SegmentedControl').props.onChange('1');
  await state.flush();
  input(state, 'New wallet bundle');
  resolve(bundles);
  await state.flush();
  assert.equal(state.find('InputWithAction').props.value, 'New wallet bundle');
  assert.equal(state.find('InputWithAction').props.action, undefined);
});
