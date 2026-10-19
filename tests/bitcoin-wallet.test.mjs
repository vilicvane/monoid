import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

// eslint-disable-next-line @mufan/scoped-modules -- Verify card paths without platform initialization.
import {parseDerivationPath} from '../.bld/app/@lib/bip39.js';
// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Test stored wallet data without platform services.
import {
  getKeyWallets,
  getWalletData,
  matchesWalletReference,
} from '../.bld/app/@services/wallet-storage-service.js';

mock.module('../.bld/app/@services/index.js', {
  namedExports: {getKeyWallets, matchesWalletReference},
});

const {getBitcoinWalletSigningAccount, hasBitcoinWallet} = await import(
  '../.bld/app/@lib/bitcoin-wallet.js'
);

const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const TAPROOT_OUTPUT_KEY =
  'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c';
const SEGWIT_SOURCE = {
  addressType: 'bitcoin-segwit',
  seed: 'Bitcoin seed',
  curve: 'secp256k1',
  path: "m/84'/0'/0'/0/7",
  publicKey: PUBLIC_KEY,
};
const TAPROOT_SOURCE = {
  ...SEGWIT_SOURCE,
  addressType: 'bitcoin-taproot',
  path: "m/86'/0'/0'/0/9",
  publicKey: TAPROOT_OUTPUT_KEY,
};
const EVM_SOURCE = {
  ...SEGWIT_SOURCE,
  addressType: 'evm',
  path: "m/44'/60'/0'/0/0",
};

function key(type, fields = {}) {
  return {
    type,
    index: type === 'seed' ? '02400000000000000001' : '03010000000000000001',
    alias: 'Bitcoin key',
    wallets: [],
    ...fields,
  };
}

function raw(source) {
  return {...source, seed: undefined, curve: undefined, path: undefined};
}

test('Home requires an explicitly imported BTC address', () => {
  assert.equal(hasBitcoinWallet([]), false);
  for (const index of ['02400000000000000001', '02200000000000000002']) {
    assert.equal(hasBitcoinWallet([key('seed', {index})]), false);
    assert.equal(
      hasBitcoinWallet([key('seed', {index, wallets: [EVM_SOURCE]})]),
      false,
    );
    for (const source of [SEGWIT_SOURCE, TAPROOT_SOURCE]) {
      assert.equal(
        hasBitcoinWallet([key('seed', {index, wallets: [source]})]),
        true,
      );
    }
  }
  assert.equal(hasBitcoinWallet([key('secp256k1')]), false);
  assert.equal(
    hasBitcoinWallet([key('secp256k1', {wallets: [raw(SEGWIT_SOURCE)]})]),
    true,
  );
  assert.equal(
    hasBitcoinWallet([key('secp256k1', {wallets: [raw(TAPROOT_SOURCE)]})]),
    true,
  );
  assert.equal(
    hasBitcoinWallet([key('secp256k1', {wallets: [raw(EVM_SOURCE)]})]),
    false,
  );
});

test('derived BTC signing keeps the selected source public key and BIP32 path', () => {
  for (const index of ['02400000000000000001', '02200000000000000002']) {
    const storedKey = key('seed', {
      index,
      wallets: [EVM_SOURCE, SEGWIT_SOURCE, TAPROOT_SOURCE],
    });
    for (const source of [SEGWIT_SOURCE, TAPROOT_SOURCE]) {
      const address = getWalletData(source).address;
      const account = getBitcoinWalletSigningAccount([storedKey], address);

      assert.equal(account.key, storedKey);
      assert.equal(account.wallet.address, address);
      assert.equal(account.wallet.addressType, source.addressType);
      assert.equal(account.wallet.publicKey, source.publicKey);
      assert.deepEqual(account.reference, {
        type: 'seed',
        index: Uint8Array.from(Buffer.from(storedKey.index, 'hex')),
        derivation: {type: 'bip32', path: parseDerivationPath(source.path)},
      });
    }
    assert.equal(
      getBitcoinWalletSigningAccount(
        [storedKey],
        getWalletData(EVM_SOURCE).address,
      ),
      undefined,
    );
  }
});

test('raw BTC signing uses the matching key format without inventing a derivation', () => {
  const storedKey = key('secp256k1', {
    wallets: [raw(SEGWIT_SOURCE), raw(TAPROOT_SOURCE)],
  });
  for (const source of [SEGWIT_SOURCE, TAPROOT_SOURCE]) {
    const account = getBitcoinWalletSigningAccount(
      [storedKey],
      getWalletData(source).address,
    );

    assert.equal(account.key, storedKey);
    assert.equal(account.wallet.path, undefined);
    assert.equal(account.wallet.publicKey, source.publicKey);
    assert.deepEqual(account.reference, {
      type: 'secp256k1',
      index: Uint8Array.from(Buffer.from(storedKey.index, 'hex')),
    });
  }
});

test('removed wallets and unrelated addresses cannot resolve to a signing key', () => {
  const address = getWalletData(SEGWIT_SOURCE).address;
  assert.equal(getBitcoinWalletSigningAccount([], address), undefined);
  assert.equal(
    getBitcoinWalletSigningAccount([key('seed')], address),
    undefined,
  );
  assert.equal(
    getBitcoinWalletSigningAccount(
      [key('seed', {wallets: [TAPROOT_SOURCE]})],
      address,
    ),
    undefined,
  );
  const rawKey = key('secp256k1', {wallets: [raw(EVM_SOURCE)]});
  assert.equal(getBitcoinWalletSigningAccount([rawKey], address), undefined);
  rawKey.wallets.push(raw(SEGWIT_SOURCE));
  assert.ok(getBitcoinWalletSigningAccount([rawKey], address));
  rawKey.wallets.pop();
  assert.equal(getBitcoinWalletSigningAccount([rawKey], address), undefined);
});
