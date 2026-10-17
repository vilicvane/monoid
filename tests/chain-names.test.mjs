import assert from 'node:assert/strict';
import {test} from 'node:test';

const {
  BUILTIN_CHAIN_CURRENCIES,
  BUILTIN_CHAIN_ICONS,
  BUILTIN_CHAIN_NAMES,
  parseChainDirectory,
} = await import('../.bld/app/@lib/chain-names.js');

test('projects directory names and icons into EIP-155 keys without retaining RPC or title metadata', () => {
  const directory = [
    {
      chainId: 1,
      name: 'Ethereum Mainnet',
      chainSlug: 'ethereum',
      nativeCurrency: {name: 'Ether', symbol: ' ETH ', decimals: 18},
      rpc: ['https://example.test'],
    },
    {chainId: 59144, name: 'Linea', title: 'Linea Mainnet'},
    {chainId: 999, name: ' HyperEVM '},
  ];
  const original = structuredClone(directory);

  assert.deepEqual(parseChainDirectory(directory), {
    names: {
      'eip155:1': 'Ethereum Mainnet',
      'eip155:59144': 'Linea',
      'eip155:999': 'HyperEVM',
    },
    icons: {
      'eip155:1': 'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg',
    },
    currencies: {'eip155:1': {symbol: 'ETH', decimals: 18}},
  });
  assert.deepEqual(directory, original);
});

test('does not confuse chain IDs from other namespaces or coercible values with EIP-155 IDs', () => {
  for (const chainId of [
    '1',
    '0x1',
    'eip155:1',
    'solana:1',
    'bip122:1',
    undefined,
    null,
    true,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => parseChainDirectory([{chainId, name: 'Network'}]),
      /Invalid chain directory entry/,
    );
  }

  assert.deepEqual(
    parseChainDirectory([{chainId: Number.MAX_SAFE_INTEGER, name: 'Large ID'}]),
    {names: {'eip155:9007199254740991': 'Large ID'}, icons: {}, currencies: {}},
  );
});

test('rejects malformed or empty directories instead of replacing a usable cache', () => {
  for (const value of [undefined, null, {}, [], '[]', {chains: []}]) {
    assert.throws(() => parseChainDirectory(value), /Invalid chain directory/);
  }

  for (const entry of [
    undefined,
    null,
    [],
    'Network',
    {},
    {chainId: 1},
    {chainId: 1, title: 'Title only'},
    {chainId: 1, name: undefined},
    {chainId: 1, name: null},
    {chainId: 1, name: 1},
    {chainId: 1, name: ''},
    {chainId: 1, name: ' \t\n '},
  ]) {
    assert.throws(
      () => parseChainDirectory([{chainId: 999, name: 'HyperEVM'}, entry]),
      /Invalid chain directory entry/,
    );
  }
});

test('rejects duplicate IDs even when the names agree', () => {
  for (const name of ['Ethereum Mainnet', 'Conflicting network']) {
    assert.throws(
      () =>
        parseChainDirectory([
          {chainId: 1, name: 'Ethereum Mainnet'},
          {chainId: 1, name},
        ]),
      /Duplicate chain directory entry/,
    );
  }
});

test('optional icon slugs do not block names and are encoded within the official icon URL', () => {
  for (const chainSlug of [undefined, null, 1, {}, '', ' \t ']) {
    assert.deepEqual(
      parseChainDirectory([{chainId: 10, name: 'OP Mainnet', chainSlug}]),
      {names: {'eip155:10': 'OP Mainnet'}, icons: {}, currencies: {}},
    );
  }

  assert.equal(
    parseChainDirectory([
      {chainId: 123456789, name: 'Example', chainSlug: ' example/name?large '},
    ]).icons['eip155:123456789'],
    'https://icons.llamao.fi/icons/chains/rsz_example%2Fname%3Flarge.jpg',
  );
});

test('currency formatting requires a symbol and a supported integer precision', () => {
  for (const nativeCurrency of [
    undefined,
    null,
    'ETH',
    {},
    {symbol: '', decimals: 18},
    {symbol: ' \t ', decimals: 18},
    {symbol: 1, decimals: 18},
    {symbol: 'ETH'},
    {symbol: 'ETH', decimals: '18'},
    {symbol: 'ETH', decimals: -1},
    {symbol: 'ETH', decimals: 1.5},
    {symbol: 'ETH', decimals: 81},
    {symbol: 'ETH', decimals: NaN},
    {symbol: 'ETH', decimals: Infinity},
  ]) {
    const directory = parseChainDirectory([
      {chainId: 987654321, name: 'Example', nativeCurrency},
    ]);
    assert.deepEqual(directory.currencies, {});
    assert.equal(directory.names['eip155:987654321'], 'Example');
  }

  for (const decimals of [0, 6, 18, 80]) {
    assert.deepEqual(
      parseChainDirectory([
        {
          chainId: 987654321,
          name: 'Example',
          nativeCurrency: {name: 'Example coin', symbol: ' COIN ', decimals},
        },
      ]).currencies,
      {'eip155:987654321': {symbol: 'COIN', decimals}},
    );
  }
});

test('offline names identify HyperEVM correctly and stay scoped to EIP-155', () => {
  assert.equal(BUILTIN_CHAIN_NAMES['eip155:999'], 'HyperEVM');
  assert.equal(BUILTIN_CHAIN_NAMES['eip155:1'], 'Ethereum Mainnet');
  assert.equal(BUILTIN_CHAIN_NAMES['eip155:11155111'], 'Ethereum Sepolia');
  assert.equal(BUILTIN_CHAIN_NAMES['solana:1'], undefined);
  assert.equal(BUILTIN_CHAIN_NAMES['bip122:1'], undefined);
  assert.equal(BUILTIN_CHAIN_NAMES['eip155:123456789'], undefined);
  assert.equal(
    BUILTIN_CHAIN_ICONS['eip155:999'],
    'https://icons.llamao.fi/icons/chains/rsz_hyperliquid.jpg',
  );
  assert.equal(BUILTIN_CHAIN_ICONS['eip155:123456789'], undefined);
  assert.deepEqual(BUILTIN_CHAIN_CURRENCIES['eip155:1'], {
    symbol: 'ETH',
    decimals: 18,
  });
  assert.deepEqual(BUILTIN_CHAIN_CURRENCIES['eip155:56'], {
    symbol: 'BNB',
    decimals: 18,
  });
  assert.deepEqual(BUILTIN_CHAIN_CURRENCIES['eip155:137'], {
    symbol: 'POL',
    decimals: 18,
  });
  assert.equal(BUILTIN_CHAIN_CURRENCIES['eip155:123456789'], undefined);
});
