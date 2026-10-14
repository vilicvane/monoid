import assert from 'node:assert/strict';
import {test} from 'node:test';

import {runInAction, toJS} from 'mobx';

import {
  getDefaultWallet,
  getKeyWallets,
  getWalletData,
  getWalletReference,
  WalletStorageService,
} from '../.bld/app/@services/wallet-storage-service.js';

const KEY_INDEX = '00000001';
const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const TAPROOT_PUBLIC_KEY =
  'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c';
const EVM_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const SOLANA_ADDRESS = '1'.repeat(32);
const EVM_SOURCE = {
  addressType: 'evm',
  seed: 'Bitcoin seed',
  curve: 'secp256k1',
  path: "m/44'/60'/0'/0/0",
  publicKey: PUBLIC_KEY,
};
const SOLANA_SOURCE = {
  addressType: 'solana',
  seed: 'ed25519 seed',
  curve: 'ed25519',
  path: "m/44'/501'/0'/0'",
  publicKey: '00'.repeat(32),
};
const SEGWIT_SOURCE = {
  addressType: 'bitcoin-segwit',
  seed: 'Bitcoin seed',
  curve: 'secp256k1',
  path: "m/84'/0'/0'/0/0",
  publicKey: PUBLIC_KEY,
};
const TAPROOT_SOURCE = {
  addressType: 'bitcoin-taproot',
  seed: 'Bitcoin seed',
  curve: 'secp256k1',
  path: "m/86'/0'/0'/0/0",
  publicKey: TAPROOT_PUBLIC_KEY,
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

test('loading public key sources computes address views without modifying or writing stored data', async () => {
  const sources = [EVM_SOURCE, SOLANA_SOURCE, SEGWIT_SOURCE, TAPROOT_SOURCE];
  const keys = [createKey(sources)];
  const storage = createStorage(keys);
  const service = await WalletStorageService.create(storage);

  assert.deepEqual(toJS(service.keys), keys);
  assert.deepEqual(
    getKeyWallets(service.keys[0]).map(wallet => wallet.address),
    [
      EVM_ADDRESS,
      SOLANA_ADDRESS,
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
    ],
  );
  assert.deepEqual(storage.values.get('walletKeys'), keys);
  assert.deepEqual(storage.writes, []);
});

test('an empty store starts without keys or writes', async () => {
  const storage = createStorage(undefined);
  const service = await WalletStorageService.create(storage);

  assert.deepEqual(toJS(service.keys), []);
  assert.deepEqual(storage.writes, []);
});

test('wallet references retain only the address type and derivation parameters', () => {
  const expected = {
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: "m/44'/60'/0'/0/0",
  };

  assert.deepEqual(getWalletReference(EVM_SOURCE), expected);
  assert.deepEqual(getWalletReference(getWalletData(EVM_SOURCE)), expected);
});

test('keys without a selected default use the first address view without writing', async () => {
  const keys = [createKey([EVM_SOURCE, SOLANA_SOURCE])];
  const storage = createStorage(keys);
  const service = await WalletStorageService.create(storage);
  const key = service.keys[0];
  const wallets = getKeyWallets(key);

  assert.equal(getDefaultWallet(key, wallets), wallets[0]);
  assert.equal(getDefaultWallet(key).address, EVM_ADDRESS);
  assert.deepEqual(toJS(service.keys), keys);
  assert.deepEqual(storage.writes, []);
});

test('selecting a default persists its parameter reference without reordering public key sources', async context => {
  context.mock.method(console, 'info', () => {});

  const sources = [EVM_SOURCE, SOLANA_SOURCE];
  const storage = createStorage([createKey(sources)]);
  const service = await WalletStorageService.create(storage);
  const key = service.keys[0];
  const wallets = getKeyWallets(key);
  const reference = getWalletReference(wallets[1]);

  runInAction(() => {
    key.defaultWallet = reference;
  });

  assert.equal(getDefaultWallet(key, wallets), wallets[1]);
  assert.equal(Object.hasOwn(key.defaultWallet, 'address'), false);
  assert.deepEqual(toJS(key.wallets), sources);
  assert.deepEqual(storage.writes, [
    ['walletKeys', [{...createKey(sources), defaultWallet: reference}]],
  ]);

  const reloaded = await WalletStorageService.create(storage);

  assert.deepEqual(toJS(reloaded.keys), toJS(service.keys));
  assert.equal(getDefaultWallet(reloaded.keys[0]).address, SOLANA_ADDRESS);
});

test('default references distinguish derivation parameters even when addresses match', () => {
  const second = {...EVM_SOURCE, path: "m/44'/60'/0'/0/1"};
  const key = {
    ...createKey([EVM_SOURCE, second]),
    defaultWallet: getWalletReference(second),
  };
  const wallets = getKeyWallets(key);

  assert.equal(wallets[0].address, wallets[1].address);
  assert.equal(getDefaultWallet(key, wallets), wallets[1]);
});

test('missing default references fall back to the first view and empty keys have no default', () => {
  const reference = getWalletReference(SOLANA_SOURCE);
  const key = {...createKey([EVM_SOURCE]), defaultWallet: reference};
  const wallets = getKeyWallets(key);

  assert.equal(getDefaultWallet(key, wallets), wallets[0]);
  assert.equal(getDefaultWallet(createKey([])), undefined);
  assert.equal(
    getDefaultWallet({...createKey([]), defaultWallet: reference}),
    undefined,
  );
});

test('adding derived sources preserves them and the chosen default after reload', async context => {
  context.mock.method(console, 'info', () => {});

  const reference = getWalletReference(EVM_SOURCE);
  const storage = createStorage([
    {...createKey([EVM_SOURCE]), defaultWallet: reference},
  ]);
  const service = await WalletStorageService.create(storage);

  service.addWallet(KEY_INDEX, SOLANA_SOURCE);
  service.addWallet(KEY_INDEX, SEGWIT_SOURCE);

  const reloaded = await WalletStorageService.create(storage);

  assert.deepEqual(toJS(reloaded.keys[0].wallets), [
    EVM_SOURCE,
    SOLANA_SOURCE,
    SEGWIT_SOURCE,
  ]);
  assert.deepEqual(toJS(reloaded.keys[0].defaultWallet), reference);
  assert.equal(getDefaultWallet(reloaded.keys[0]).address, EVM_ADDRESS);
  assert.equal(
    reloaded.keys[0].wallets.every(source => !Object.hasOwn(source, 'address')),
    true,
  );
});

test('updating a public key replaces only the source with the same parameters and preserves the default', async context => {
  context.mock.method(console, 'info', () => {});

  const reference = getWalletReference(EVM_SOURCE);
  const storage = createStorage([
    {...createKey([SOLANA_SOURCE, EVM_SOURCE]), defaultWallet: reference},
  ]);
  const service = await WalletStorageService.create(storage);
  const replacement = {...EVM_SOURCE, publicKey: '03' + PUBLIC_KEY.slice(2)};

  service.addWallet(KEY_INDEX, replacement);

  const key = service.keys[0];

  assert.deepEqual(toJS(key.wallets), [SOLANA_SOURCE, replacement]);
  assert.equal(
    getDefaultWallet(key).address,
    getWalletData(replacement).address,
  );
  assert.notEqual(getDefaultWallet(key).address, EVM_ADDRESS);
  assert.deepEqual(toJS(key.defaultWallet), reference);
});

test('different derivation paths retain separate sources even when their addresses match', async context => {
  context.mock.method(console, 'info', () => {});

  const storage = createStorage([createKey([EVM_SOURCE])]);
  const service = await WalletStorageService.create(storage);
  const second = {...EVM_SOURCE, path: "m/44'/60'/0'/0/1"};

  service.addWallet(KEY_INDEX, second);

  assert.deepEqual(toJS(service.keys[0].wallets), [EVM_SOURCE, second]);
  assert.deepEqual(
    getKeyWallets(service.keys[0]).map(wallet => wallet.address),
    [EVM_ADDRESS, EVM_ADDRESS],
  );
});

test('derivation suggestions advance each address type independently', async () => {
  const keys = [
    createKey([
      EVM_SOURCE,
      {...EVM_SOURCE, path: "m/44'/60'/0'/0/2"},
      SOLANA_SOURCE,
      {...SOLANA_SOURCE, path: "m/44'/501'/1'/0'"},
      SEGWIT_SOURCE,
      TAPROOT_SOURCE,
      {...SEGWIT_SOURCE, path: "m/44'/60'/0'/0/1"},
      {...EVM_SOURCE, path: "m/44'/501'/2'/0'"},
      {...TAPROOT_SOURCE, path: "m/84'/0'/0'/0/1"},
      {...EVM_SOURCE, path: "m/86'/0'/0'/0/1"},
    ]),
  ];
  const storage = createStorage(keys);
  const service = await WalletStorageService.create(storage);

  for (const [type, expected] of [
    ['evm', "m/44'/60'/0'/0/1"],
    ['solana', "m/44'/501'/2'/0'"],
    ['bitcoin-segwit', "m/84'/0'/0'/0/1"],
    ['bitcoin-taproot', "m/86'/0'/0'/0/1"],
  ]) {
    assert.equal(service.suggestNextDerivationPath(KEY_INDEX, type), expected);
  }

  assert.deepEqual(toJS(service.keys), keys);
  assert.deepEqual(storage.writes, []);
});

test('deleting a non-default source preserves the default and remaining order', async context => {
  context.mock.method(console, 'info', () => {});

  const reference = getWalletReference(SEGWIT_SOURCE);
  const storage = createStorage([
    {
      ...createKey([EVM_SOURCE, SOLANA_SOURCE, SEGWIT_SOURCE]),
      defaultWallet: reference,
    },
  ]);
  const service = await WalletStorageService.create(storage);

  service.deleteWallet(KEY_INDEX, getWalletData(SOLANA_SOURCE));

  assert.deepEqual(toJS(service.keys[0].wallets), [EVM_SOURCE, SEGWIT_SOURCE]);
  assert.deepEqual(toJS(service.keys[0].defaultWallet), reference);
  assert.equal(getDefaultWallet(service.keys[0]).addressType, 'bitcoin-segwit');
  assert.equal(storage.writes.length, 1);
});

for (const explicitDefault of [false, true]) {
  test(`deleting the ${explicitDefault ? 'explicit' : 'implicit'} default resets it and retains the first remaining source after reload`, async context => {
    context.mock.method(console, 'info', () => {});

    const target = explicitDefault ? SOLANA_SOURCE : EVM_SOURCE;
    const remaining = explicitDefault ? EVM_SOURCE : SOLANA_SOURCE;
    const storage = createStorage([
      {
        ...createKey([EVM_SOURCE, SOLANA_SOURCE]),
        ...(explicitDefault && {defaultWallet: getWalletReference(target)}),
      },
    ]);
    const service = await WalletStorageService.create(storage);

    service.deleteWallet(KEY_INDEX, getWalletReference(target));

    assert.deepEqual(toJS(service.keys[0].wallets), [remaining]);
    assert.equal(Object.hasOwn(service.keys[0], 'defaultWallet'), false);

    const reloaded = await WalletStorageService.create(storage);

    assert.deepEqual(toJS(reloaded.keys), toJS(service.keys));
    assert.deepEqual(
      getDefaultWallet(reloaded.keys[0]),
      getWalletData(remaining),
    );
  });
}

test('deletion targets the source parameters when two derived addresses are identical', async context => {
  context.mock.method(console, 'info', () => {});

  const second = {...EVM_SOURCE, path: "m/44'/60'/0'/0/1"};
  const reference = getWalletReference(EVM_SOURCE);
  const storage = createStorage([
    {...createKey([EVM_SOURCE, second]), defaultWallet: reference},
  ]);
  const service = await WalletStorageService.create(storage);

  service.deleteWallet(KEY_INDEX, getWalletData(second));

  assert.deepEqual(toJS(service.keys[0].wallets), [EVM_SOURCE]);
  assert.deepEqual(toJS(service.keys[0].defaultWallet), reference);
  assert.equal(getDefaultWallet(service.keys[0]).path, EVM_SOURCE.path);
});

test('deleting the final source keeps its parent key and permits derivation after reload', async context => {
  context.mock.method(console, 'info', () => {});

  const otherKey = {...createKey([SOLANA_SOURCE]), index: '00000002'};
  const storage = createStorage([
    {...createKey([EVM_SOURCE]), defaultWallet: getWalletReference(EVM_SOURCE)},
    otherKey,
  ]);
  const service = await WalletStorageService.create(storage);
  const key = service.keys[0];

  service.deleteWallet(KEY_INDEX, getWalletData(EVM_SOURCE));

  assert.equal(service.indexToKeyMap.get(KEY_INDEX), key);
  assert.deepEqual(toJS(service.keys), [createKey([]), otherKey]);

  const reloaded = await WalletStorageService.create(storage);

  assert.equal(getDefaultWallet(reloaded.keys[0]), undefined);
  assert.equal(
    reloaded.suggestNextDerivationPath(KEY_INDEX, 'evm'),
    EVM_SOURCE.path,
  );
});

test('raw public keys produce only supported available addresses and reject source additions or deletions', async () => {
  const keys = [
    {
      ...createKey([]),
      type: 'secp256k1',
      publicKey: PUBLIC_KEY,
      taprootOutputKey: TAPROOT_PUBLIC_KEY,
    },
    {
      ...createKey([]),
      type: 'ed25519',
      index: '00000002',
      publicKey: SOLANA_SOURCE.publicKey,
    },
    {
      ...createKey([]),
      type: 'secp256k1',
      index: '00000003',
      taprootOutputKey: TAPROOT_PUBLIC_KEY,
    },
  ];
  const storage = createStorage(keys);
  const service = await WalletStorageService.create(storage);

  assert.deepEqual(
    service.keys.map(key =>
      getKeyWallets(key).map(wallet => wallet.addressType),
    ),
    [
      ['evm', 'bitcoin-segwit', 'bitcoin-taproot'],
      ['solana'],
      ['bitcoin-taproot'],
    ],
  );

  for (const key of service.keys) {
    for (const wallet of getKeyWallets(key)) {
      service.deleteWallet(key.index, wallet);
    }
    service.addWallet(key.index, EVM_SOURCE);
  }

  assert.deepEqual(toJS(service.keys), keys);
  assert.deepEqual(storage.writes, []);
});

test('unknown keys or wallet references leave stored data unchanged', async () => {
  const keys = [createKey([EVM_SOURCE])];
  const storage = createStorage(keys);
  const service = await WalletStorageService.create(storage);

  service.addWallet('ffffffff', SOLANA_SOURCE);
  service.deleteWallet('ffffffff', getWalletReference(EVM_SOURCE));
  service.deleteWallet(KEY_INDEX, getWalletReference(SOLANA_SOURCE));
  service.deleteWallet(KEY_INDEX, {
    ...getWalletReference(EVM_SOURCE),
    path: "m/44'/60'/0'/0/9",
  });

  assert.deepEqual(toJS(service.keys), keys);
  assert.deepEqual(storage.values.get('walletKeys'), keys);
  assert.deepEqual(storage.writes, []);
});
