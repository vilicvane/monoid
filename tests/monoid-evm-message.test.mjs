import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  Signature,
  SigningKey,
  computeAddress,
  concat,
  getBytes,
  hashMessage,
  verifyMessage,
} from 'ethers';

const {createMonoidApplet} = await import(
  '../.bld/app/@lib/monoid/monoid-applet.js'
);
const {signEvmMessage} = await import(
  '../.bld/app/@lib/monoid/sign-evm-message.js'
);

// Public fixture: secp256k1 scalar 1, also used by the address tests.
const signingKey = new SigningKey(`0x${'1'.padStart(64, '0')}`);
const address = computeAddress(signingKey.publicKey);
const rawKey = {index: getBytes('0x04010000000000000001')};
const derivedKey = {
  index: getBytes('0x02400000000000000002'),
  seed: 'Bitcoin seed',
  curve: 'secp256k1',
  path: getBytes('0x8000002c8000003c800000000000000000000000'),
};

function message(nonce = 'fixture0') {
  return [
    'example.com wants you to sign in with your Ethereum account:',
    address,
    '',
    '登录 Monoid 👋',
    '',
    'URI: https://example.com',
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${nonce}`,
    'Issued At: 2026-10-15T00:00:00.000Z',
  ].join('\n');
}

function plainSignature(signature) {
  return getBytes(concat([signature.r, signature.s]));
}

function createApplet() {
  return {
    viewKey: async () => ({
      publicKey: getBytes(signingKey.compressedPublicKey),
    }),
    sign: async ({digest}) => ({
      signature: plainSignature(signingKey.sign(digest)),
    }),
  };
}

test('the card sign command uses INS 0x41 and validates its binary response', async () => {
  const applet = createMonoidApplet(getBytes('0xf06d6f6e6f696401010000'));
  const digest = getBytes(hashMessage(message()));
  const signature = plainSignature(signingKey.sign(digest));

  for (const key of [rawKey, derivedKey]) {
    const request = {...key, cipher: 'ecdsa', digest};
    applet.sendCommand = async (ins, data) => {
      assert.equal(ins, 0x41);
      assert.deepEqual(data, request);
      return {signature};
    };

    assert.deepEqual(await applet.sign(request), {signature});
  }

  applet.sendCommand = async () => ({signature: 'not binary'});
  await assert.rejects(applet.sign({...rawKey, cipher: 'ecdsa', digest}));
});

for (const [nonce, recoveryBit, digest] of [
  [
    'fixture0',
    28,
    '0x0ddf5144cb903720135bf955c77a83fb9e06f34bfe4dfbb05f932f9b3720b622',
  ],
  [
    'fixture2',
    27,
    '0xfdaa9bf58e7ca169fbc3bd42d9ca7c53f11f2e01edbd579acb5ad2eb0d9fbb92',
  ],
]) {
  test(`signs the exact Unicode SIWE message and recovers v=${recoveryBit}`, async () => {
    const applet = createApplet();
    applet.sign = async request => {
      assert.deepEqual(request.digest, getBytes(digest));
      return {signature: plainSignature(signingKey.sign(request.digest))};
    };

    const signature = await signEvmMessage(
      applet,
      rawKey,
      message(nonce),
      address,
    );

    assert.equal(getBytes(signature).length, 65);
    assert.equal(Signature.from(signature).v, recoveryBit);
    assert.equal(verifyMessage(message(nonce), signature), address);
  });
}

test('preserves raw, seed and master references for both card operations', async () => {
  const masterKey = {
    index: getBytes('0x03400000000000000003'),
    curve: derivedKey.curve,
    path: derivedKey.path,
  };

  for (const key of [rawKey, derivedKey, masterKey]) {
    const applet = createApplet();
    const calls = [];
    applet.viewKey = async request => {
      calls.push('viewKey');
      assert.deepEqual(request, key);
      return {publicKey: getBytes(signingKey.publicKey)};
    };
    applet.sign = async request => {
      calls.push('sign');
      assert.deepEqual(request, {
        ...key,
        cipher: 'ecdsa',
        digest: getBytes(hashMessage(message())),
      });
      return {signature: plainSignature(signingKey.sign(request.digest))};
    };

    await signEvmMessage(applet, key, message(), address.toLowerCase());
    assert.deepEqual(calls, ['viewKey', 'sign']);
  }
});

test('does not sign if the card public key belongs to another account', async () => {
  const applet = createApplet();
  let signed = false;
  applet.sign = async () => {
    signed = true;
    throw new Error('Unexpected sign call');
  };

  await assert.rejects(
    signEvmMessage(
      applet,
      rawKey,
      message(),
      '0x0000000000000000000000000000000000000001',
    ),
  );
  assert.equal(signed, false);
});

test('rejects a card signature made by another key', async () => {
  const otherKey = new SigningKey(`0x${'2'.padStart(64, '0')}`);
  const applet = createApplet();
  applet.sign = async ({digest}) => ({
    signature: plainSignature(otherKey.sign(digest)),
  });

  await assert.rejects(signEvmMessage(applet, rawKey, message(), address));
});

test('rejects a signature over a changed message', async () => {
  const applet = createApplet();
  applet.sign = async () => ({
    signature: plainSignature(signingKey.sign(hashMessage(`${message()}!`))),
  });

  await assert.rejects(signEvmMessage(applet, rawKey, message(), address));
});

test('rejects card responses that are not 64-byte plain signatures', async () => {
  const valid = signingKey.sign(hashMessage(message()));

  for (const signature of [
    new Uint8Array(),
    plainSignature(valid).slice(0, 63),
    getBytes(valid.serialized),
  ]) {
    const applet = createApplet();
    applet.sign = async () => ({signature});

    await assert.rejects(signEvmMessage(applet, rawKey, message(), address));
  }
});
