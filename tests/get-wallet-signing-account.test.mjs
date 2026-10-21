import assert from 'node:assert/strict';
import {mock, test} from 'node:test';

import {base58} from '@scure/base';
import {getBytes} from 'ethers';

import {parseDerivationPath} from '../.bld/app/@lib/bip39.js';
import {getAppletKey} from '../.bld/app/@lib/monoid/get-applet-key.js';
import {
  getKeyWallets,
  matchesWalletReference,
} from '../.bld/app/@services/wallet-storage-service.js';

mock.module('../.bld/app/@services/index.js', {
  namedExports: {getKeyWallets, matchesWalletReference},
});

const {getWalletSigningAccount, assertWalletSigningAccount} = await import(
  '../.bld/app/@components/@monoid/get-wallet-signing-account.js'
);

const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const PATH = "m/44'/60'/0'/0/7";

test('signing selects the saved EVM wallet and preserves its derivation path', () => {
  for (const index of ['02400000000000000001', '02200000000000000002']) {
    const key = {
      type: 'seed',
      index,
      alias: undefined,
      wallets: [
        {
          addressType: 'solana',
          seed: 'ed25519 seed',
          curve: 'ed25519',
          path: "m/44'/501'/0'/0'",
          publicKey: '00'.repeat(32),
        },
        {
          addressType: 'evm',
          seed: 'Bitcoin seed',
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
      type: 'seed',
      index: getBytes(`0x${key.index}`),
      derivation: {type: 'bip32', path: parseDerivationPath(PATH)},
    });
  }
});

test('raw EVM keys carry their explicit type without derivation fields', () => {
  const key = {
    type: 'secp256k1',
    index: '03010000000000000001',
    alias: undefined,
    wallets: [{addressType: 'evm', publicKey: PUBLIC_KEY}],
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
    () => getAppletKey({type: 'ed25519', index: '04010000000000000001'}, 'evm'),
    /not supported/,
  );
  assert.throws(
    () =>
      getAppletKey(
        {type: 'secp256k1', index: '03010000000000000001'},
        'solana',
      ),
    /not supported/,
  );
  assert.throws(
    () => getAppletKey({type: 'seed', index: '02400000000000000001'}, 'evm'),
    /requires a derivation path/,
  );
});

test('applet references reject unsupported master keys for every address type', () => {
  for (const addressType of [
    'evm',
    'solana',
    'bitcoin-segwit',
    'bitcoin-taproot',
  ]) {
    assert.throws(
      () =>
        getAppletKey(
          {type: 'master', index: '03200000000000000001'},
          addressType,
          PATH,
        ),
      /not supported/,
    );
  }
});

test('Solana signing preserves raw keys, SLIP-0010 paths, and address case', () => {
  const address = `Ab${'1'.repeat(41)}`;
  const publicKey = Buffer.from(base58.decode(address)).toString('hex');
  const path = "m/44'/501'/7'/0'";
  for (const type of ['ed25519', 'seed']) {
    const key = {
      type,
      index:
        type === 'ed25519' ? '04010000000000000001' : '02400000000000000002',
      alias: undefined,
      wallets:
        type === 'ed25519'
          ? [{addressType: 'solana', publicKey}]
          : [
              {
                addressType: 'solana',
                curve: 'ed25519',
                seed: 'ed25519 seed',
                path,
                publicKey,
              },
            ],
    };
    const account = getWalletSigningAccount([key], address, 'solana');
    assert.equal(account.wallet.address, address);
    assert.deepEqual(account.reference, {
      type,
      index: getBytes(`0x${key.index}`),
      ...(type === 'ed25519'
        ? {}
        : {
            derivation: {
              type: 'slip10',
              curve: 'ed25519',
              path: parseDerivationPath(path),
            },
          }),
    });
    assert.equal(
      getWalletSigningAccount([key], `AB${'1'.repeat(41)}`, 'solana'),
      undefined,
    );
    assert.equal(getWalletSigningAccount([key], address), undefined);
  }
});

test('a previously resolved account becomes unavailable when its explicit record is deleted', () => {
  const evm = {addressType: 'evm', publicKey: PUBLIC_KEY};
  const key = {
    type: 'secp256k1',
    index: '03010000000000000001',
    alias: undefined,
    wallets: [evm, {...evm, addressType: 'bitcoin-segwit'}],
  };
  const account = getWalletSigningAccount([key], ADDRESS);
  assert.doesNotThrow(() => assertWalletSigningAccount([key], account));
  key.wallets.shift();
  assert.throws(
    () => assertWalletSigningAccount([key], account),
    /no longer in Safe/,
  );
  assert.equal(getWalletSigningAccount([key], ADDRESS), undefined);
});

test('a different imported record for the same address must be resolved separately after deletion', () => {
  const first = {
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: PATH,
    publicKey: PUBLIC_KEY,
  };
  const second = {...first, path: "m/44'/60'/0'/0/8"};
  const key = {
    type: 'seed',
    index: '02400000000000000001',
    alias: undefined,
    wallets: [first, second],
  };
  const previous = getWalletSigningAccount([key], ADDRESS);
  key.wallets.shift();
  assert.throws(
    () => assertWalletSigningAccount([key], previous),
    /no longer in Safe/,
  );
  const replacement = getWalletSigningAccount([key], ADDRESS);
  assert.equal(replacement.wallet.path, second.path);
  assert.doesNotThrow(() => assertWalletSigningAccount([key], replacement));
});
