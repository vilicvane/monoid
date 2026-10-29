import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

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
mock.module('../.bld/app/@lib/wallet-address.js', {
  namedExports: {
    ADDRESS_TYPES: {ethereum: {chain: 'ethereum'}},
    ADDRESS_TYPE_LABELS: {ethereum: 'Ethereum'},
  },
});
mock.module('../.bld/app/@services/index.js', {
  namedExports: {
    getKeyWallets: key => key.wallets,
    getDefaultWallet: (_key, wallets) => wallets[0],
  },
});
for (const [path, namedExports] of [
  ['@ui/list', {ListItemButton: 'button'}],
  ['@ui/ripple-effect', {RippleEffect: 'ripple'}],
  [
    '@key/key-list',
    {
      KeyListAddress: 'address',
      KeyListItemContent: 'content',
      KeyListPlaceholder: 'placeholder',
    },
  ],
  ['@key/key-public-key-item', {KeyPublicKeyTags: 'public-key-tags'}],
  [
    '@key/key-tags',
    {
      KeyAliasTag: 'alias',
      KeyDerivationBadge: 'badge',
      KeyDerivationTag: 'derivation',
      KeyTags: 'tags',
      KeyTypeTag: 'type',
    },
  ],
])
  mock.module(`../.bld/app/@components/${path}.js`, {namedExports});

const {KeyItem} = await import(
  '../.bld/app/@components/views/safe/@safe/@key-item.js'
);

function all(node, type) {
  if (Array.isArray(node)) return node.flatMap(child => all(child, type));
  if (!node || typeof node !== 'object') return [];
  return [
    ...(node.type === type ? [node] : []),
    ...all(node.props?.children, type),
  ];
}

const wallet = {
  addressType: 'ethereum',
  path: "m/44'/60'/0'/0/0",
  address: '0xabc',
};
const derivedKey = {
  derivation: {type: 'monoid-001', curve: 'secp256r1', context: 'ssh'},
  publicKey: '04abcd',
};

function render(data) {
  return KeyItem({
    data: {type: 'seed', index: '0240', alias: 'monoid', ...data},
    onClick() {},
  });
}

test('the badge counts derived wallets and keys together', () => {
  const tree = render({wallets: [wallet], derivedKeys: [derivedKey]});
  assert.deepEqual(
    all(tree, 'badge').map(badge => badge.props.children),
    [2],
  );
  assert.equal(all(tree, 'derivation').length, 1);
  assert.equal(all(tree, 'public-key-tags').length, 0);
  assert.equal(all(tree, 'address')[0].props.children, '0xabc');
});

test('a seed with only derived keys shows its first key and the total', () => {
  const tree = render({
    wallets: [],
    derivedKeys: [derivedKey, {...derivedKey, publicKey: '04ef'}],
  });
  const [tags] = all(tree, 'public-key-tags');
  assert.deepEqual(tags.props, {curve: 'secp256r1', context: 'ssh'});
  assert.equal(all(tree, 'address')[0].props.children, '04abcd');
  assert.deepEqual(
    all(tree, 'badge').map(badge => badge.props.children),
    [2],
  );
  assert.equal(all(tree, 'placeholder').length, 0);
});

test('a single derived item has no badge and an empty seed says so', () => {
  assert.equal(
    all(render({wallets: [], derivedKeys: [derivedKey]}), 'badge').length,
    0,
  );
  assert.equal(all(render({wallets: [wallet]}), 'badge').length, 0);
  const [placeholder] = all(render({wallets: []}), 'placeholder');
  assert.equal(placeholder.props.children, 'No derived wallets or keys');
});
