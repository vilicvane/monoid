import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  SigningKey,
  TypedDataEncoder,
  computeAddress,
  concat,
  getBytes,
  hashMessage,
  verifyTypedData,
} from 'ethers';

const {signEvmDigest} = await import(
  '../.bld/app/@lib/monoid/sign-evm-digest.js'
);
const {CBORAppletError} = await import('../.bld/app/@lib/cbor-applet.js');
const {AppletNotFoundError} = await import('../.bld/app/@lib/applet.js');

// Public fixture: secp256k1 scalar 1, also used by the message signing tests.
const signingKey = new SigningKey(`0x${'1'.padStart(64, '0')}`);
const address = computeAddress(signingKey.publicKey);
const key = {type: 'secp256k1', index: getBytes('0x04010000000000000001')};

// Official Mail vector: https://eips.ethereum.org/EIPS/eip-712
const domain = {
  name: 'Ether Mail',
  version: '1',
  chainId: 1,
  verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
};
const types = {
  Person: [
    {name: 'name', type: 'string'},
    {name: 'wallet', type: 'address'},
  ],
  Mail: [
    {name: 'from', type: 'Person'},
    {name: 'to', type: 'Person'},
    {name: 'contents', type: 'string'},
  ],
};
const message = {
  from: {
    name: 'Cow',
    wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826',
  },
  to: {
    name: 'Bob',
    wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
  },
  contents: 'Hello, Bob!',
};

function createApplet(expectedDigest) {
  return {
    viewKey: async () => ({
      publicKey: getBytes(signingKey.compressedPublicKey),
    }),
    sign: async ({digest}) => {
      assert.deepEqual(digest, getBytes(expectedDigest));

      const {r, s} = signingKey.sign(digest);

      return {signature: getBytes(concat([r, s]))};
    },
  };
}

test('signs the official EIP-712 Mail digest without a personal_sign prefix', async () => {
  const digest = TypedDataEncoder.hash(domain, types, message);

  assert.equal(
    digest,
    '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2',
  );
  assert.notEqual(digest, hashMessage(getBytes(digest)));

  const signature = await signEvmDigest(
    createApplet(digest),
    key,
    digest,
    address,
  );

  assert.equal(getBytes(signature).length, 65);
  assert.equal(verifyTypedData(domain, types, message, signature), address);
});

test('signs nested structs and arrays while binding their exact values', async () => {
  const batchTypes = {
    ...types,
    Batch: [
      {name: 'messages', type: 'Mail[]'},
      {name: 'amounts', type: 'uint256[2]'},
      {name: 'attachments', type: 'bytes[][]'},
    ],
  };
  const batch = {
    messages: [message, {...message, contents: '登录 Monoid 👋'}],
    amounts: [
      '9007199254740993',
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    ],
    attachments: [['0x', '0xff00fe'], ['0x1234']],
  };
  const digest = TypedDataEncoder.hash(domain, batchTypes, batch);
  const signature = await signEvmDigest(
    createApplet(digest),
    key,
    digest,
    address,
  );

  assert.equal(verifyTypedData(domain, batchTypes, batch, signature), address);
  assert.notEqual(
    verifyTypedData(
      domain,
      batchTypes,
      {...batch, messages: [...batch.messages].reverse()},
      signature,
    ),
    address,
  );
  assert.notEqual(
    verifyTypedData({...domain, chainId: 137}, batchTypes, batch, signature),
    address,
  );
});

test('rejects a digest that is not 32 bytes before accessing the card', async () => {
  const applet = {
    viewKey: async () => assert.fail('Unexpected card access'),
  };

  for (const digest of ['0x', `0x${'00'.repeat(31)}`, `0x${'00'.repeat(33)}`]) {
    await assert.rejects(
      signEvmDigest(applet, key, digest, address),
      /Invalid EVM digest length/,
    );
  }
});

test('explains a missing card key during lookup or signing and allows another card attempt', async () => {
  const digest = TypedDataEncoder.hash(domain, types, message);

  for (const operation of ['viewKey', 'sign']) {
    const applet = createApplet(digest);
    const original = applet[operation];
    const cause = new CBORAppletError({code: 'NOT_FOUND'});
    applet[operation] = async () => {
      throw cause;
    };
    if (operation === 'viewKey') {
      applet.sign = async () => assert.fail('Cannot sign without the key');
    }

    await assert.rejects(
      signEvmDigest(applet, key, digest, address),
      error =>
        error.message === 'Account not on this card.' && error.cause === cause,
    );

    applet[operation] = original;
    applet.sign = createApplet(digest).sign;
    const signature = await signEvmDigest(applet, key, digest, address);
    assert.equal(verifyTypedData(domain, types, message, signature), address);
  }
});

test('preserves other protocol, applet-selection and transport errors during signing', async () => {
  const digest = TypedDataEncoder.hash(domain, types, message);
  for (const operation of ['viewKey', 'sign']) {
    for (const error of [
      new CBORAppletError({code: 'UNAUTHORIZED'}),
      new AppletNotFoundError(new Uint8Array()),
      Object.assign(new Error('Tag lost'), {code: 'TAG_LOST'}),
      new Error('NOT_FOUND'),
    ]) {
      const applet = createApplet(digest);
      applet[operation] = async () => {
        throw error;
      };
      await assert.rejects(
        signEvmDigest(applet, key, digest, address),
        caught => caught === error,
      );
    }
  }
});
