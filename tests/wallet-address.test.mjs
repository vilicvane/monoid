import assert from 'node:assert/strict';
import {test} from 'node:test';

import {getBytes, SigningKey} from 'ethers';

import {parseDerivationPath} from '../.bld/app/@lib/bip39.js';
import {
  ADDRESS_TYPES,
  computeWalletAddress,
  getDerivationPathError,
} from '../.bld/app/@lib/wallet-address.js';

const bytes = hex => getBytes(`0x${hex}`);

// Published vectors: https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki
test('Native SegWit matches BIP84 receiving and change address vectors', () => {
  const vectors = [
    [
      '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c',
      'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    ],
    [
      '03e775fd51f0dfb8cd865d9ff1cca2a158cf651fe997fdc9fee9c1d3b5e995ea77',
      'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
    ],
    [
      '03025324888e429ab8e3dbaf1f7802648b9cd01e9b418485c5fa4c1b9b5700e1a6',
      'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
    ],
  ];

  for (const [publicKey, address] of vectors) {
    assert.equal(
      computeWalletAddress('bitcoin-segwit', bytes(publicKey)),
      address,
    );
    assert.equal(
      computeWalletAddress(
        'bitcoin-segwit',
        getBytes(SigningKey.computePublicKey(bytes(publicKey), false)),
      ),
      address,
    );
  }
});

// Published output keys: https://github.com/bitcoin/bips/blob/master/bip-0086.mediawiki
test('Taproot matches BIP86 output key vectors without a second tweak', () => {
  const vectors = [
    [
      'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c',
      'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
    ],
    [
      'a82f29944d65b86ae6b5e5cc75e294ead6c59391a1edc5e016e3498c67fc7bbb',
      'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh',
    ],
    [
      '882d74e5d0572d5a816cef0041a96b6c1de832f6f9676d9605c44d5e9a97d3dc',
      'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7',
    ],
  ];

  for (const [publicKey, address] of vectors) {
    assert.equal(
      computeWalletAddress('bitcoin-taproot', bytes(publicKey)),
      address,
    );
  }
});

test('Solana base58 preserves leading zero bytes', () => {
  assert.equal(
    computeWalletAddress('solana', new Uint8Array(32)),
    '1'.repeat(32),
  );

  const publicKey = new Uint8Array(32);
  publicKey[31] = 1;
  assert.equal(computeWalletAddress('solana', publicKey), `${'1'.repeat(31)}2`);
});

test('EVM preserves checksum addresses for compressed and uncompressed keys', () => {
  const publicKey = bytes(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  );
  const expected = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

  assert.equal(computeWalletAddress('evm', publicKey), expected);
  assert.equal(
    computeWalletAddress(
      'evm',
      getBytes(SigningKey.computePublicKey(publicKey, false)),
    ),
    expected,
  );
});

test('address encoders reject incompatible public key lengths', () => {
  for (const type of ['solana', 'bitcoin-taproot']) {
    for (const length of [0, 31, 33, 65]) {
      assert.throws(() => computeWalletAddress(type, new Uint8Array(length)));
    }
  }

  for (const type of ['evm', 'bitcoin-segwit']) {
    for (const length of [0, 31, 32, 64]) {
      assert.throws(() => computeWalletAddress(type, new Uint8Array(length)));
    }
  }
});

test('presets select their seed labels, curves and default paths', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(ADDRESS_TYPES).map(([type, options]) => [
        type,
        {...options, path: options.path(1)},
      ]),
    ),
    {
      evm: {
        chain: 'evm',
        seed: 'Bitcoin seed',
        curve: 'secp256k1',
        path: "m/44'/60'/0'/0/1",
      },
      solana: {
        chain: 'solana',
        seed: 'ed25519 seed',
        curve: 'ed25519',
        path: "m/44'/501'/1'/0'",
      },
      'bitcoin-segwit': {
        chain: 'bitcoin',
        seed: 'Bitcoin seed',
        curve: 'secp256k1',
        path: "m/84'/0'/0'/0/1",
      },
      'bitcoin-taproot': {
        chain: 'bitcoin',
        seed: 'Bitcoin seed',
        curve: 'secp256k1',
        path: "m/86'/0'/0'/0/1",
        taproot: true,
      },
    },
  );
});

test('path validation rejects malformed and overflowing indices before card encoding', () => {
  for (const type of Object.keys(ADDRESS_TYPES)) {
    for (const path of [
      '',
      'm',
      'm/',
      "m/-1'",
      "m/01'",
      "m/1.5'",
      "m/foo1'",
      "m/2147483648'",
      "m/4294967296'",
      "m/9007199254740993'",
    ]) {
      assert.ok(getDerivationPathError(type, path), `${type}: ${path}`);
    }

    assert.equal(getDerivationPathError(type, "m/2147483647'"), undefined);

    for (const index of [-1, 1.5, 2147483648, NaN, Infinity]) {
      assert.throws(() => ADDRESS_TYPES[type].path(index));
    }

    for (const index of [0, 1, 2147483647]) {
      assert.equal(
        getDerivationPathError(type, ADDRESS_TYPES[type].path(index)),
        undefined,
      );
    }
  }

  assert.deepEqual(
    [...parseDerivationPath("m/0/2147483647/2147483647'")],
    [0, 0, 0, 0, 127, 255, 255, 255, 255, 255, 255, 255],
  );
});

test('Solana requires every path component to be hardened', () => {
  for (const path of ["m/44/501'/0'/0'", "m/44'/501'/0'/0"]) {
    assert.match(getDerivationPathError('solana', path), /hardened/);
  }

  assert.equal(getDerivationPathError('solana', "m/44'/501'/1'"), undefined);
  assert.equal(getDerivationPathError('evm', "m/44'/60'/0'/0/0"), undefined);
  assert.equal(
    getDerivationPathError('bitcoin-segwit', "m/84'/0'/1'/1/2"),
    undefined,
  );
  assert.equal(
    getDerivationPathError('bitcoin-taproot', "m/86'/0'/1'/1/2"),
    undefined,
  );
});
