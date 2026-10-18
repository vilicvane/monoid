import assert from 'node:assert/strict';
import {test} from 'node:test';

import {toJS} from 'mobx';

import {
  getCardKeyData,
  importCardKey,
  isWalletKeyUpToDate,
} from '../.bld/app/@components/views/safe/card-key-import.js';
import {
  getDefaultWallet,
  getKeyWallets,
  WalletStorageService,
} from '../.bld/app/@services/wallet-storage-service.js';

const INDEX = '00000001';
const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const EVM_REF = {
  addressType: 'evm',
  publicKey: PUBLIC_KEY,
  address: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
};
const SEGWIT_REF = {
  addressType: 'bitcoin-segwit',
  publicKey: PUBLIC_KEY,
  address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
};
const TAPROOT_REF = {
  addressType: 'bitcoin-taproot',
  publicKey: 'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c',
  address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
};
const SOLANA_REF = {
  addressType: 'solana',
  publicKey: '00'.repeat(32),
  address: '1'.repeat(32),
};

function scannedKey(ref, type = 'secp256k1') {
  return {type, index: INDEX, alias: 'Test key', ref};
}

function displayedAddresses(key) {
  return getKeyWallets(key).map(({addressType, address}) => [
    addressType,
    address,
  ]);
}

function expectedAddresses(...refs) {
  return refs.map(({addressType, address}) => [addressType, address]);
}

function assertNoAddressCache(value) {
  if (!value || typeof value !== 'object') return;

  assert.equal(Object.hasOwn(value, 'address'), false);

  for (const child of Object.values(value)) {
    assertNoAddressCache(child);
  }
}

function createStorage(walletKeys = []) {
  let stored = structuredClone(walletKeys);

  return {
    writes: [],
    async get(key) {
      assert.equal(key, 'walletKeys');
      return structuredClone(stored);
    },
    async set(key, value) {
      assert.equal(key, 'walletKeys');
      stored = structuredClone(value);
      this.writes.push(stored);
    },
  };
}

for (const alias of [undefined, '']) {
  test(`a ${alias === undefined ? 'missing' : 'empty'} card alias preserves the local alias while other metadata can still update`, async context => {
    context.mock.method(console, 'info', () => {});

    const saved = getCardKeyData(scannedKey(EVM_REF));
    saved.alias = 'Local name';
    const storage = createStorage([saved]);
    const service = await WalletStorageService.create(storage);
    const existing = service.keys[0];
    const incoming = getCardKeyData({...scannedKey(EVM_REF), alias});

    assert.equal(isWalletKeyUpToDate(incoming, existing), true);

    const updated = getCardKeyData({...scannedKey(TAPROOT_REF), alias});
    assert.equal(isWalletKeyUpToDate(updated, existing), false);

    importCardKey(service, updated);

    assert.equal(existing.alias, 'Local name');
    assert.equal(existing.taprootOutputKey, TAPROOT_REF.publicKey);
    assert.equal(isWalletKeyUpToDate(updated, existing), true);

    const reloaded = await WalletStorageService.create(storage);
    assert.equal(reloaded.keys[0].alias, 'Local name');
  });
}

test('a nonempty changed card alias is an update and replaces the local alias', async context => {
  context.mock.method(console, 'info', () => {});

  const saved = getCardKeyData(scannedKey(EVM_REF));
  saved.alias = 'Local name';
  const service = await WalletStorageService.create(createStorage([saved]));
  const incoming = getCardKeyData(scannedKey(EVM_REF));

  assert.equal(isWalletKeyUpToDate(incoming, service.keys[0]), false);
  importCardKey(service, incoming);
  assert.equal(service.keys[0].alias, 'Test key');
  assert.equal(isWalletKeyUpToDate(incoming, service.keys[0]), true);
});

test('ordinary raw secp256k1 imports store one public key and compute both address views', () => {
  for (const ref of [EVM_REF, SEGWIT_REF]) {
    const key = getCardKeyData(scannedKey(ref));

    assert.equal(key.publicKey, PUBLIC_KEY);
    assert.equal(key.taprootOutputKey, undefined);
    assert.deepEqual(key.wallets, []);
    assert.deepEqual(
      displayedAddresses(key),
      expectedAddresses(EVM_REF, SEGWIT_REF),
    );
    assert.equal(getDefaultWallet(key).address, ref.address);
    assertNoAddressCache(key);
  }
});

test('raw Taproot stores its output key separately and cannot fabricate ordinary addresses', () => {
  const tweakedOnly = getCardKeyData(scannedKey(TAPROOT_REF));

  assert.equal(tweakedOnly.publicKey, undefined);
  assert.equal(tweakedOnly.taprootOutputKey, TAPROOT_REF.publicKey);
  assert.deepEqual(tweakedOnly.wallets, []);
  assert.deepEqual(
    displayedAddresses(tweakedOnly),
    expectedAddresses(TAPROOT_REF),
  );
  assertNoAddressCache(tweakedOnly);

  const both = getCardKeyData(scannedKey(TAPROOT_REF), [
    EVM_REF,
    SEGWIT_REF,
    TAPROOT_REF,
  ]);

  assert.equal(both.publicKey, PUBLIC_KEY);
  assert.equal(both.taprootOutputKey, TAPROOT_REF.publicKey);
  assert.deepEqual(both.wallets, []);
  assert.deepEqual(
    displayedAddresses(both),
    expectedAddresses(EVM_REF, SEGWIT_REF, TAPROOT_REF),
  );
  assertNoAddressCache(both);
});

for (const withTaproot of [false, true]) {
  test(`reloading a raw import computes ${withTaproot ? 'three' : 'two'} addresses and preserves the selected BTC default without address caches`, async context => {
    context.mock.method(console, 'info', () => {});

    const storage = createStorage();
    const service = await WalletStorageService.create(storage);
    const key = getCardKeyData(
      scannedKey(SEGWIT_REF),
      withTaproot ? [SEGWIT_REF, TAPROOT_REF] : [SEGWIT_REF],
    );

    importCardKey(service, key);

    assert.equal(service.keys.length, 1);
    assert.equal(storage.writes.length, 1);
    assertNoAddressCache(storage.writes[0]);

    const reloaded = await WalletStorageService.create(storage);

    assert.deepEqual(toJS(reloaded.keys), toJS(service.keys));
    assert.deepEqual(
      displayedAddresses(reloaded.keys[0]),
      expectedAddresses(
        EVM_REF,
        SEGWIT_REF,
        ...(withTaproot ? [TAPROOT_REF] : []),
      ),
    );
    assert.equal(
      getDefaultWallet(reloaded.keys[0]).address,
      SEGWIT_REF.address,
    );
  });
}

for (const firstRef of [SEGWIT_REF, TAPROOT_REF]) {
  test(`adding the missing raw public key preserves the existing ${firstRef.addressType} default`, async context => {
    context.mock.method(console, 'info', () => {});

    const first = getCardKeyData(scannedKey(firstRef));
    const nextRef = firstRef === TAPROOT_REF ? EVM_REF : TAPROOT_REF;
    const incoming = getCardKeyData(scannedKey(nextRef));
    const storage = createStorage([first]);
    const service = await WalletStorageService.create(storage);
    const existing = service.keys[0];
    const defaultReference = toJS(existing.defaultWallet);

    assert.equal(isWalletKeyUpToDate(incoming, existing), false);
    assert.deepEqual(
      displayedAddresses(existing),
      firstRef === TAPROOT_REF
        ? expectedAddresses(TAPROOT_REF)
        : expectedAddresses(EVM_REF, SEGWIT_REF),
    );
    assert.deepEqual(storage.writes, []);

    importCardKey(service, incoming);

    assert.equal(service.keys[0], existing);
    assert.equal(existing.publicKey, PUBLIC_KEY);
    assert.equal(existing.taprootOutputKey, TAPROOT_REF.publicKey);
    assert.deepEqual(toJS(existing.wallets), []);
    assert.deepEqual(toJS(existing.defaultWallet), defaultReference);
    assert.equal(getDefaultWallet(existing).address, firstRef.address);
    assert.deepEqual(
      displayedAddresses(existing),
      expectedAddresses(EVM_REF, SEGWIT_REF, TAPROOT_REF),
    );
    assert.equal(isWalletKeyUpToDate(incoming, existing), true);
    assertNoAddressCache(storage.writes[0]);

    const reloaded = await WalletStorageService.create(storage);

    assert.deepEqual(toJS(reloaded.keys), toJS(service.keys));
    assert.equal(getDefaultWallet(reloaded.keys[0]).address, firstRef.address);
  });
}

test('seed and master imports store only the selected public key and derivation metadata', async context => {
  context.mock.method(console, 'info', () => {});

  for (const type of ['seed', 'master']) {
    const refs = [
      {
        ...EVM_REF,
        seed: type === 'seed' ? 'Bitcoin seed' : undefined,
        curve: 'secp256k1',
        path: "m/44'/60'/0'/0/0",
      },
      {
        ...SEGWIT_REF,
        seed: type === 'seed' ? 'Bitcoin seed' : undefined,
        curve: 'secp256k1',
        path: "m/84'/0'/0'/0/0",
      },
    ];
    const selected = refs[1];
    const incoming = getCardKeyData(scannedKey(selected, type), refs);
    const storage = createStorage();
    const service = await WalletStorageService.create(storage);

    assert.deepEqual(incoming.wallets, [
      {
        addressType: selected.addressType,
        seed: selected.seed,
        curve: selected.curve,
        path: selected.path,
        publicKey: selected.publicKey,
      },
    ]);
    assert.equal(incoming.publicKey, undefined);
    assert.equal(incoming.taprootOutputKey, undefined);
    assertNoAddressCache(incoming);

    importCardKey(service, incoming);

    const reloaded = await WalletStorageService.create(storage);

    assert.deepEqual(
      displayedAddresses(reloaded.keys[0]),
      expectedAddresses(selected),
    );
    assert.equal(isWalletKeyUpToDate(incoming, reloaded.keys[0]), true);
    assert.equal(
      isWalletKeyUpToDate(
        {
          ...incoming,
          wallets: [
            {...incoming.wallets[0], publicKey: '03' + PUBLIC_KEY.slice(2)},
          ],
        },
        reloaded.keys[0],
      ),
      false,
    );
  }
});

test('raw Ed25519 stores its public key and computes one Solana address after reload', async context => {
  context.mock.method(console, 'info', () => {});

  const storage = createStorage();
  const service = await WalletStorageService.create(storage);
  const incoming = getCardKeyData(scannedKey(SOLANA_REF, 'ed25519'));

  importCardKey(service, incoming);

  assert.equal(service.keys[0].publicKey, SOLANA_REF.publicKey);
  assert.equal(service.keys[0].taprootOutputKey, undefined);
  assert.deepEqual(toJS(service.keys[0].wallets), []);
  assertNoAddressCache(storage.writes[0]);

  const reloaded = await WalletStorageService.create(storage);

  assert.deepEqual(
    displayedAddresses(reloaded.keys[0]),
    expectedAddresses(SOLANA_REF),
  );
  assert.equal(getDefaultWallet(reloaded.keys[0]).address, SOLANA_REF.address);
});

test('card derivation sync imports every path, merges local wallets, and preserves the local default', async context => {
  context.mock.method(console, 'info', () => {});

  const wallet = path => ({
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path,
    publicKey: PUBLIC_KEY,
  });
  const first = wallet("m/44'/60'/0'/0/3");
  const second = wallet("m/44'/60'/0'/0/7");
  const local = wallet("m/44'/60'/0'/0/9");
  const ref = {...first, address: EVM_REF.address};
  const source = scannedKey(ref, 'seed');
  const existing = getCardKeyData({
    ...source,
    ref: {...local, address: EVM_REF.address},
  });
  const service = await WalletStorageService.create(createStorage([existing]));
  const incoming = getCardKeyData(source, [ref], [first, second]);

  assert.deepEqual(incoming.wallets, [first, second]);
  assert.equal(isWalletKeyUpToDate(incoming, service.keys[0]), false);
  importCardKey(service, incoming);

  assert.deepEqual(toJS(service.keys[0].wallets), [local, first, second]);
  assert.equal(service.keys[0].defaultWallet.path, local.path);
  assert.equal(isWalletKeyUpToDate(incoming, service.keys[0]), true);
  importCardKey(service, incoming);
  assert.equal(service.keys[0].wallets.length, 3);
  assertNoAddressCache(toJS(service.keys[0]));
});
