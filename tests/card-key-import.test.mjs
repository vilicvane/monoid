import assert from 'node:assert/strict';
import {test} from 'node:test';

import {p256} from '@noble/curves/nist';
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
  getWalletData,
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
  publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
};
SOLANA_REF.address = getWalletData(SOLANA_REF).address;

function scannedKey(ref, type = 'secp256k1') {
  return {type, index: INDEX, alias: 'Test key', ref};
}

test('master keys cannot be imported as wallet keys', () => {
  assert.throws(() => getCardKeyData(scannedKey(EVM_REF, 'master')));
});

test('a native P-256 public key imports and reloads without inventing a wallet address', async context => {
  context.mock.method(console, 'info', () => {});
  const publicKey = Buffer.from(p256.getPublicKey(1n, false)).toString('hex');
  const compressed = Buffer.from(p256.getPublicKey(1n, true)).toString('hex');
  const incoming = getCardKeyData({
    ...scannedKey(undefined, 'secp256r1'),
    publicKey: compressed,
  });
  const storage = createStorage();
  const service = await WalletStorageService.create(storage);
  importCardKey(service, incoming);
  const reloaded = await WalletStorageService.create(storage);

  assert.equal(reloaded.keys[0].type, 'secp256r1');
  assert.equal(reloaded.keys[0].rawPublicKey, publicKey);
  assert.deepEqual(reloaded.keys[0].wallets, []);
  assert.deepEqual(getKeyWallets(reloaded.keys[0]), []);
  assert.equal(getDefaultWallet(reloaded.keys[0]), undefined);
  assert.equal(Object.hasOwn(reloaded.keys[0], 'publicKey'), false);
  assert.equal(isWalletKeyUpToDate(incoming, reloaded.keys[0]), true);
  assert.equal(
    isWalletKeyUpToDate(incoming, {
      ...reloaded.keys[0],
      rawPublicKey: undefined,
    }),
    false,
  );
  assert.equal(
    storage.writes.length,
    1,
    'reload must not migrate the native key away',
  );
});

test('P-256 import rejects malformed points and conflicting native keys before changing an alias', async context => {
  context.mock.method(console, 'info', () => {});
  assert.throws(() =>
    getCardKeyData({
      ...scannedKey(undefined, 'secp256r1'),
      publicKey: `04${'00'.repeat(64)}`,
    }),
  );
  const key = getCardKeyData({
    ...scannedKey(undefined, 'secp256r1'),
    publicKey: Buffer.from(p256.getPublicKey(1n, false)).toString('hex'),
  });
  const service = await WalletStorageService.create(createStorage([key]));
  const original = toJS(service.keys);
  const incoming = getCardKeyData({
    ...scannedKey(undefined, 'secp256r1'),
    alias: 'Changed alias',
    publicKey: Buffer.from(p256.getPublicKey(2n, false)).toString('hex'),
  });
  assert.throws(
    () => importCardKey(service, incoming),
    /public key does not match/,
  );
  assert.deepEqual(toJS(service.keys), original);
});

test('deleting the last Solana address preserves an imported native Ed25519 key', async context => {
  context.mock.method(console, 'info', () => {});
  const incoming = getCardKeyData(scannedKey(SOLANA_REF, 'ed25519'), [
    SOLANA_REF,
  ]);
  const storage = createStorage();
  const service = await WalletStorageService.create(storage);
  importCardKey(service, incoming);
  assert.equal(service.keys[0].rawPublicKey, SOLANA_REF.publicKey);
  service.deleteWallet(INDEX, incoming.wallets[0]);
  assert.deepEqual(getKeyWallets(service.keys[0]), []);
  assert.equal(service.keys[0].rawPublicKey, SOLANA_REF.publicKey);
  await service.flush();
  const reloaded = await WalletStorageService.create(storage);
  assert.equal(reloaded.keys[0].rawPublicKey, SOLANA_REF.publicKey);
  assert.deepEqual(getKeyWallets(reloaded.keys[0]), []);
  const explicitEmpty = getCardKeyData(
    {
      ...scannedKey(undefined, 'ed25519'),
      publicKey: SOLANA_REF.publicKey,
    },
    [],
  );
  assert.equal(explicitEmpty.rawPublicKey, SOLANA_REF.publicKey);
  assert.deepEqual(explicitEmpty.wallets, []);
});

test('an Ed25519 public key or old preview imports as a native key without adding a Solana wallet', () => {
  for (const key of [
    {...scannedKey(undefined, 'ed25519'), publicKey: SOLANA_REF.publicKey},
    scannedKey(SOLANA_REF, 'ed25519'),
  ]) {
    const incoming = getCardKeyData(key);
    assert.equal(incoming.rawPublicKey, SOLANA_REF.publicKey);
    assert.deepEqual(incoming.wallets, []);
    assert.equal(incoming.defaultWallet, undefined);
  }
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
    const incoming = getCardKeyData(scannedKey(ref, type), [ref]);
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
