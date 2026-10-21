import assert from 'node:assert/strict';
import {test} from 'node:test';

import {toJS} from 'mobx';

import {
  getCardKeyData,
  importCardKey,
  isWalletKeyUpToDate,
} from '../.bld/app/@components/views/safe/card-key-import.js';
import {
  WalletStorageService,
  getDefaultWallet,
  getKeyWallets,
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

test('master keys cannot be imported as wallet keys', () => {
  assert.throws(() => getCardKeyData(scannedKey(EVM_REF, 'master')));
});

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
  for (const child of Object.values(value)) assertNoAddressCache(child);
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

for (const [ref, type] of [
  [EVM_REF, 'secp256k1'],
  [SEGWIT_REF, 'secp256k1'],
  [TAPROOT_REF, 'secp256k1'],
  [SOLANA_REF, 'ed25519'],
]) {
  test(`a native ${ref.addressType} import persists only that address after reload`, async context => {
    context.mock.method(console, 'info', () => {});
    const storage = createStorage();
    const service = await WalletStorageService.create(storage);
    const incoming = getCardKeyData(scannedKey(ref, type));
    importCardKey(service, incoming);
    const reloaded = await WalletStorageService.create(storage);

    assert.deepEqual(
      displayedAddresses(reloaded.keys[0]),
      expectedAddresses(ref),
    );
    assert.equal(reloaded.keys[0].wallets[0].publicKey, ref.publicKey);
    assert.equal(getDefaultWallet(reloaded.keys[0]).address, ref.address);
    assert.equal(Object.hasOwn(incoming, 'publicKey'), false);
    assert.equal(Object.hasOwn(incoming, 'taprootOutputKey'), false);
    assert.equal(isWalletKeyUpToDate(incoming, reloaded.keys[0]), true);
    assertNoAddressCache(storage.writes[0]);
  });
}

test('native address additions are independent and preserve the current default', async context => {
  context.mock.method(console, 'info', () => {});
  const first = getCardKeyData(scannedKey(SEGWIT_REF));
  const service = await WalletStorageService.create(createStorage([first]));
  const key = service.keys[0];
  importCardKey(service, getCardKeyData(scannedKey(EVM_REF)));
  importCardKey(service, getCardKeyData(scannedKey(TAPROOT_REF)));
  assert.deepEqual(
    displayedAddresses(key),
    expectedAddresses(SEGWIT_REF, EVM_REF, TAPROOT_REF),
  );
  assert.equal(getDefaultWallet(key).address, SEGWIT_REF.address);

  service.deleteWallet(
    INDEX,
    key.wallets.find(wallet => wallet.addressType === 'evm'),
  );
  importCardKey(service, getCardKeyData(scannedKey(TAPROOT_REF)));
  assert.deepEqual(
    displayedAddresses(key),
    expectedAddresses(SEGWIT_REF, TAPROOT_REF),
  );
  assert.equal(getDefaultWallet(key).address, SEGWIT_REF.address);
});

for (const alias of [undefined, '', 'Card name']) {
  test(`download treats alias ${JSON.stringify(alias)} as ${alias === undefined ? 'unspecified' : 'an explicit value'}`, async context => {
    context.mock.method(console, 'info', () => {});
    const saved = {...getCardKeyData(scannedKey(EVM_REF)), alias: 'Local name'};
    const service = await WalletStorageService.create(createStorage([saved]));
    const incoming = getCardKeyData({...scannedKey(EVM_REF), alias});
    assert.equal(
      isWalletKeyUpToDate(incoming, service.keys[0]),
      alias === undefined,
    );
    importCardKey(service, incoming);
    assert.equal(service.keys[0].alias, alias ?? 'Local name');
    assert.equal(isWalletKeyUpToDate(incoming, service.keys[0]), true);
  });
}

test('an explicit empty download imports a key without materializing its preview', async context => {
  context.mock.method(console, 'info', () => {});
  const incoming = getCardKeyData(scannedKey(EVM_REF), []);
  const service = await WalletStorageService.create(createStorage());
  importCardKey(service, incoming);
  assert.deepEqual(incoming.wallets, []);
  assert.equal(incoming.defaultWallet, undefined);
  assert.equal(getDefaultWallet(service.keys[0]), undefined);
  assert.equal(isWalletKeyUpToDate(incoming, service.keys[0]), true);

  importCardKey(service, getCardKeyData(scannedKey(SEGWIT_REF)));
  importCardKey(service, getCardKeyData(scannedKey(undefined), []));
  assert.deepEqual(
    displayedAddresses(service.keys[0]),
    expectedAddresses(SEGWIT_REF),
  );
});

test('complete card records merge without adding an unrelated preview or changing the local default', async context => {
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
  const preview = wallet("m/44'/60'/0'/0/11");
  const saved = getCardKeyData(
    scannedKey({...local, address: EVM_REF.address}, 'seed'),
  );
  const service = await WalletStorageService.create(createStorage([saved]));
  const incoming = getCardKeyData(
    scannedKey({...preview, address: EVM_REF.address}, 'seed'),
    [first, second],
  );
  assert.deepEqual(incoming.wallets, [first, second]);
  assert.equal(incoming.defaultWallet, undefined);
  importCardKey(service, incoming);
  importCardKey(service, incoming);
  assert.deepEqual(toJS(service.keys[0].wallets), [local, first, second]);
  assert.equal(getDefaultWallet(service.keys[0]).path, local.path);
  assertNoAddressCache(toJS(service.keys[0]));
});

test('duplicate records deduplicate by full address parameters, not by public key', () => {
  const first = {
    ...EVM_REF,
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: "m/44'/60'/0'/0/0",
  };
  const second = {...first, path: "m/44'/60'/0'/0/1"};
  const incoming = getCardKeyData(scannedKey(undefined, 'seed'), [
    first,
    first,
    second,
  ]);
  assert.equal(incoming.wallets.length, 2);
  assert.equal(incoming.wallets[0].path, first.path);
  assert.equal(incoming.wallets[1].path, second.path);
});

test('a conflicting public key rejects the entire import before alias or address mutation', async () => {
  const service = await WalletStorageService.create(
    createStorage([getCardKeyData(scannedKey(EVM_REF))]),
  );
  const original = toJS(service.keys);
  const conflict = {...SEGWIT_REF, publicKey: `03${PUBLIC_KEY.slice(2)}`};
  const incoming = getCardKeyData({...scannedKey(conflict), alias: ''});
  assert.throws(
    () => importCardKey(service, incoming),
    /public key does not match/,
  );
  assert.deepEqual(toJS(service.keys), original);
  assert.throws(
    () => getCardKeyData(scannedKey(undefined), [EVM_REF, conflict]),
    /public key does not match/,
  );
});
