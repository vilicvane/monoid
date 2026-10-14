import assert from 'node:assert/strict';
import {test} from 'node:test';

import {runInAction, toJS} from 'mobx';

const {getDefaultWallet, WalletStorageService} = await import(
  '../.bld/app/@services/wallet-storage-service.js'
);

const KEY_INDEX = '00000001';
const LEGACY_WALLET = {
  seed: 'Bitcoin seed',
  curve: 'secp256k1',
  path: "m/44'/60'/0'/0/0",
  address: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
};
const SOLANA_WALLET = {
  addressType: 'solana',
  seed: 'ed25519 seed',
  curve: 'ed25519',
  path: "m/44'/501'/0'/0'",
  address: '11111111111111111111111111111111',
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

test('keys without a selected default use their first wallet without writing a migration', async () => {
  const keys = [
    createKey([{...LEGACY_WALLET, addressType: 'evm'}, SOLANA_WALLET]),
  ];
  const storage = createStorage(keys);
  const service = await WalletStorageService.create(storage);
  const key = service.keys[0];

  assert.equal(getDefaultWallet(key), key.wallets[0]);
  assert.deepEqual(toJS(service.keys), keys);
  assert.deepEqual(storage.writes, []);
});

test('selecting a default persists and reloads it without reordering wallets', async context => {
  context.mock.method(console, 'info', () => {});

  const wallets = [{...LEGACY_WALLET, addressType: 'evm'}, SOLANA_WALLET];
  const storage = createStorage([createKey(wallets)]);
  const service = await WalletStorageService.create(storage);
  const key = service.keys[0];
  const defaultWallet = {
    addressType: SOLANA_WALLET.addressType,
    address: SOLANA_WALLET.address,
  };

  runInAction(() => {
    key.defaultWallet = defaultWallet;
  });

  const expected = [{...createKey(wallets), defaultWallet}];
  assert.equal(getDefaultWallet(key), key.wallets[1]);
  assert.deepEqual(toJS(key.wallets), wallets);
  assert.deepEqual(storage.writes, [['walletKeys', expected]]);

  const reloaded = await WalletStorageService.create(storage);

  assert.deepEqual(toJS(reloaded.keys), expected);
  assert.equal(getDefaultWallet(reloaded.keys[0]), reloaded.keys[0].wallets[1]);
  assert.equal(storage.writes.length, 1);
});

test('appending a wallet retains the selected default after saving and reloading', async context => {
  context.mock.method(console, 'info', () => {});

  const wallets = [{...LEGACY_WALLET, addressType: 'evm'}, SOLANA_WALLET];
  const defaultWallet = {
    addressType: SOLANA_WALLET.addressType,
    address: SOLANA_WALLET.address,
  };
  const storage = createStorage([{...createKey(wallets), defaultWallet}]);
  const service = await WalletStorageService.create(storage);
  const addedWallet = {
    ...LEGACY_WALLET,
    addressType: 'bitcoin-segwit',
    path: "m/84'/0'/0'/0/0",
    address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  };

  runInAction(() => {
    service.keys[0].wallets.push(addedWallet);
  });

  const reloaded = await WalletStorageService.create(storage);
  const key = reloaded.keys[0];

  assert.deepEqual(toJS(key.wallets), [...wallets, addedWallet]);
  assert.deepEqual(toJS(key.defaultWallet), defaultWallet);
  assert.equal(getDefaultWallet(key), key.wallets[1]);
});

test('default identity matches both address type and address', () => {
  const matchingWallet = {...SOLANA_WALLET, address: LEGACY_WALLET.address};
  const key = {
    ...createKey([
      {...LEGACY_WALLET, addressType: 'evm'},
      SOLANA_WALLET,
      matchingWallet,
    ]),
    defaultWallet: {
      addressType: matchingWallet.addressType,
      address: matchingWallet.address,
    },
  };

  assert.equal(getDefaultWallet(key), matchingWallet);
});

test('missing default references fall back to the first wallet and empty keys have no default', () => {
  const wallet = {...LEGACY_WALLET, addressType: 'evm'};
  const missingDefault = {
    addressType: SOLANA_WALLET.addressType,
    address: SOLANA_WALLET.address,
  };

  assert.equal(
    getDefaultWallet({...createKey([wallet]), defaultWallet: missingDefault}),
    wallet,
  );
  assert.equal(getDefaultWallet(createKey([])), undefined);
  assert.equal(
    getDefaultWallet({...createKey([]), defaultWallet: missingDefault}),
    undefined,
  );
});

test('deleting a non-default wallet preserves the selected default and remaining wallet order', async context => {
  context.mock.method(console, 'info', () => {});

  const firstWallet = {...LEGACY_WALLET, addressType: 'evm'};
  const selectedWallet = {
    ...SOLANA_WALLET,
    path: "m/44'/501'/1'/0'",
    address: `${'1'.repeat(31)}2`,
  };
  const defaultWallet = {
    addressType: selectedWallet.addressType,
    address: selectedWallet.address,
  };
  const storage = createStorage([
    {
      ...createKey([firstWallet, SOLANA_WALLET, selectedWallet]),
      defaultWallet,
    },
  ]);
  const service = await WalletStorageService.create(storage);

  service.deleteWallet(KEY_INDEX, {
    addressType: SOLANA_WALLET.addressType,
    address: SOLANA_WALLET.address,
  });

  const expected = [
    {...createKey([firstWallet, selectedWallet]), defaultWallet},
  ];
  assert.deepEqual(toJS(service.keys), expected);
  assert.equal(getDefaultWallet(service.keys[0]), service.keys[0].wallets[1]);
  assert.deepEqual(storage.writes, [['walletKeys', expected]]);
});

for (const explicitDefault of [false, true]) {
  test(`deleting the ${explicitDefault ? 'explicit' : 'implicit'} default falls back to the first remaining wallet`, async context => {
    context.mock.method(console, 'info', () => {});

    const firstWallet = {...LEGACY_WALLET, addressType: 'evm'};
    const target = explicitDefault ? SOLANA_WALLET : firstWallet;
    const identity = {
      addressType: target.addressType,
      address: target.address,
    };
    const storage = createStorage([
      {
        ...createKey([firstWallet, SOLANA_WALLET]),
        ...(explicitDefault && {defaultWallet: identity}),
      },
    ]);
    const service = await WalletStorageService.create(storage);

    service.deleteWallet(KEY_INDEX, identity);

    const expected = [
      createKey([explicitDefault ? firstWallet : SOLANA_WALLET]),
    ];
    assert.deepEqual(toJS(service.keys), expected);
    assert.equal(Object.hasOwn(service.keys[0], 'defaultWallet'), false);
    assert.equal(getDefaultWallet(service.keys[0]), service.keys[0].wallets[0]);
    assert.deepEqual(storage.writes, [['walletKeys', expected]]);
  });
}

test('deleting the final wallet retains its parent key and allows derivation after reloading', async context => {
  context.mock.method(console, 'info', () => {});

  const wallet = {...LEGACY_WALLET, addressType: 'evm'};
  const identity = {addressType: wallet.addressType, address: wallet.address};
  const otherKey = {
    ...createKey([SOLANA_WALLET]),
    index: '00000002',
    alias: 'Other key',
  };
  const storage = createStorage([
    {...createKey([wallet]), defaultWallet: identity},
    otherKey,
  ]);
  const service = await WalletStorageService.create(storage);
  const parentKey = service.indexToKeyMap.get(KEY_INDEX);

  service.deleteWallet(KEY_INDEX, identity);

  const expected = [createKey([]), otherKey];
  assert.equal(service.indexToKeyMap.get(KEY_INDEX), parentKey);
  assert.deepEqual(toJS(service.keys), expected);
  assert.deepEqual(storage.writes, [['walletKeys', expected]]);

  const reloaded = await WalletStorageService.create(storage);

  assert.deepEqual(toJS(reloaded.keys), expected);
  assert.equal(getDefaultWallet(reloaded.keys[0]), undefined);
  assert.equal(
    reloaded.suggestNextDerivationPath(KEY_INDEX, 'evm'),
    "m/44'/60'/0'/0/0",
  );
  assert.equal(storage.writes.length, 1);
});

test('deletion distinguishes address types when address strings are identical', async context => {
  context.mock.method(console, 'info', () => {});

  const selectedWallet = {...LEGACY_WALLET, addressType: 'evm'};
  const target = {...SOLANA_WALLET, address: selectedWallet.address};
  const defaultWallet = {
    addressType: selectedWallet.addressType,
    address: selectedWallet.address,
  };
  const storage = createStorage([
    {
      ...createKey([selectedWallet, target, SOLANA_WALLET]),
      defaultWallet,
    },
  ]);
  const service = await WalletStorageService.create(storage);

  service.deleteWallet(KEY_INDEX, {
    addressType: target.addressType,
    address: target.address,
  });

  const expected = [
    {...createKey([selectedWallet, SOLANA_WALLET]), defaultWallet},
  ];
  assert.deepEqual(toJS(service.keys), expected);
  assert.equal(getDefaultWallet(service.keys[0]), service.keys[0].wallets[0]);
  assert.deepEqual(storage.writes, [['walletKeys', expected]]);
});

test('deleting an unknown key or wallet does not change or persist stored data', async () => {
  const wallet = {...LEGACY_WALLET, addressType: 'evm'};
  const identity = {addressType: wallet.addressType, address: wallet.address};
  const keys = [{...createKey([wallet]), defaultWallet: identity}];
  const storage = createStorage(keys);
  const service = await WalletStorageService.create(storage);

  service.deleteWallet('ffffffff', identity);
  service.deleteWallet(KEY_INDEX, {...identity, address: 'missing-address'});
  service.deleteWallet(KEY_INDEX, {...identity, addressType: 'solana'});

  assert.deepEqual(toJS(service.keys), keys);
  assert.deepEqual(storage.values.get('walletKeys'), keys);
  assert.deepEqual(storage.writes, []);
});
