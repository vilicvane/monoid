import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

// eslint-disable-next-line @mufan/scoped-modules -- Verify card paths without platform initialization.
import {parseDerivationPath} from '../.bld/app/@lib/bip39.js';
// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Test stored wallet data without platform services.
import {
  getKeyWallets,
  getWalletData,
} from '../.bld/app/@services/wallet-storage-service.js';

mock.module('../.bld/app/@services/index.js', {
  namedExports: {getKeyWallets},
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
    index: '02400000000000000001',
    alias: 'Bitcoin key',
    wallets: [],
    ...fields,
  };
}

test('Home requires an actual BTC derivation or an available raw Bitcoin public key', () => {
  assert.equal(hasBitcoinWallet([]), false);
  for (const type of ['seed', 'master']) {
    assert.equal(hasBitcoinWallet([key(type)]), false);
    assert.equal(hasBitcoinWallet([key(type, {wallets: [EVM_SOURCE]})]), false);
    for (const source of [SEGWIT_SOURCE, TAPROOT_SOURCE]) {
      assert.equal(hasBitcoinWallet([key(type, {wallets: [source]})]), true);
    }
  }
  assert.equal(hasBitcoinWallet([key('secp256k1')]), false);
  assert.equal(
    hasBitcoinWallet([key('secp256k1', {publicKey: PUBLIC_KEY})]),
    true,
  );
  assert.equal(
    hasBitcoinWallet([
      key('secp256k1', {taprootOutputKey: TAPROOT_OUTPUT_KEY}),
    ]),
    true,
  );
  assert.equal(
    hasBitcoinWallet([key('ed25519', {publicKey: '00'.repeat(32)})]),
    false,
  );
});

test('derived BTC signing keeps the selected source public key and BIP32 path', () => {
  for (const type of ['seed', 'master']) {
    const storedKey = key(type, {
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
        type,
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
    publicKey: PUBLIC_KEY,
    taprootOutputKey: TAPROOT_OUTPUT_KEY,
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
});
