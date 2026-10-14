import assert from 'node:assert/strict';
import {test} from 'node:test';

import {runInAction, toJS} from 'mobx';

const {WalletStorageService} = await import(
  '../.bld/app/@services/wallet-storage-service.js'
);

const KEY_INDEX = '00000001';
const LEGACY_WALLET = {
  seed: 'Bitcoin seed',
  curve: 'secp256k1',
  path: "m/44'/60'/0'/0/0",
  address: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
};

function createStorage(walletKeys) {
  const values = new Map([['walletKeys', structuredClone(walletKeys)]]);

  return {
    values,
    writes: [],
    async get(key) {
      return structuredClone(values.get(key));
    },
    async set(key, value) {
      const snapshot = structuredClone(value);
      this.writes.push([key, snapshot]);
      values.set(key, snapshot);
    },
  };
}

function createKey(wallets) {
  return {type: 'seed', index: KEY_INDEX, alias: 'Test key', wallets};
}

test('loading legacy EVM wallets adds their address type without losing key or wallet data', async () => {
  const rawWallet = {
    seed: undefined,
    curve: undefined,
    path: undefined,
    address: '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF',
  };
  const keys = [createKey([LEGACY_WALLET, rawWallet])];
  const storage = createStorage(keys);

  const service = await WalletStorageService.create(storage);

  assert.deepEqual(toJS(service.keys), [
    {
      ...keys[0],
      wallets: [
        {...LEGACY_WALLET, addressType: 'evm'},
        {...rawWallet, addressType: 'evm'},
      ],
    },
  ]);
});

test('appended Solana and Bitcoin wallets retain their types and derivation metadata after saving and reloading', async context => {
  context.mock.method(console, 'info', () => {});

  const existingWallet = {...LEGACY_WALLET, addressType: 'evm'};
  const storage = createStorage([createKey([existingWallet])]);
  const service = await WalletStorageService.create(storage);
  const addedWallets = [
    {
      addressType: 'solana',
      seed: 'ed25519 seed',
      curve: 'ed25519',
      path: "m/44'/501'/0'/0'",
      address: '11111111111111111111111111111111',
    },
    {
      addressType: 'bitcoin-segwit',
      seed: 'Bitcoin seed',
      curve: 'secp256k1',
      path: "m/84'/0'/0'/0/0",
      address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    },
    {
      addressType: 'bitcoin-taproot',
      seed: 'Bitcoin seed',
      curve: 'secp256k1',
      path: "m/86'/0'/0'/0/0",
      address: 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
    },
  ];

  runInAction(() => {
    service.keys[0].wallets.push(...addedWallets);
  });

  const expected = [createKey([existingWallet, ...addedWallets])];
  assert.deepEqual(storage.values.get('walletKeys'), expected);

  const reloaded = await WalletStorageService.create(storage);
  assert.deepEqual(toJS(reloaded.keys), expected);
});

test('derivation suggestions advance each address type independently without changing saved wallets', async () => {
  const paths = [
    ['evm', "m/44'/60'/0'/0/0"],
    ['evm', "m/44'/60'/0'/0/2"],
    ['solana', "m/44'/501'/0'/0'"],
    ['solana', "m/44'/501'/1'/0'"],
    ['bitcoin-segwit', "m/84'/0'/0'/0/0"],
    ['bitcoin-taproot', "m/86'/0'/0'/0/0"],
    // Custom paths on other address types must not occupy these suggestions.
    ['bitcoin-segwit', "m/44'/60'/0'/0/1"],
    ['evm', "m/44'/501'/2'/0'"],
    ['bitcoin-taproot', "m/84'/0'/0'/0/1"],
    ['evm', "m/86'/0'/0'/0/1"],
  ];
  const keys = [
    createKey(
      paths.map(([addressType, path]) => ({
        ...LEGACY_WALLET,
        addressType,
        seed: addressType === 'solana' ? 'ed25519 seed' : 'Bitcoin seed',
        curve: addressType === 'solana' ? 'ed25519' : 'secp256k1',
        path,
      })),
    ),
  ];
  const storage = createStorage(keys);
  const service = await WalletStorageService.create(storage);

  for (const [addressType, expected] of [
    ['evm', "m/44'/60'/0'/0/1"],
    ['solana', "m/44'/501'/2'/0'"],
    ['bitcoin-segwit', "m/84'/0'/0'/0/1"],
    ['bitcoin-taproot', "m/86'/0'/0'/0/1"],
  ]) {
    assert.equal(
      service.suggestNextDerivationPath(KEY_INDEX, addressType),
      expected,
      addressType,
    );
  }

  assert.deepEqual(toJS(service.keys), keys);
  assert.deepEqual(storage.values.get('walletKeys'), keys);
  assert.deepEqual(storage.writes, []);
});
