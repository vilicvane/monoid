import assert from 'node:assert/strict';
import {test} from 'node:test';

import {getBytes} from 'ethers';

import {
  getCardKeyAddressTypes,
  getLocalCardKeyAddress,
  readCardKeyAddress,
} from '../.bld/app/@components/views/safe/card-address.js';
import {scanCardKeys} from '../.bld/app/@components/views/safe/scan-card.js';
import {parseDerivationPath} from '../.bld/app/@lib/bip39.js';
import {CBORAppletError} from '../.bld/app/@lib/cbor-applet.js';
import {createMonoidApplet} from '../.bld/app/@lib/monoid/monoid-applet.js';
import {WalletKeyKnownType} from '../.bld/app/@services/wallet-storage-service.js';

const INDEX = '00000001';
const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const TAPROOT_KEY =
  'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c';
const EVM_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const SEGWIT_ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const TAPROOT_ADDRESS =
  'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const bytes = hex => getBytes(`0x${hex}`);

const PRESETS = [
  ['evm', 'secp256k1', "m/44'/60'/0'/0/0", PUBLIC_KEY, EVM_ADDRESS],
  ['solana', 'ed25519', "m/44'/501'/0'/0'", '00'.repeat(32), '1'.repeat(32)],
  [
    'bitcoin-segwit',
    'secp256k1',
    "m/84'/0'/0'/0/0",
    PUBLIC_KEY,
    SEGWIT_ADDRESS,
  ],
  [
    'bitcoin-taproot',
    'secp256k1',
    "m/86'/0'/0'/0/0",
    TAPROOT_KEY,
    TAPROOT_ADDRESS,
  ],
];

test('card key address choices match the key capabilities', () => {
  const all = ['evm', 'solana', 'bitcoin-segwit', 'bitcoin-taproot'];
  assert.deepEqual(getCardKeyAddressTypes('seed'), all);
  assert.deepEqual(getCardKeyAddressTypes('master'), all);
  assert.deepEqual(getCardKeyAddressTypes('secp256k1'), [
    'evm',
    'bitcoin-segwit',
    'bitcoin-taproot',
  ]);
  assert.deepEqual(getCardKeyAddressTypes('ed25519'), ['solana']);
  assert.deepEqual(getCardKeyAddressTypes('unknown'), []);
  assert.equal(WalletKeyKnownType.is('ed25519'), true);
});

for (const keyType of ['seed', 'master']) {
  test(`${keyType} addresses use their preset path and request a fresh public key`, async () => {
    for (const [addressType, curve, path, publicKey, address] of PRESETS) {
      const requests = [];
      const applet = {
        async viewKey(request) {
          requests.push(request);
          return {publicKey: bytes(publicKey)};
        },
      };
      const ref = await readCardKeyAddress(
        applet,
        {type: keyType, index: INDEX},
        addressType,
      );
      const seed = curve === 'ed25519' ? 'ed25519 seed' : 'Bitcoin seed';

      assert.deepEqual(requests, [
        {
          type: keyType,
          index: bytes(INDEX),
          derivation: {
            type: curve === 'ed25519' ? 'slip10' : 'bip32',
            ...(curve === 'ed25519' && {curve}),
            path: parseDerivationPath(path),
          },
          ...(addressType === 'bitcoin-taproot' && {taproot: true}),
        },
      ]);
      assert.deepEqual(ref, {
        addressType,
        ...(keyType === 'seed' && {seed}),
        curve,
        path,
        publicKey,
        address,
      });
    }
  });
}

test('raw keys omit all derivation options, while raw Taproot still requests a tweak', async () => {
  for (const [addressType, curve, , publicKey, address] of PRESETS) {
    const requests = [];
    const applet = {
      async viewKey(request) {
        requests.push(request);
        return {publicKey: bytes(publicKey)};
      },
    };
    const ref = await readCardKeyAddress(
      applet,
      {type: curve, index: INDEX},
      addressType,
    );

    assert.deepEqual(requests, [
      {
        type: curve,
        index: bytes(INDEX),
        ...(addressType === 'bitcoin-taproot' && {taproot: true}),
      },
    ]);
    assert.deepEqual(ref, {addressType, publicKey, address});
  }
});

test('the applet schema preserves the raw Taproot flag without curve or path', async () => {
  const applet = createMonoidApplet(new Uint8Array([1]));
  const requests = [];
  applet.sendCommand = async (...request) => {
    requests.push(request);
    return {publicKey: bytes(TAPROOT_KEY)};
  };

  await readCardKeyAddress(
    applet,
    {type: 'secp256k1', index: INDEX},
    'bitcoin-taproot',
  );

  assert.deepEqual(requests, [
    [0x40, {type: 'secp256k1', index: bytes(INDEX), taproot: true}],
  ]);
});

test('unsupported selections reject before talking to the card', async () => {
  const applet = {viewKey: () => assert.fail('Unexpected card request')};

  for (const [type, addressType] of [
    ['ed25519', 'evm'],
    ['ed25519', 'bitcoin-taproot'],
    ['secp256k1', 'solana'],
    ['unknown', 'evm'],
  ]) {
    await assert.rejects(
      readCardKeyAddress(applet, {type, index: INDEX}, addressType),
      /not supported/,
    );
  }
});

test('local conversion reuses ordinary raw public keys and never reinterprets a tweaked key', () => {
  const evm = {
    addressType: 'evm',
    publicKey: PUBLIC_KEY,
    address: EVM_ADDRESS,
  };
  const segwit = {
    ...evm,
    addressType: 'bitcoin-segwit',
    address: SEGWIT_ADDRESS,
  };
  const taproot = {
    addressType: 'bitcoin-taproot',
    publicKey: TAPROOT_KEY,
    address: TAPROOT_ADDRESS,
  };

  assert.equal(getLocalCardKeyAddress(evm, 'evm'), evm);
  assert.deepEqual(getLocalCardKeyAddress(evm, 'bitcoin-segwit'), segwit);
  assert.deepEqual(getLocalCardKeyAddress(segwit, 'evm'), evm);
  assert.equal(getLocalCardKeyAddress(taproot, 'bitcoin-taproot'), taproot);

  for (const [ref, target] of [
    [evm, 'bitcoin-taproot'],
    [evm, 'solana'],
    [taproot, 'evm'],
    [taproot, 'bitcoin-segwit'],
    [taproot, 'solana'],
    [{...evm, path: "m/44'/60'/0'/0/0"}, 'bitcoin-segwit'],
  ]) {
    assert.equal(getLocalCardKeyAddress(ref, target), undefined);
  }
});

test('initial card scanning includes raw Ed25519 and reports progress only for supported key types', async () => {
  const types = ['seed', 'master', 'secp256k1', 'ed25519', 'unknown', 123];
  const items = types.map((type, index) => ({
    type,
    index: new Uint8Array([index + 1]),
    alias: `Key ${index}`,
  }));
  const requests = [];
  const progress = [];
  const applet = {
    async list() {
      return {items};
    },
    async viewKey(request) {
      requests.push(request);
      return {
        publicKey:
          request.index[0] === 4 ? new Uint8Array(32) : bytes(PUBLIC_KEY),
      };
    },
  };

  const keys = await scanCardKeys(applet, (...value) => progress.push(value));

  assert.deepEqual(progress, [
    [0, 4],
    [1, 4],
    [2, 4],
    [3, 4],
  ]);
  assert.deepEqual(
    keys.map(key => key.type),
    types.slice(0, 4),
  );
  assert.deepEqual(
    keys.map(key => key.ref.addressType),
    ['evm', 'evm', 'evm', 'solana'],
  );
  assert.deepEqual(keys[3], {
    type: 'ed25519',
    index: '04',
    alias: 'Key 3',
    ref: {
      addressType: 'solana',
      publicKey: '00'.repeat(32),
      address: '1'.repeat(32),
    },
  });
  assert.deepEqual(requests[3], {
    type: 'ed25519',
    index: new Uint8Array([4]),
  });
});

test('initial scans skip unsupported firmware results but propagate other card errors', async () => {
  const items = ['seed', 'ed25519'].map((type, index) => ({
    type,
    index: new Uint8Array([index + 1]),
  }));
  const progress = [];
  const applet = {
    async list() {
      return {items};
    },
    async viewKey({index}) {
      if (index[0] === 1) {
        throw new CBORAppletError({code: 'UNSUPPORTED_SEED_LENGTH'});
      }
      return {publicKey: new Uint8Array(32)};
    },
  };

  const keys = await scanCardKeys(applet, (...value) => progress.push(value));
  assert.deepEqual(
    keys.map(key => key.type),
    ['ed25519'],
  );
  assert.deepEqual(progress, [
    [0, 2],
    [1, 2],
  ]);

  const failure = new CBORAppletError({code: 'NOT_FOUND'});
  applet.viewKey = async () => {
    throw failure;
  };
  await assert.rejects(
    scanCardKeys(applet, () => {}),
    error => error === failure,
  );
  await assert.rejects(
    readCardKeyAddress(applet, {type: 'seed', index: INDEX}, 'evm'),
    error => error === failure,
  );
});
