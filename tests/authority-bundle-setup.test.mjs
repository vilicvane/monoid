import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {observable, runInAction} from 'mobx';

import {AuthorityBundleSession} from '../.bld/app/@components/views/safe/@card/authority-bundle-session.js';
import {
  AuthorityError,
  validateAuthorityBundleName,
} from '../.bld/app/@lib/authority-client.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';

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
    Plus: 'plus-icon',
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
    useIsoDepScanPrompt: () => {
      const state = current;
      return async (prompt, callback) => {
        state.scans++;
        state.scanPrompts.push(prompt);
        if (state.scanError) throw state.scanError;
        return callback('test', () => {}, new AbortController().signal);
      };
    },
  },
});
mock.module('../.bld/app/@components/@ui/use-input-modal.js', {
  namedExports: {
    useInputModal: () => {
      const state = current;
      return [
        undefined,
        async options => {
          state.pinPrompts++;
          return state.promptPIN?.(options);
        },
      ];
    },
  },
});
mock.module('../.bld/app/@components/views/safe/@card/read-card-for-setup.js', {
  namedExports: {
    readCardForSetup: async () =>
      current.firstScan ?? {type: 'ready', hello: current.firstHello},
  },
});
mock.module(
  '../.bld/app/@components/views/safe/@card/use-bundle-card-addition.js',
  {
    namedExports: {
      useBundleCardAddition: options => {
        const state = current;
        current.addition = options;
        return {
          busy: false,
          content: undefined,
          acceptCard: async hello => {
            state.acceptedCards.push(hello);
            await options.onAdded(hello);
            return true;
          },
          confirmReset: card => state.confirmReset(card),
          resume: async () => state.calls.push('add'),
          ...state.additionState,
        };
      },
    },
  },
);
const {AuthorityBundleSetup} = await import(
  '../.bld/app/@components/views/safe/@card/authority-bundle-setup.js'
);
const owners = [
  {source: 'google', id: 'google-sub', displayName: 'test@example.com'},
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
    sourceCard = prepared(),
    flow,
  } = {},
) {
  const state = {
    slots: [],
    effects: [],
    errors: [],
    calls: [],
    dirty: true,
    scans: 0,
    scanPrompts: [],
    pinPrompts: 0,
    acceptedCards: [],
  };
  state.active = observable.box(true);
  state.isActive = () => state.active.get();
  state.logouts = 0;
  state.flow = flow ?? {};
  state.flow.authority ??= new AuthorityBundleSession(sourceCard);
  state.view = {bundleId: 'flow'};
  const account = observable.box(
    signedIn
      ? {
          source: 'google',
          id: 'google-sub',
          displayName: 'test@example.com',
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
    authorityUrl:
      state.flow.authority.authorityUrl ?? 'https://authority.monoid.app/',
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
  state.authority = service;
  state.selectedAuthorities = [];
  state.entrances = {
    router: {
      $backTo: () => () => state.calls.push('back'),
      safe: {$exact: 'safe', card: {$exact: 'card'}},
      cardApplets: args => ({$push: () => state.calls.push(args)}),
    },
    cardStore: {get: () => undefined},
    monoidApplet: {openSession: async () => state.applet},
    authorityService: {
      forAuthority: url => {
        state.selectedAuthorities.push(url);
        assert.equal(url, service.authorityUrl);
        return service;
      },
    },
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
  assert.equal(validateAuthorityBundleName(''), '');
  assert.equal(validateAuthorityBundleName('e\u0301'), 'é');
  for (const name of ['a', 'é', '😀'.repeat(32), 'a'.repeat(128)])
    assert.doesNotThrow(() => validateAuthorityBundleName(name));
  for (const name of [
    ' ',
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

function scanned(id = 1, overrides = {}) {
  return {
    ...prepared(id),
    version: 1,
    id: Uint8Array.of(0, 0, 0, id),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(id)),
    pins: {secret: 5, access: 5},
    ...overrides,
  };
}

test('Setup is card-first, keeps mode capsules in Scan card and retains that card as the join candidate', async t => {
  const mode = {type: 'mode-capsules', props: {}};
  const state = fixture(t, {sourceCard: null, signedIn: false, children: mode});
  const url = 'https://card.example/authority/';
  state.authority.authorityUrl = url;
  state.firstHello = scanned(1, {authority: 'HTTPS://CARD.EXAMPLE/authority'});
  assert.deepEqual(
    steps(state).map(step => [text(step.props.title), step.props.numero]),
    [
      ['Scan card', 1],
      ['Choose bundle', 2],
      ['Add cards', 3],
    ],
  );
  assert.ok(nodes(steps(state)[0]).some(node => node.type === 'mode-capsules'));
  const scanCard = state.find('CardPreviewButton');
  assert.equal(scanCard.props['aria-label'], 'Scan a card');
  const placeholder = state.find('CardPlaceholder');
  assert.equal(placeholder.props.children.type, 'AppIcon');
  assert.equal(placeholder.props.children.props.icon, 'plus-icon');
  assert.ok(state.find('Button', 'Scan card'));
  assert.equal(state.find('Button', 'Sign in'), undefined);
  assert.deepEqual(state.selectedAuthorities, []);
  await state.click('Button', 'Scan card');
  assert.equal(state.flow.authority.authorityUrl, url);
  assert.equal(state.flow.authority.cards[0].publicKey, prepared().publicKey);
  assert.equal(state.pinPrompts, 0);
  assert.equal(state.scans, 1);
  assert.equal(steps(state)[0].props.summary, prepared().alias);
  assert.equal(steps(state)[1].props.activeNumero, 2);
  assert.equal(
    text(nodes(steps(state)[1]).find(node => node.type === 'InfoMessage')),
    'Bundles are issued by card.example.',
  );
  state.authority.signIn = async () => {
    state.calls.push(['signIn', url]);
    state.authority.account = owners[0];
  };
  await state.click('Button', 'Sign in');
  assert.equal(steps(state)[1].props.activeNumero, 2);
  assert.equal(state.find('InfoMessage'), undefined);
  assert.ok(state.find('InfoFieldset'));
  await state.click('Button', 'Continue');
  assert.equal(steps(state)[2].props.activeNumero, 3);
  const candidate = state.find('CardPreview');
  assert.equal(candidate.props.id, prepared().id);
  assert.equal(candidate.props.alias, prepared().alias);
  assert.equal(candidate.props.$scan, 'next');
  assert.equal(state.flow.authority.nextCard, state.flow.authority.cards[0]);
  assert.ok(state.find('Button', 'Scan card to join'));
  assert.ok(state.selectedAuthorities.every(selected => selected === url));
  assert.equal(state.flow.authority.cards.length, 1);
});

test('Card entry signs in, lists bundles and joins using its own normalized authority', async t => {
  const url = 'https://card.example/authority/';
  const sourceCard = {
    ...prepared(),
    authority: 'HTTPS://CARD.EXAMPLE/authority',
  };
  const state = fixture(t, {sourceCard, signedIn: false});
  state.view.card = sourceCard;
  const events = [];
  assert.equal(steps(state)[0].props.numero, 1);
  assert.equal(steps(state)[0].props.activeNumero, 2);
  assert.equal(steps(state)[0].props.summary, sourceCard.alias);
  assert.equal(steps(state)[0].props.children, undefined);
  assert.equal(steps(state)[1].props.title, 'Choose bundle');
  assert.equal(steps(state)[1].props.activeNumero, 2);
  assert.equal(state.find('Button', 'Scan card'), undefined);
  assert.equal(state.scans, 0);
  assert.equal(
    text(nodes(steps(state)[1]).find(node => node.type === 'InfoMessage')),
    'Bundles are issued by card.example.',
  );
  state.authority.signIn = async () => {
    events.push(['signIn', state.authority.authorityUrl]);
    state.authority.account = owners[0];
  };
  state.authority.groups = async () => {
    events.push(['groups', state.authority.authorityUrl]);
    return bundles;
  };
  const hash = new Uint8Array(32).fill(42);
  state.authority.issueBundle = async () => {
    events.push(['issue', state.authority.authorityUrl]);
    return {
      publicKey: new Uint8Array(65),
      data: new Uint8Array(182),
      bundle: hash,
      allowPeerExtension: false,
    };
  };
  state.applet = {
    hello: async () => scanned(1, {authority: url}),
    authenticate: async () => {},
    joinBundle: async () => ({bundle: hash}),
  };
  state.promptPIN = () => 'Secret-42';
  await state.click('Button', 'Sign in');
  await state.click('Button', 'Continue');
  const candidate = state.find('CardPreview');
  assert.equal(candidate.props.id, sourceCard.id);
  assert.equal(candidate.props.alias, sourceCard.alias);
  assert.equal(candidate.props.$scan, 'ready');
  assert.equal(state.flow.authority.nextCard, undefined);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(events, [
    ['signIn', url],
    ['groups', url],
    ['issue', url],
  ]);
  assert.equal(state.flow.authority.joinedCount, 1);
  assert.equal(state.pinPrompts, 1);
  assert.equal(state.scans, 1);
  assert.ok(state.selectedAuthorities.every(selected => selected === url));
});

test('Continue joins only the first scanned card once, after its Secret PIN', async t => {
  const state = fixture(t, {sourceCard: null});
  state.firstHello = scanned();
  await state.click('Button', 'Scan card');
  const session = state.flow.authority;
  session.addPrepared(prepared(2));
  const hash = new Uint8Array(32).fill(42);
  let joins = 0;
  let issues = 0;
  state.applet = {
    hello: async () => scanned(),
    authenticate: async () => {},
    joinBundle: async () => {
      joins++;
      return {bundle: hash};
    },
  };
  state.authority.issueBundle = async () => {
    issues++;
    return {
      publicKey: scanned().publicKey,
      data: new Uint8Array(),
      bundle: hash,
      allowPeerExtension: false,
    };
  };
  let submitPIN;
  state.promptPIN = options => {
    assert.equal(options.placeholder, 'Enter Secret PIN');
    assert.equal(options.description, `Card ${prepared().alias}`);
    assert.equal(session.choice.name, 'Recovery');
    return new Promise(resolve => {
      submitPIN = resolve;
    });
  };
  const joining = state.find('Button', 'Continue').props.onClick();
  await state.flush();
  assert.equal(steps(state)[2].props.activeNumero, 3);
  assert.equal(state.pinPrompts, 1);
  assert.equal(state.scans, 1);
  assert.equal(joins, 0);
  submitPIN('Secret-42');
  await joining;
  await state.flush();
  assert.deepEqual(state.errors, []);
  assert.equal(state.scans, 2);
  assert.deepEqual(state.scanPrompts, [
    'Scan a card',
    `Scan card ${prepared().id}`,
  ]);
  assert.equal(issues, 1);
  assert.equal(joins, 1);
  assert.equal(session.joinedCount, 1);
  assert.equal(session.nextCard.id, prepared(2).id);
  assert.ok(state.find('Button', 'Scan next card to join'));
  session.addPrepared(prepared(3));
  await state.flush();
  assert.equal(state.pinPrompts, 1);
  assert.equal(state.scans, 2);
});

for (const outcome of [
  'PIN cancellation',
  'scan cancellation',
  'scan failure',
]) {
  test(`Continue leaves a manual retry after ${outcome}, without replay on re-entry`, async t => {
    const state = fixture(t);
    await state.flush();
    const cancelledPIN = outcome === 'PIN cancellation';
    const failure = new Error(outcome);
    if (outcome === 'scan cancellation') failure.name = 'AbortError';
    state.promptPIN = () => (cancelledPIN ? undefined : 'Secret-42');
    state.scanError = failure;
    await state.click('Button', 'Continue');
    assert.equal(steps(state)[2].props.activeNumero, 3);
    assert.equal(state.pinPrompts, 1);
    assert.equal(state.scans, cancelledPIN ? 0 : 1);
    assert.equal(state.flow.authority.joinedCount, 0);
    assert.deepEqual(state.errors, outcome === 'scan failure' ? [failure] : []);
    assert.equal(
      state.find('Button', 'Scan card to join').props.loading,
      false,
    );
    await state.flush();
    assert.equal(state.pinPrompts, 1);
    assert.equal(state.scans, cancelledPIN ? 0 : 1);
    state.unmount();
    const restored = fixture(t, {flow: state.flow});
    await restored.flush();
    assert.equal(steps(restored)[2].props.activeNumero, 3);
    assert.equal(restored.pinPrompts, 0);
    assert.equal(restored.scans, 0);
    await restored.click('Button', 'Scan card to join');
    assert.equal(restored.pinPrompts, 1);
    assert.equal(restored.scans, 0);
    assert.deepEqual(restored.errors, []);
  });
}

test('an already-joined first card does not auto-start the next card on entry', async t => {
  const session = new AuthorityBundleSession(prepared());
  session.choose({owner: owners[0], ...bundles[1]});
  runInAction(() => {
    session.cards[0].joined = true;
  });
  session.addPrepared(prepared(2));
  const state = fixture(t, {flow: {authority: session}});
  await state.flush();
  assert.equal(steps(state)[2].props.activeNumero, 3);
  assert.equal(state.pinPrompts, 0);
  assert.equal(state.scans, 0);
  assert.ok(state.find('Button', 'Scan next card to join'));
  assert.deepEqual(state.errors, []);
});

test('a first card without authority is rejected before sign-in or PIN input', async t => {
  const state = fixture(t, {sourceCard: null, signedIn: false});
  state.firstHello = scanned(1, {
    authority: false,
    pins: {secret: false, access: false},
  });
  await state.click('Button', 'Scan card');
  assert.match(
    state.errors[0].message,
    /doesn't trust an authority\. Reinstall its applets with one\./,
  );
  assert.equal(state.flow.authority.authorityUrl, undefined);
  assert.equal(state.flow.authority.cards.length, 0);
  assert.equal(state.pinPrompts, 0);
  assert.deepEqual(state.selectedAuthorities, []);
});

test('first-card PIN setup waits for sign-in and bundle selection', async t => {
  const state = fixture(t, {sourceCard: null, signedIn: false});
  state.firstHello = scanned(1, {pins: {secret: false, access: false}});
  await state.click('Button', 'Scan card');
  assert.equal(state.pinPrompts, 0);
  assert.deepEqual(state.acceptedCards, []);
  state.authority.account = owners[0];
  await state.flush();
  assert.deepEqual(state.acceptedCards, []);
  await state.click('Button', 'Continue');
  assert.deepEqual(state.acceptedCards, [state.firstHello]);
  assert.equal(state.flow.authority.installedCard, undefined);
});

test('card-first setup resumes an installation detour using the returned card authority before sign-in', async t => {
  const state = fixture(t, {sourceCard: null, signedIn: false});
  state.firstScan = {type: 'setup', cardInformation: {id: 'chip'}};
  await state.click('Button', 'Scan card');
  assert.deepEqual(state.calls.at(-1), {
    cardInformation: {id: 'chip'},
    returnTo: 'bundle',
    bundleId: 'flow',
  });
  assert.deepEqual(state.selectedAuthorities, []);
  const url = 'https://installed-card.example/';
  state.authority.authorityUrl = url;
  runInAction(() => {
    state.active.set(false);
    state.flow.authority.installedCard = scanned(2, {authority: url});
    state.active.set(true);
  });
  await state.flush();
  assert.equal(state.flow.authority.authorityUrl, url);
  assert.equal(state.flow.authority.nextCard.id, prepared(2).id);
  assert.equal(state.flow.authority.installedCard, undefined);
  assert.equal(state.pinPrompts, 0);
  assert.ok(state.find('Button', 'Sign in'));
});

for (const member of [false, true]) {
  test(`Continue ${member ? 'recognizes an already-joined' : 'opens reset confirmation for a'} bundled prepared card before PIN or scan`, async t => {
    const hash = new Uint8Array(32).fill(42);
    const bundle = member ? hash : new Uint8Array(32).fill(7);
    const sourceCard = {
      ...prepared(),
      bundle: Buffer.from(bundle).toString('hex'),
    };
    const state = fixture(t, {sourceCard});
    await state.flush();
    const events = [];
    state.authority.issueBundle = async input => {
      assert.equal(
        Buffer.from(input.recipientPublicKey).toString('hex'),
        sourceCard.publicKey,
      );
      events.push('issue');
      return {bundle: hash};
    };
    state.confirmReset = card => {
      assert.deepEqual(card, {...sourceCard, joined: false});
      events.push('reset confirmation');
    };
    await state.click('Button', 'Continue');
    assert.deepEqual(state.errors, []);
    assert.deepEqual(
      events,
      member ? ['issue'] : ['issue', 'reset confirmation'],
    );
    assert.equal(state.pinPrompts, 0);
    assert.equal(state.scans, 0);
    assert.equal(state.flow.authority.joinedCount, member ? 1 : 0);
    assert.equal(state.flow.authority.cards.length, 1);
  });
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
  assert.ok(previews.every(node => !node.props.aliasToggle));
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
  state.authority.issueBundle = async () => ({
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
  state.promptPIN = () => 'Secret-42';
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
  assert.equal(text(steps(state)[2].props.title), 'Add cards1/3');
  assert.ok(state.find('Button', 'Scan next card to join'));
  assert.equal(state.find('Button', 'Change bundle'), undefined);
});

test('the footer joins the first card and preserves pending PIN/reset actions', async t => {
  const state = fixture(t);
  await state.flush();
  await state.click('Button', 'Continue');
  const session = state.flow.authority;
  assert.ok(state.find('Button', 'Scan card to join'));
  for (const [pending, label] of [
    ['pendingPIN', 'Set Secret PIN'],
    ['pendingReset', 'Check card'],
  ]) {
    state.additionState = {[pending]: {}, buttonLabel: label};
    await state.click('Button', label);
    assert.equal(state.calls.at(-1), 'add');
    assert.equal(state.find('Button', 'Scan card to join'), undefined);
    assert.equal(state.pinPrompts, 1);
    assert.equal(state.scans, 0);
  }
  state.additionState = undefined;
  session.cards[0].joined = true;
  await state.click('Button', 'Add another card');
  assert.equal(state.calls.at(-1), 'add');
  assert.equal(state.find('Button', 'Scan next card to join'), undefined);
  session.addPrepared(prepared(2));
  assert.ok(state.find('Button', 'Scan next card to join'));
});

test('Done exits the grid and steps before showing only completion and its neutral back button', async t => {
  const state = fixture(t, {sourceCard: prepared()});
  state.view.card = prepared();
  await state.flush();
  await state.click('Button', 'Continue');
  state.flow.authority.cards[0].joined = true;
  assert.equal(state.find('Button', 'Add another card').props.color, undefined);
  await state.click('Button', 'Done');
  assert.equal(state.logouts, 1);
  assert.equal(state.authority.signedIn, false);
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
    assert.equal(state.authority.signedIn, false);
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
  const account = state.authority.account;
  await state.authority.signOut();
  await state.flush();
  assert.ok(state.find('Button', 'Sign in'));
  assert.equal(steps(state)[1].props.activeNumero, 2);
  assert.equal(session.cards.length, 2);
  assert.equal(session.joinedCount, 1);
  assert.equal(session.choice.name, 'Recovery');
  let signIns = 0;
  state.authority.signIn = async () => {
    signIns++;
    state.authority.account = account;
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
  const account = state.authority.account;
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
  state.authority.account = account;
  await state.flush();
  assert.equal(state.flow.authority.installedCard, undefined);
  assert.equal(state.flow.authority.cards.length, 2);
});

test('401 during issuance returns to Choose bundle signed out and retains cards and the chosen bundle', async t => {
  const state = fixture(t, {sourceCard: prepared()});
  await state.flush();
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
  state.authority.issueBundle = async () => {
    state.authority.account = undefined;
    throw new AuthorityError('unauthorized');
  };
  state.promptPIN = () => 'Secret-42';
  await state.click('Button', 'Continue');
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
  assert.equal(steps(restored)[2].props.activeNumero, 3);
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

test('Choose bundle names the Authority before sign-in; pending state and cancellation stay service-owned', async t => {
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
      ['Scan card', 2],
      ['Choose bundle', 2],
      ['Add cards', 2],
    ],
  );
  const authority = state.authority;
  authority.signInState = {status: 'pending'};
  assert.equal(state.find('Button', 'Sign in').props.loading, true);
  assert.equal(steps(state)[1].props.processing, false);
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
  assert.equal(steps(state)[1].props.summary, undefined);
  assert.equal(steps(state)[1].props.activeNumero, 2);
  assert.equal(state.find('InputWithAction').props.value, 'Recovery');
  assert.equal(state.find('Toggle').props.checked, false);
  assert.equal(state.find('Toggle').props.disabled, true);
  assert.equal(
    text(state.find('InfoFieldset')),
    'Signed in astest@example.comGoogle',
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
      ['Scan card', prepared().alias, 3],
      ['Choose bundle', 'test@example.com / Recovery', 3],
      ['Add cards', undefined, 3],
    ],
  );
  assert.ok(state.find('CardGrid'));
  assert.equal(state.find('Button', 'Change bundle').props.color, 'neutral');
  assert.ok(state.find('Button', 'Scan card to join'));
  await state.click('Button', 'Change bundle');
  assert.equal(state.find('InputWithAction').props.value, 'Recovery');
});

for (const owner of [
  {source: 'google', id: 'google-sub', displayName: 'test@example.com'},
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
    const expected = `${owner.displayName} / ${name}`;
    assert.equal(text(steps(state)[1].props.summary), expected);
    assert.deepEqual({...state.flow.authority.choice.owner}, owner);
    const wallet = nodes(steps(state)[1].props.summary).find(
      node => node.type === 'EllipsisInMiddle',
    );
    assert.equal(
      wallet?.props.children,
      owner.source === 'wallet' ? owner.displayName : undefined,
    );
    state.unmount();
    const restored = fixture(t, {flow: state.flow, namespaces: [owner]});
    await restored.flush();
    assert.equal(text(steps(restored)[1].props.summary), expected);
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
    ['Google', 'Wallet', 'GitHub'],
  );
  state.authority.groups = async owner => {
    state.calls.push(owner);
    return [{name: 'Wallet bundle', allowPeerExtension: true, createdAt: 3}];
  };
  selector.props.onChange('1');
  await state.flush();
  assert.deepEqual(state.calls.at(-1), {source: 'wallet', id: 'wallet'});
  assert.equal(state.find('InputWithAction').props.value, 'Wallet bundle');
});

test('Choose bundle orders account, owner and bundle controls; mode stays in Scan card', async t => {
  const mode = {type: 'mode-capsules', props: {}};
  const state = fixture(t, {children: mode});
  await state.flush();
  const controls = nodes(steps(state)[1]).filter(node =>
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
    ['InfoFieldset', 'SegmentedControl', 'InputWithAction', 'Toggle'],
  );
});

for (const account of [
  {source: 'google', id: 'google-sub', displayName: 'person@example.com'},
  {source: 'google', id: 'google-sub', displayName: 'Person Name'},
  {source: 'google', id: 'google-sub', displayName: 'Google account'},
  {source: 'github-user', id: '12345', displayName: 'vilic'},
  {
    source: 'wallet',
    id: 'eip155:0x58e61234567890abcdef1234567890abcdef06531',
    displayName: '0x58E61234567890abcdef1234567890abcdef06531',
  },
]) {
  test(`${account.source} account row displays ${account.displayName}`, async t => {
    const state = fixture(t, {namespaces: [account]});
    state.authority.account = account;
    await state.flush();
    const fieldset = state.find('InfoFieldset');
    assert.equal(text(state.find('InfoLegend')), 'Signed in as');
    assert.ok(state.find('Symbol'));
    assert.equal(fieldset.props.onClick, undefined);
    assert.equal(state.find('ListItem').props.onClick, undefined);
    assert.equal(state.find('ListItemButton'), undefined);
    assert.equal(text(state.find('ListItemName')), account.displayName);
    if (account.source === 'wallet') {
      assert.equal(state.find('Address').props.children, account.displayName);
      assert.equal(state.find('Address').props.title, account.displayName);
      assert.equal(
        state.find('Address').props['aria-label'],
        account.displayName,
      );
    } else {
      assert.equal(state.find('Address'), undefined);
    }
    assert.equal(
      text(state.find('ListItemDescription')),
      {google: 'Google', 'github-user': 'GitHub', wallet: 'Wallet'}[
        account.source
      ],
    );
    assert.equal(
      state.find('AppIcon').props.icon,
      account.source === 'wallet' ? 'wallet-icon' : 'user-icon',
    );
  });
}

test('one eligible namespace has no owner selector; no bundles has no picker action', async t => {
  const state = fixture(t, {namespaces: [owners[0], owners[2]], groups: []});
  await state.flush();
  assert.equal(state.find('SegmentedControl'), undefined);
  assert.equal(state.find('InputWithAction').props.action, undefined);
  assert.equal(state.find('InputWithAction').props.autoFocus, undefined);
  assert.equal(state.find('Button', 'Continue').props.disabled, false);
  assert.equal(
    state.find('InputWithAction').props.placeholder,
    'Bundle name (optional)',
  );
  assert.equal(state.find('Toggle').props.checked, true);
  assert.equal(state.find('Toggle').props.disabled, false);
  assert.match(
    nodes(state.render())
      .filter(node => node.type === 'InfoMessage')
      .map(text)
      .join(' '),
    /A new bundle's policy can't be changed/,
  );
  await state.click('Button', 'Continue');
  assert.equal(state.flow.authority.choice.name, '');
  assert.equal(text(steps(state)[1].props.summary), owners[0].displayName);
  await state.click('Button', 'Change bundle');
  input(state, 'Family');
  assert.equal(state.find('Button', 'Continue').props.disabled, false);
});

test('the most recent unnamed bundle prefills empty and locks its own policy', async t => {
  const state = fixture(t, {
    groups: [...bundles, {name: '', allowPeerExtension: false, createdAt: 3}],
  });
  await state.flush();
  assert.equal(state.find('InputWithAction').props.value, '');
  assert.equal(state.find('Button', 'Continue').props.disabled, false);
  assert.equal(state.find('Toggle').props.disabled, true);
  assert.equal(state.find('Toggle').props.checked, false);
  assert.equal(state.find('InfoMessage'), undefined);
  await state.click('Button', 'Continue');
  assert.equal(state.flow.authority.choice.name, '');
  assert.equal(state.flow.authority.choice.allowPeerExtension, false);
  assert.equal(text(steps(state)[1].props.summary), owners[0].displayName);
  await state.click('Button', 'Change bundle');
  input(state, 'Daily wallet');
  assert.equal(state.find('Toggle').props.checked, true);
  assert.equal(state.find('Toggle').props.disabled, true);
  input(state, '');
  assert.equal(state.find('Toggle').props.checked, false);
  assert.equal(state.find('Toggle').props.disabled, true);
});

for (const owner of [
  owners[0],
  {
    source: 'wallet',
    id: 'eip155:0x52908400098527886e0f7030069857d2e4169ee7',
    displayName: '0x52908400098527886E0F7030069857D2E4169EE7',
  },
]) {
  test(`unnamed ${owner.source} picker row uses the owner and clears the input`, async t => {
    const state = fixture(t, {
      namespaces: [owner],
      groups: [{name: '', allowPeerExtension: false, createdAt: 0}, ...bundles],
    });
    await state.flush();
    assert.equal(state.find('InputWithAction').props.value, 'Recovery');
    state.find('InputWithAction').props.action.onClick();
    const row = state.find(
      'ListItemButton',
      `${owner.displayName}Only the authority adds cards`,
    );
    assert.ok(row);
    if (owner.source === 'wallet')
      assert.ok(nodes(row).find(node => node.type === 'EllipsisInMiddle'));
    await state.click(
      'ListItemButton',
      `${owner.displayName}Only the authority adds cards`,
    );
    assert.equal(state.find('InputWithAction').props.value, '');
    assert.equal(state.find('Toggle').props.disabled, true);
    assert.equal(state.find('Button', 'Continue').props.disabled, false);
    await state.click('Button', 'Continue');
    assert.equal(text(steps(state)[1].props.summary), owner.displayName);
    assert.equal(state.flow.authority.choice.name, '');
    if (owner.source === 'wallet')
      assert.ok(
        nodes(steps(state)[1].props.summary).find(
          node => node.type === 'EllipsisInMiddle',
        ),
      );
  });
}

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
  assert.equal(steps(state)[1].props.activeNumero, 2);
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
  assert.equal(
    text(steps(state)[1].props.summary),
    'test@example.com / \u00e9',
  );
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
  assert.equal(
    text(steps(state)[1].props.summary),
    'test@example.com / Caf\u00e9',
  );
});

test('loading uses Choose bundle processing; a 401 returns there signed out without stale results', async t => {
  const state = fixture(t);
  let reject;
  state.authority.groups = () =>
    new Promise((_, fail) => {
      reject = fail;
    });
  await state.flush();
  assert.equal(steps(state)[1].props.processing, true);
  assert.equal(state.find('Button', 'Continue').props.disabled, true);
  state.authority.account = undefined;
  reject(new AuthorityError('unauthorized'));
  await state.flush();
  assert.equal(steps(state)[1].props.activeNumero, 2);
  assert.equal(steps(state)[1].props.processing, false);
  assert.ok(state.find('Button', 'Sign in'));
  assert.equal(state.find('InputWithAction'), undefined);
  assert.equal(state.errors.at(-1).code, 'unauthorized');
});

test('an old owner response cannot overwrite the selected owner input', async t => {
  const state = fixture(t);
  let resolve;
  state.authority.groups = () =>
    new Promise(accept => {
      resolve = accept;
    });
  await state.flush();
  state.authority.groups = async () => [];
  state.find('SegmentedControl').props.onChange('1');
  await state.flush();
  input(state, 'New wallet bundle');
  resolve(bundles);
  await state.flush();
  assert.equal(state.find('InputWithAction').props.value, 'New wallet bundle');
  assert.equal(state.find('InputWithAction').props.action, undefined);
});

for (const outcome of ['correct', 'cancel', 'blocked']) {
  test(`authority join retries rejected Secret PIN: ${outcome}, preserving choice and card`, async t => {
    const state = fixture(t, {sourceCard: prepared()});
    await state.flush();
    const session = state.flow.authority;
    let chosen;
    const card = session.cards[0];
    const hex = value => Uint8Array.from(Buffer.from(value, 'hex'));
    let authentications = 0;
    let issues = 0;
    let joins = 0;
    state.applet = {
      hello: async () => ({
        ...prepared(),
        version: 1,
        id: hex(card.id),
        publicKey: hex(card.publicKey),
        pins: {secret: 5, access: 5},
      }),
      authenticate: async () => {
        if (++authentications === 1)
          throw new CBORAppletError({
            code: 'INVALID_PIN',
            tries: outcome === 'blocked' ? 0 : 4,
          });
      },
      joinBundle: async () => {
        joins++;
        return {bundle: new Uint8Array(32).fill(42)};
      },
    };
    state.authority.issueBundle = async () => {
      issues++;
      return {
        publicKey: hex(card.publicKey),
        data: new Uint8Array(),
        bundle: new Uint8Array(32).fill(42),
      };
    };
    state.promptPIN = options => {
      chosen ??= session.choice;
      if (state.pinPrompts === 2) {
        assert.equal(options.description, 'Incorrect PIN, tries remaining: 4');
        assert.equal(state.scans, 1);
        assert.equal(issues, 0);
        if (outcome === 'cancel') return undefined;
      }
      return 'Secret-42';
    };
    await state.click('Button', 'Continue');
    assert.equal(session.choice, chosen);
    assert.equal(session.cards[0], card);
    assert.equal(session.joinedCount, outcome === 'correct' ? 1 : 0);
    assert.equal(authentications, outcome === 'correct' ? 2 : 1);
    assert.equal(joins, outcome === 'correct' ? 1 : 0);
    if (outcome === 'blocked')
      assert.equal(state.errors[0].message, 'Secret PIN blocked');
    else assert.deepEqual(state.errors, []);
  });
}
