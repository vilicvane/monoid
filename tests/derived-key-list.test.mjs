import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

let state;
mock.module('react', {
  namedExports: {
    useContext: () => ({view: state.view}),
    useRef: value => ({current: value}),
    useState(initial) {
      const index = state.cursor++;
      if (!(index in state.hooks)) state.hooks[index] = initial;
      return [
        state.hooks[index],
        value => {
          state.hooks[index] =
            typeof value === 'function' ? value(state.hooks[index]) : value;
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
mock.module('routra-react', {namedExports: {RouteContext: {}}});
mock.module('mobx-react-lite', {
  namedExports: {observer: component => component},
});
mock.module('@ionic/react', {
  namedExports: {
    useIonAlert: () => [async options => (state.alert = options)],
  },
});
mock.module('@capacitor/clipboard', {
  namedExports: {
    Clipboard: {write: async value => state.copied.push(value.string)},
  },
});
mock.module('lucide-react', {
  namedExports: {Copy: 'copy-icon', Trash2: 'delete-icon'},
});
mock.module('../.bld/app/@entrances.js', {
  namedExports: {
    useEntrances: () => ({errorService: {catch: value => value}}),
  },
});
for (const [path, namedExports] of [
  ['@ui/app-icon', {AppIcon: 'icon'}],
  ['@ui/copy-button', {CopyButton: 'copy-button'}],
  ['@ui/interactive-address', {InteractiveAddress: 'interactive-address'}],
  [
    '@ui/swipeable-item',
    {
      SwipeableItem: 'swipe-row',
      SwipeAction: 'action',
      SwipeActionIcon: 'icon',
    },
  ],
  [
    '@key/key-list',
    {
      KeyList: 'list',
      KeyListAddress: 'public-key',
      KeyListItem: 'item',
      KeyListItemContent: 'content',
      KeyListPlaceholder: 'placeholder',
    },
  ],
  [
    '@key/key-tags',
    {KeyParameterTag: 'parameter', KeyTags: 'tags', KeyTypeTag: 'curve'},
  ],
])
  mock.module(`../.bld/app/@components/${path}.js`, {namedExports});

const {DerivedKeyList} = await import(
  '../.bld/app/@components/@key/derived-key-list.js'
);

function all(node, type) {
  if (Array.isArray(node)) return node.flatMap(child => all(child, type));
  if (!node || typeof node !== 'object') return [];
  if (typeof node.type === 'function') return all(node.type(node.props), type);
  return [
    ...(node.type === type ? [node] : []),
    ...all(node.props?.children, type),
    ...all(node.props?.actions, type),
  ];
}

function mount(keys, onDelete) {
  state = {
    hooks: [],
    cursor: 0,
    copied: [],
    view: {$leaving: false, $match: {$exact: {$active: true}}},
    render() {
      this.cursor = 0;
      return DerivedKeyList({keys, onDelete});
    },
  };
  return state;
}

const publicKey = '11'.repeat(32);
const contextKey = {
  derivation: {
    type: 'monoid-001',
    curve: 'ed25519',
    context: '  identity:密钥  ',
  },
  publicKey,
};

test('both curves expose their public key and only display nonempty contexts', () => {
  for (const curve of ['ed25519', 'secp256r1']) {
    for (const context of ['', '  app / 密钥  ', '\ufeffcontext', "m/0'/7'"]) {
      const key = {
        derivation: {type: 'monoid-001', curve, context},
        publicKey: curve === 'ed25519' ? publicKey : `04${'22'.repeat(64)}`,
      };
      const tree = mount([key]).render();
      assert.equal(all(tree, 'curve')[0].props.children, curve);
      const tags = all(tree, 'parameter');
      assert.equal(tags.length, context ? 1 : 0);
      if (context) assert.equal(tags[0].props.children, context);
      assert.equal(all(tree, 'copy-button').length, 0);
      const address = all(tree, 'public-key')[0];
      assert.equal(address.props.children, key.publicKey);
      assert.equal(address.props.copyLabel, 'Copy public key');
      assert.equal(address.props.copyable, true);
      assert.equal(all(tree, 'action').length, 0);
    }
  }
});

test('swipe Copy writes the actual public key and Delete requires confirmation and persisted completion', async () => {
  let finish;
  const persisted = new Promise(resolve => (finish = resolve));
  const removed = [];
  const fixture = mount([contextKey], async key => {
    removed.push(key);
    await persisted;
  });
  let tree = fixture.render();
  assert.equal(all(tree, 'public-key')[0].props.copyable, false);
  const actions = all(tree, 'action');
  await actions[0].props.onClick();
  assert.deepEqual(fixture.copied, [publicKey]);
  all(tree, 'swipe-row')[0].props.onOpenChange(true);
  tree = fixture.render();
  assert.equal(all(tree, 'swipe-row')[0].props.open, true);
  await actions[1].props.onClick({currentTarget: {closest: () => undefined}});
  assert.deepEqual(removed, []);
  assert.match(fixture.alert.message, /from this device/);
  assert.equal(fixture.alert.buttons[0].role, 'cancel');
  const pending = fixture.alert.buttons[1].handler();
  assert.deepEqual(removed, [contextKey]);
  assert.equal(all(fixture.render(), 'swipe-row')[0].props.open, true);
  finish();
  await pending;
  assert.equal(all(fixture.render(), 'swipe-row')[0].props.open, false);
});

test('a pending deletion confirmation cannot delete after the Seed view leaves', async () => {
  const removed = [];
  const fixture = mount([contextKey], async key => removed.push(key));
  await all(fixture.render(), 'action')[1].props.onClick({
    currentTarget: {closest: () => undefined},
  });
  fixture.view.$leaving = true;
  await fixture.alert.buttons[1].handler();
  assert.deepEqual(removed, []);
  assert.ok(all(fixture.render(), 'action').every(node => node.props.disabled));
});

test('a failed local deletion does not close the row or report success', async () => {
  const fixture = mount([contextKey], async () => {
    throw new Error('Storage unavailable');
  });
  all(fixture.render(), 'swipe-row')[0].props.onOpenChange(true);
  await all(fixture.render(), 'action')[1].props.onClick({
    currentTarget: {closest: () => undefined},
  });
  await assert.rejects(
    fixture.alert.buttons[1].handler(),
    /Storage unavailable/,
  );
  assert.equal(all(fixture.render(), 'swipe-row')[0].props.open, true);
});
