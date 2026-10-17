import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {getBytes} from 'ethers';

import {parseDerivationPath} from '../.bld/app/@lib/bip39.js';
import {getAppletKey} from '../.bld/app/@lib/monoid/get-applet-key.js';
import {getKeyWallets} from '../.bld/app/@services/wallet-storage-service.js';

mock.module('../.bld/app/@services/index.js', {
  namedExports: {getKeyWallets},
});

const {getWalletSigningAccount} = await import(
  '../.bld/app/@components/@monoid/get-wallet-signing-account.js'
);

const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const PATH = "m/44'/60'/0'/0/7";

test('signing selects the saved EVM wallet and preserves its derivation path', () => {
  for (const type of ['seed', 'master']) {
    const key = {
      type,
      index: type === 'seed' ? '02400000000000000001' : '03400000000000000002',
      alias: undefined,
      wallets: [
        {
          addressType: 'solana',
          seed: type === 'seed' ? 'ed25519 seed' : undefined,
          curve: 'ed25519',
          path: "m/44'/501'/0'/0'",
          publicKey: '00'.repeat(32),
        },
        {
          addressType: 'evm',
          seed: type === 'seed' ? 'Bitcoin seed' : undefined,
          curve: 'secp256k1',
          path: PATH,
          publicKey: PUBLIC_KEY,
        },
      ],
    };
    const result = getWalletSigningAccount([key], ADDRESS.toLowerCase());

    assert.equal(result.key, key);
    assert.equal(result.wallet.address, ADDRESS);
    assert.deepEqual(result.reference, {
      type,
      index: getBytes(`0x${key.index}`),
      derivation: {type: 'bip32', path: parseDerivationPath(PATH)},
    });
  }
});

test('raw EVM keys carry their explicit type without derivation fields', () => {
  const key = {
    type: 'secp256k1',
    index: '04010000000000000001',
    alias: undefined,
    publicKey: PUBLIC_KEY,
    wallets: [],
  };

  assert.deepEqual(getWalletSigningAccount([key], ADDRESS).reference, {
    type: 'secp256k1',
    index: getBytes(`0x${key.index}`),
  });
  assert.equal(
    getWalletSigningAccount(
      [key],
      '0x0000000000000000000000000000000000000001',
    ),
    undefined,
  );
});

test('applet references never reinterpret a raw curve or omit a derived path', () => {
  assert.throws(
    () => getAppletKey({type: 'ed25519', index: '05010000000000000001'}, 'evm'),
    /not supported/,
  );
  assert.throws(
    () =>
      getAppletKey(
        {type: 'secp256k1', index: '04010000000000000001'},
        'solana',
      ),
    /not supported/,
  );
  assert.throws(
    () => getAppletKey({type: 'seed', index: '02400000000000000001'}, 'evm'),
    /requires a derivation path/,
  );
});
